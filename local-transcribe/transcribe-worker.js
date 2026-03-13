/**
 * Module Web Worker: loads a Transformers.js ASR model and transcribes audio chunks.
 *
 * Messages in:
 *   { type: 'init', model: { repo, apiType, dtype, device } }
 *   { type: 'transcribe', chunkIdx, audio: ArrayBuffer }
 *
 * Messages out:
 *   { type: 'load-progress', status, file?, progress?, loaded?, total? }
 *   { type: 'ready' }
 *   { type: 'result', chunkIdx, text }
 *   { type: 'error', chunkIdx?, message }
 */

const TFJS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

let transcriber = null;   // pipeline instance (Whisper / Moonshine)
let voxtralModel = null;  // VoxtralForConditionalGeneration
let voxtralProc = null;   // VoxtralProcessor
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

      const tfjs = await import(TFJS_CDN);

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
      let text;

      if (config.apiType === 'pipeline') {
        const result = await transcriber(audio);
        text = result.text;
      } else if (config.apiType === 'voxtral') {
        text = await transcribeVoxtral(audio);
      }

      self.postMessage({ type: 'result', chunkIdx: msg.chunkIdx, text: (text || '').trim() });
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
