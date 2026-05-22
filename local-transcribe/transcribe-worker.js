/**
 * Module Web Worker: loads a Transformers.js ASR model and transcribes audio chunks.
 *
 * Messages in:
 *   { type: 'init', model: { repo, apiType, dtype, device } }
 *     apiType 'nemo-tdt' instead carries { encoder, decoder, preproc: ArrayBuffer, vocab, blankIdx, vocabSize }
 *   { type: 'transcribe', chunkIdx, audio: ArrayBuffer }
 *
 * Messages out:
 *   { type: 'load-progress', status, file?, progress?, loaded?, total? }
 *   { type: 'ready' }
 *   { type: 'result', chunkIdx, text }
 *   { type: 'error', chunkIdx?, message }
 */

const TFJS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.mjs';
const ORT_WASM_PATHS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

let transcriber = null;   // pipeline instance (Whisper / Moonshine)
let voxtralModel = null;  // VoxtralForConditionalGeneration
let voxtralProc = null;   // VoxtralProcessor
let parakeet = null;      // Parakeet TDT: { ort, preproc, encoder, decoder, vocab, blankIdx, vocabSize }
let config = null;

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'init') {
    try {
      config = msg.model;
      const cb = (p) => self.postMessage({ type: 'load-progress', ...p });

      /** Pick device: prefer requested, fall back to wasm. */
      const hasWebGPU = !!navigator.gpu;
      const device = config.device === 'webgpu' && hasWebGPU ? 'webgpu' : 'wasm';
      if (config.device === 'webgpu' && !hasWebGPU) {
        console.warn('[worker] WebGPU unavailable, falling back to WASM');
      }

      const tfjs = config.apiType === 'nemo-tdt' ? null : await import(TFJS_CDN);

      if (config.apiType === 'pipeline') {
        transcriber = await tfjs.pipeline(
          'automatic-speech-recognition',
          config.repo,
          { dtype: config.dtype, device, progress_callback: cb },
        );
      } else if (config.apiType === 'voxtral') {
        voxtralProc = await tfjs.AutoProcessor.from_pretrained(config.repo, {
          progress_callback: cb,
        });
        voxtralModel = await tfjs.AutoModelForSpeechSeq2Seq.from_pretrained(config.repo, {
          dtype: config.dtype,
          device,
          progress_callback: cb,
        });
      } else if (config.apiType === 'nemo-tdt') {
        await initParakeet(config);
      }

      self.postMessage({ type: 'ready' });
    } catch (err) {
      console.error('[worker] init failed:', err);
      self.postMessage({ type: 'error', message: err.message });
    }
    return;
  }

  if (msg.type === 'transcribe') {
    try {
      const audio = new Float32Array(msg.audio);
      let result;

      if (config.apiType === 'pipeline') {
        const opts = {};
        if (msg.returnTimestamps) opts.return_timestamps = msg.returnTimestamps;
        if (msg.language) opts.language = msg.language;
        result = await transcriber(audio, opts);
      } else if (config.apiType === 'voxtral') {
        result = { text: await transcribeVoxtral(audio) };
      } else if (config.apiType === 'nemo-tdt') {
        result = { chunks: await transcribeParakeet(audio) };
      }

      self.postMessage({ type: 'result', chunkIdx: msg.chunkIdx, result });
    } catch (err) {
      console.error('[worker] transcribe failed:', err);
      self.postMessage({ type: 'error', chunkIdx: msg.chunkIdx, message: err.message });
    }
  }
};

/**
 * Transcribe audio using a Voxtral-style conditional generation model.
 * Constructs a chat template with [TRANSCRIBE] instruction, processes audio,
 * and generates text via the model.
 */
async function transcribeVoxtral(audio) {
  const tfjs = await import(TFJS_CDN);

  const conversation = [{
    role: 'user',
    content: [
      { type: 'audio' },
      { type: 'text', text: '[TRANSCRIBE]' },
    ],
  }];
  const chatText = voxtralProc.apply_chat_template(conversation, { tokenize: false });
  const inputs = await voxtralProc(chatText, audio, { sampling_rate: 16000 });
  const ids = await voxtralModel.generate({
    ...inputs,
    max_new_tokens: 1024,
    temperature: 0.0,
  });

  /* Decode only the newly generated tokens (skip the input prompt). */
  const inputLen = inputs.input_ids.dims.at(-1);
  const newIds = ids.slice(null, [inputLen, null]);
  return voxtralProc.tokenizer.batch_decode(newIds, { skip_special_tokens: true })[0];
}

// ── Parakeet TDT (NeMo Conformer) via ONNX Runtime ──────────────────────────

/**
 * Load the three Parakeet ONNX models (preprocessor, FastConformer encoder,
 * TDT decoder+joint) from the ArrayBuffers supplied in the init message.
 */
