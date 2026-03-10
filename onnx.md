# ONNX Conversion Insights

Lessons learned converting SCNet (a PyTorch audio source separation model) to ONNX for browser inference.

## 1. torch.fft is not exportable — replace with DFT matrix multiplication

`torch.fft.rfft` / `torch.fft.irfft` are not supported by the legacy TorchScript ONNX exporter (opset ≤ 17). The workaround is to precompute the DFT basis matrices as buffers and replace the FFT with matrix multiplication:

```python
# Forward: x (B, C, F, T) @ W_re (T, N_freq) → (B, C, F, N_freq)
x_real = x @ self.W_re
x_imag = x @ self.W_im
```

**Critical**: match the normalization of the original `torch.fft` call exactly. PyTorch's default (`norm=None`) uses **no scaling on forward** and **1/T scaling on inverse**. Using ortho normalization (`1/sqrt(T)` on both) scales intermediate activations by ~sqrt(T) ≈ 22x, which breaks the trained model completely since the learned weights never saw those values.

```python
# Correct: match torch.fft.rfft default (norm=None)
self.register_buffer('W_re', torch.cos(angles))          # no scaling
self.register_buffer('W_im', -torch.sin(angles))

# Correct: match torch.fft.irfft default (norm=None)
w = torch.ones(N_freq, 1); w[1:-1] = 2.0
self.register_buffer('iW_re', torch.cos(angles) * w / T) # 1/T scaling
self.register_buffer('iW_im', torch.sin(angles) * w / T)
```

## 2. The DFT matrix is fixed-size — the model input must match exactly

The DFT matrix is precomputed for a fixed T (e.g. T=474 for 11s chunks at hop=1024, sr=44100). Any input with a different T will fail with a MatMul dimension mismatch at runtime.

**Fix**: ensure every chunk is padded to exactly the expected sample count before STFT. Don't try to compute even/odd frame counts with approximations — just zero-pad to `CHUNK_SAMPLES`:

```js
function padToChunkSize(signal) {
  if (signal.length === CHUNK_SAMPLES) return signal;
  const out = new Float32Array(CHUNK_SAMPLES);
  out.set(signal);
  return out;
}
```

Pass the original (pre-padding) length to iSTFT so the output is trimmed correctly.

## 3. Check checkpoint keys explicitly — strict=False hides loading failures silently

`model.load_state_dict(state, strict=False)` will silently ignore mismatched keys. If the checkpoint was saved with different attribute names, the model loads with random weights and produces plausible-looking (but useless) output.

Always verify after loading:
```python
result = model.load_state_dict(state, strict=False)
learned_missing = [k for k in result.missing_keys if 'buffer' not in k]
assert not result.unexpected_keys, result.unexpected_keys
assert not learned_missing, learned_missing
```

In this case:
- The checkpoint used `best_state` as the top-level key (not `state` / `state_dict` / `model_state_dict`)
- The SDlayer attribute was named `SDlayer` in the checkpoint but `sd` in the reimplemented code

Both caused silent failures that produced audio output (from random weights) rather than errors.

## 4. Output reshape order matters when n_sources == n_channels

The decoder outputs `(B, n_sources * C, F, T)` where the layout is **sources-first**: all C channels of source 0, then all C channels of source 1, etc.

When n_sources == C (both 4 here), an incorrect `view` + `permute` can silently produce wrong results — the shapes match but each "source" output ends up containing the same channel index from all 4 sources mixed together.

**Wrong** (sources and channels transposed):
```python
x = x.view(B, C, n_sources, F, T).permute(0, 2, 1, 3, 4)  # mixes channels across sources
```

**Correct**:
```python
x = x.view(B, n_sources, C, F, T)  # sources-first, no permute needed
```

The symptom was both output files sounding like the full mix — not silence, not noise, just identical separation. Easy to mistake for a model quality issue.

## 5. Verify separation in PyTorch before debugging ONNX or JS

When output sounds wrong, isolate layers of the stack:

1. Run PyTorch inference with `torch.fft` (no DFT matrix, no ONNX) on real audio → save WAV
2. If that sounds right, the bug is in the ONNX export or the JS STFT/iSTFT
3. If it also sounds wrong, the bug is in the model architecture or checkpoint loading

This saves hours of debugging the wrong layer.

## 6. Use the legacy TorchScript exporter, not dynamo

`torch.onnx.export(..., dynamo=True)` chokes on LSTM + dynamic shapes. Use the default (legacy) TorchScript exporter and omit the `dynamo` argument entirely. The `dynamo` kwarg itself was only added in PyTorch 2.5+, so passing it on older versions raises an error.
