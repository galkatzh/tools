# SAME-L ONNX (stable-audio-3-medium autoencoder)

ONNX export of the **SAME** (Semantic-Acoustic) autoencoder from
[stabilityai/stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium),
quantized to int4 (MatMulNBits, block 32, symmetric) for in-browser inference
with onnxruntime-web (WASM/WebGPU).

| Graph | I/O | Files |
|---|---|---|
| encoder | `audio (1, 2, 4096·L) f32 → latent (1, 256, L) f32` | `same_l_encoder_q4.onnx.00 … .10` |
| decoder | `latent (1, 256, L) f32 → audio (1, 2, 4096·L) f32` | `same_l_decoder_q4.onnx.00 … .10` |

Length `L` is dynamic. Stereo 44.1 kHz; 256-dim latents at 44100/4096 ≈ 10.77 Hz
(softnorm-bottleneck space, the same space the SA3 DiT diffuses in).
Each `.onnx` is split into 24 MiB byte chunks to fit Cloudflare Pages'
25 MiB per-file limit — concatenate `.00 + .01 + … + .10` to get the original file:

- `encoder_q4.onnx` sha256 `aab30dff9bac9fbee39970c2657857026173ff227b5fcbfc35e6864edda53f2f`
- `decoder_q4.onnx` sha256 `3f11f81eab3afb7f4bf0457b581a13051e4b00f67325473923c3831e681b8cdf`

## Conversion & verification

- Inference-only PyTorch port of the official reference implementation
  ([Stability-AI/stable-audio-3](https://github.com/Stability-AI/stable-audio-3),
  `optimized/mlx/models/defs/same_l_*.py` semantics: no mask noise, no
  bottleneck noise regularization), with sliding-window attention expressed as
  static 17×51 grouped blocks so the graph stays dynamic-length.
- Weights extracted from the `pretransform.model.*` tensors of the
  `stable-audio-3-medium` checkpoint (weight-norm collapsed). Note: this is the
  checkpoint's own decoder, not the separately-tuned decoder shipped in
  `stable-audio-3-optimized/MLX`.
- Verified against the original `stable_audio_3` PyTorch implementation:
  encode max |diff| 5.1e-6, decode max |diff| 2.0e-5 (corr 1.0000).
- fp32 ONNX verified against PyTorch at L ∈ {1, 2, 9, 27}: rel err ≤ 3.9e-4.
- Round-trip on a 12 s music-like test signal: fp32 corr 0.992 (this is a
  perceptual codec, not a waveform-exact one), int4 corr 0.989
  (20.3 dB SNR vs the fp32 reconstruction).

## License

Derived from Stable Audio 3 Medium weights; subject to the
[Stability AI Community License](https://huggingface.co/stabilityai/stable-audio-3-medium/blob/main/LICENSE.md).
