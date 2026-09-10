# Magenta RealTime 2 (`mrt2_small`) — LiteRT graphs

LiteRT (`.tflite`) exports of the two on-device components of
[google/magenta-realtime-2](https://huggingface.co/google/magenta-realtime-2)
that the app runs every frame. Each file is split into 24 MiB chunks (Cloudflare
Pages' per-file limit); `manifest.json` lists the chunk order, byte size and
sha256 of the reassembled file. MusicCoCa (the style-prompt encoder) is not
here: the app loads Google's official `text_encoder.tflite`,
`pretrained_vector_quantizer.tflite` and `spm.model` straight from Hugging Face.

| Graph | What it does | Weights | Size |
|---|---|---|---|
| `temporal.tflite.*` | Conditioning encoder + the 12-layer temporal transformer for one 40 ms frame (41-frame sliding KV window, attention sink folded in as KV slot 0) | int8 dynamic-range on fully-connected layers, fp32 embeddings | 225 MB |
| `depth.tflite.*` | The 12 unrolled depth-transformer levels with in-graph top-k / gumbel-max sampling; also returns the mean code embedding the next frame's temporal step needs | int8 dynamic-range on fully-connected layers, fp32 embedding | 76 MB |
| `decoder.tflite.*` | SpectroStream decoder for 4 codec frames (160 ms) with explicit streaming conv state, ending in the inverse STFT as a matmul | fp32 | 159 MB |
| `sos.json` | Temporal input for the very first frame (mean embedding of the all-SOS frame) | | 4 KB |

The LLM is split in two because LiteRT.js's WebGPU compiler aborts on the fused
graph (each half compiles and runs fully on the GPU).

## I/O

`temporal` — inputs `args_0..args_6`: cond `[1,144] int32` (12 style + 128 note +
1 drum + 3 CFG tokens, each +7), previous frame's mean code embedding
`[1,1,1024] f32` (start with `sos.json`), frame index `[1] int32`, self K/V and
cross K/V windows `[12,8,42,128] f32` ×4. Outputs: temporal output `[1,1,1024]`
and the four updated windows.

`depth` — inputs: temporal output `[1,1,1024]`, gumbel noise `[12,1024] f32`,
temperature `[1] f32`, top-k `[1] int32`. Outputs: codes `[1,12] int32`
(unique-scheme ids: `6 + level*1024 + code`) and the next frame's mean code
embedding `[1,1,1024]`.

`decoder` — inputs: codes `[1,4,12] int32` (raw 0..1023) and 30 conv-context
tensors; outputs: inverse-STFT windows `[1,2,16,960] f32` (overlap-add with hop
480 on the host; the first 4 rows of a stream are decoder warm-up) and the 30
updated contexts.

## Provenance and verification

Converted from the token-exact PyTorch port
[magenta-community/magenta-realtime-2-small](https://huggingface.co/magenta-community/magenta-realtime-2-small)
with `litert-torch` 0.9.4 and `ai-edge-quantizer` (scripts in `../conversion/`).

- LLM fp32 graph vs PyTorch: identical sampled codes over 60 frames with shared
  noise (the port's functional step attends one extra key once its window is
  full; the export follows sequence_layers' 41-key buffer, verified against the
  library source).
- LLM int8: about 65-70 % of sampled codes identical to fp32 under teacher
  forcing with identical noise (sampling at temperature 1.3 amplifies small
  logit changes; Google's own Mac build ships 8-bit and 4-bit weights).
- Decoder: fp32 graph within 6e-6 of PyTorch (fp16/int8 variants were rejected:
  LiteRT.js's GPU delegate does not run DEQUANTIZE or constant-only CAST, and int8
  convs lost 90 dB of SNR).
- All three graphs compile fully for WebGPU in LiteRT.js 2.5.3 (no CPU fallback
  ops): the LLM in fp16, the decoder in fp32. Teacher-forced greedy agreement of
  the int8 graphs with the fp32 reference is 92 % (CPU) / 95 % (GPU fp16) at RVQ
  level 0, falling to roughly 40-50 % at the finest levels; the temporal output's
  relative error is about 3 % on both backends (int8 weights).

Weights © Google DeepMind, CC-BY-4.0; see the model card for the terms of use.
