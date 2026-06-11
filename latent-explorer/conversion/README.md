# SAME-L → ONNX conversion scripts

The Python scripts that produced `../models/same_l_{encoder,decoder}_q4.onnx.*`.
They are not part of the web app — kept for provenance and reproducibility.

Pipeline (CPU-only, ~16 GB RAM, ~12 GB disk):

1. **Fetch weights** — the autoencoder tensors (`pretransform.model.*`) are one
   contiguous 3.4 GB block inside `model.safetensors` of
   `stabilityai/stable-audio-3-medium` (gated; byte-identical ungated mirrors
   exist). A single HTTP range request fetches just that block; the safetensors
   JSON header supplies per-tensor offsets/shapes.
2. **`same_pt.py`** — inference-only PyTorch port of the SAME-L architecture
   (per the official MLX reference in `Stability-AI/stable-audio-3`,
   `optimized/mlx/models/defs/`), written with ONNX-friendly ops: the ±17-token
   sliding-window attention becomes static 17×51 grouped blocks via
   pad+reshape+concat, so the exported graph stays dynamic-length.
3. **`extract_ckpt.py`** — maps checkpoint keys to the port's naming and
   collapses `weight_norm` (`w = g · v/‖v‖`).
4. **`verify_vs_original.py`** — ground truth check against the original
   `stable_audio_3` implementation loaded with the same checkpoint:
   encode max |diff| 5.1e-6, decode max |diff| 2.0e-5.
5. **`export_onnx.py`** — `torch.onnx.export(dynamo=True)`, opset 18, with a
   derived dynamic dim (`audio length = 4096·L`). Verified vs PyTorch at
   L ∈ {1, 2, 9, 27}: rel err ≤ 3.9e-4.
6. **`quantize_eval.py`** — int4 weight quantization (MatMulNBits, block 32,
   symmetric, accuracy_level 4; 1.7 GB → 269 MB per graph) and round-trip
   evaluation on a synthesized music clip: fp32 corr 0.992 vs input,
   int4 20.3 dB SNR vs the fp32 reconstruction. The final in-browser check
   (encode + decode of the app's demo clip through onnxruntime-web) scored
   corr 0.998 vs the input signal.

Gotchas worth remembering:

- The checkpoint's stochastic parts (`mask_noise` on the learned tokens,
  softnorm `noise_regularize`) are inference-time no-ops in the official
  optimized implementations — drop them for a deterministic export.
- The pre-extracted npz weights in `stabilityai/stable-audio-3-optimized/MLX/`
  contain a *different* (separately tuned) decoder than the
  `stable-audio-3-medium` checkpoint — extract from the checkpoint itself.
- `torch.export` specializes shape guards: keep every internal reshape static
  (group size 17, window 51) and express the only dynamic dim as `4096·L`.