async function initParakeet(cfg) {
  const ort = await import(ORT_CDN);
  ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
  // Multi-threaded WASM needs cross-origin isolation (SharedArrayBuffer);
  // ort falls back to single-threaded automatically otherwise.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? (navigator.hardwareConcurrency || 4) : 1;
  ort.env.wasm.proxy = false;

  const opts = { executionProviders: ['wasm'] };
  // Create sessions sequentially — the int8 encoder is ~650 MB.
  const preproc = await ort.InferenceSession.create(cfg.preproc, opts);
  const encoder = await ort.InferenceSession.create(cfg.encoder, opts);
  const decoder = await ort.InferenceSession.create(cfg.decoder, opts);
  parakeet = {
    ort, preproc, encoder, decoder,
    vocab: cfg.vocab, blankIdx: cfg.blankIdx, vocabSize: cfg.vocabSize,
  };
}

/**
 * Transcribe one 16 kHz mono audio chunk with Parakeet TDT v3.
 *
 * Pipeline: waveform → log-mel features (nemo128) → FastConformer encoder
 * → greedy Token-and-Duration Transducer decoding. The joint output packs
 * token logits (first vocabSize values) followed by duration logits; the
 * duration argmax tells how many encoder frames to skip.
 *
 * Returns word objects { text, timestamp: [startSec, endSec] } with
 * chunk-relative timestamps.
 */
async function transcribeParakeet(audio) {
  const { ort, preproc, encoder, decoder, vocab, blankIdx, vocabSize } = parakeet;
  const N = audio.length;

  // 1. Preprocessor: waveform → log-mel features [1, 128, T]
  const preOut = await preproc.run({
    waveforms: new ort.Tensor('float32', audio, [1, N]),
    waveforms_lens: new ort.Tensor('int64', BigInt64Array.from([BigInt(N)]), [1]),
  });

  // 2. Encoder: features → [1, 1024, T'] + subsampled frame count
  const encOut = await encoder.run({
    audio_signal: preOut.features,
    length: preOut.features_lens,
  });
  const encData = encOut.outputs.data;
  const D = encOut.outputs.dims[1];           // 1024 encoder channels
  const Tenc = encOut.outputs.dims[2];
  const encLen = Math.min(Number(encOut.encoded_lengths.data[0]), Tenc);

  // 3. Greedy TDT decoding. The decoder_joint LSTM state is [2, 1, 640].
  const stateShape = [2, 1, 640];
  let state1 = new ort.Tensor('float32', new Float32Array(2 * 640), stateShape);
  let state2 = new ort.Tensor('float32', new Float32Array(2 * 640), stateShape);

  const MAX_TOKENS_PER_STEP = 10;
  const tokens = [];
  const tokenFrames = [];
  const frame = new Float32Array(D);
  let t = 0;
  let emitted = 0;

  while (t < encLen) {
    for (let d = 0; d < D; d++) frame[d] = encData[d * Tenc + t];
    const lastToken = tokens.length ? tokens[tokens.length - 1] : blankIdx;

    const out = await decoder.run({
      encoder_outputs: new ort.Tensor('float32', frame.slice(), [1, D, 1]),
      targets: new ort.Tensor('int64', BigInt64Array.from([BigInt(lastToken)]), [1, 1]),
      target_length: new ort.Tensor('int64', BigInt64Array.from([1n]), [1]),
      input_states_1: state1,
      input_states_2: state2,
    });
    const logits = out.outputs.data;

    let token = 0;
    let bestTok = -Infinity;
    for (let i = 0; i < vocabSize; i++) {
      if (logits[i] > bestTok) { bestTok = logits[i]; token = i; }
    }
    let step = 0;
    let bestDur = -Infinity;
    for (let i = vocabSize; i < logits.length; i++) {
      if (logits[i] > bestDur) { bestDur = logits[i]; step = i - vocabSize; }
    }

    if (token !== blankIdx) {
      state1 = out.output_states_1;
      state2 = out.output_states_2;
      tokens.push(token);
      tokenFrames.push(t);
      emitted++;
    }
    if (step > 0) {
      t += step;
      emitted = 0;
    } else if (token === blankIdx || emitted === MAX_TOKENS_PER_STEP) {
      t += 1;
      emitted = 0;
    }
  }

  return tokensToWords(tokens, tokenFrames, vocab);
}

/**
 * Group subword tokens into words. A token whose text starts with a space
 * (the ▁ word-boundary marker) begins a new word. Each encoder frame spans
 * subsampling_factor (8) × 10 ms = 80 ms.
 */
function tokensToWords(tokens, tokenFrames, vocab) {
  const FRAME_SEC = 0.08;
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const piece = vocab[tokens[i]];
    if (piece === undefined || piece.startsWith('<|') || piece === '<unk>' || piece === '<pad>') {
      continue;
    }
    const startSec = tokenFrames[i] * FRAME_SEC;
    if (words.length === 0 || piece.startsWith(' ')) {
      words.push({ text: piece.trimStart(), timestamp: [startSec, startSec + FRAME_SEC] });
    } else {
      const w = words[words.length - 1];
      w.text += piece;
      w.timestamp[1] = startSec + FRAME_SEC;
    }
  }
  // Extend each word's end to the next word's start for gapless highlighting.
  for (let i = 0; i < words.length - 1; i++) {
    words[i].timestamp[1] = words[i + 1].timestamp[0];
  }
  return words.filter((w) => w.text.length > 0);
}
