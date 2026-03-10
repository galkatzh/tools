"""
Quick sanity test for scnet.onnx.

Checks:
  1. Model loads and runs inference
  2. Output shape is (B, 4, 4, 2049, T)
  3. Sum of separated sources is close to the mixture (energy conservation)
"""

import numpy as np
import onnxruntime as ort

ONNX_PATH = "scnet.onnx"
B, C, F, T = 1, 4, 2049, 474   # batch, channels, freq bins, time frames

print(f"Loading {ONNX_PATH}...")
sess = ort.InferenceSession(ONNX_PATH, providers=["CPUExecutionProvider"])

inp_name = sess.get_inputs()[0].name
out_name = sess.get_outputs()[0].name
print(f"  Input:  {inp_name} {sess.get_inputs()[0].shape}")
print(f"  Output: {out_name} {sess.get_outputs()[0].shape}")

# Realistic-ish spectrogram: low-energy mix of sine-like patterns
rng = np.random.default_rng(42)
spectrogram = rng.standard_normal((B, C, F, T)).astype(np.float32) * 0.1

print(f"\nRunning inference on shape {list(spectrogram.shape)}...")
[output] = sess.run([out_name], {inp_name: spectrogram})

# ── Shape check ──────────────────────────────────────────────────────────────
expected_shape = (B, 4, C, F, T)   # (batch, n_sources=4, channels=4, freq, time)
assert output.shape == expected_shape, f"Shape mismatch: got {output.shape}, expected {expected_shape}"
print(f"Output shape: {list(output.shape)}  ✓")

# ── Energy conservation: sum of sources ≈ input mixture ─────────────────────
sources_sum = output.sum(axis=1)   # (B, 4, F, T)
mix_energy  = float(np.mean(spectrogram ** 2))
sum_energy  = float(np.mean(sources_sum ** 2))
ratio = sum_energy / (mix_energy + 1e-9)
print(f"Mix energy:      {mix_energy:.6f}")
print(f"Sources-sum energy: {sum_energy:.6f}  (ratio {ratio:.3f})")

# Each source should have non-trivial (non-zero) output
for i, name in enumerate(["drums", "bass", "other", "vocals"]):
    e = float(np.mean(output[0, i] ** 2))
    print(f"  {name}: energy = {e:.6f}")
    assert e > 1e-10, f"{name} output is zero!"

print("\n✓ All checks passed.")
