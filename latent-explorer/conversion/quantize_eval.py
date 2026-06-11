"""Quantize matmuls to int4 (MatMulNBits) and evaluate round-trip quality.

Round-trips a synthesized music-like clip (chords + melody + drums + noise)
through encoder->decoder for fp32 and q4 graphs, reporting SNR vs the input
and SNR of q4 vs the fp32 reconstruction.
"""

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

SR = 44100


def make_music(seconds=12.0):
    n = int(SR * seconds)
    n -= n % 8192
    t = np.arange(n) / SR
    out = np.zeros((2, n), np.float32)
    # chord pad (A minor -> F -> C -> G), saw-ish partials
    prog = [(220, 261.63, 329.63), (174.61, 220, 261.63), (130.81, 164.81, 196), (196, 246.94, 293.66)]
    for ci, chord in enumerate(prog):
        s, e = int(ci * n / 4), int((ci + 1) * n / 4)
        seg = t[s:e]
        for f in chord:
            for h in (1, 2, 3, 4):
                out[:, s:e] += (0.05 / h) * np.sin(2 * np.pi * f * h * seg + 0.1 * h)
    # melody, slightly different in each ear
    mel = 440 * 2 ** (np.round(np.sin(t * 2.1) * 5 + np.sin(t * 0.7) * 3) / 12)
    out[0] += 0.12 * np.sin(2 * np.pi * np.cumsum(mel) / SR)
    out[1] += 0.12 * np.sin(2 * np.pi * np.cumsum(mel * 1.001) / SR)
    # kick: 2 Hz, decaying sine sweep
    beat = (t * 2) % 1
    out += 0.5 * np.exp(-beat * 18) * np.sin(2 * np.pi * 55 * beat ** 0.7)
    # hats: noise bursts on offbeats
    rng = np.random.default_rng(0)
    noise = rng.standard_normal(n).astype(np.float32)
    hat = ((t * 4) % 1 < 0.05).astype(np.float32)
    out += 0.05 * noise * hat
    out += 0.003 * rng.standard_normal((2, n)).astype(np.float32)
    peak = np.abs(out).max()
    return (out / peak * 0.7).astype(np.float32)


def snr(ref, x):
    err = ref - x
    return 10 * np.log10((ref ** 2).sum() / max((err ** 2).sum(), 1e-12))


def roundtrip(enc_path, dec_path, audio):
    so = ort.SessionOptions()
    enc = ort.InferenceSession(enc_path, so, providers=["CPUExecutionProvider"])
    lat = enc.run(["latent"], {"audio": audio[None]})[0]
    del enc
    dec = ort.InferenceSession(dec_path, so, providers=["CPUExecutionProvider"])
    out = dec.run(["audio"], {"latent": lat})[0]
    del dec
    return lat, out[0]


if __name__ == "__main__":
    import sys
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"

    if stage in ("quant", "all"):
        for name in ("encoder", "decoder"):
            model = onnx.load(f"{name}.onnx")
            q = MatMulNBitsQuantizer(model, block_size=32, is_symmetric=True, accuracy_level=4)
            q.process()
            onnx.save_model(q.model.model, f"{name}_q4.onnx",
                            save_as_external_data=False)
            import os
            print(name, "q4 size:", os.path.getsize(f"{name}_q4.onnx") / 1e6, "MB")

    if stage in ("eval", "all"):
        audio = make_music()
        sf.write("test_in.wav", audio.T, SR)
        lat32, out32 = roundtrip("encoder.onnx", "decoder.onnx", audio)
        sf.write("test_fp32.wav", out32.T, SR)
        print(f"fp32 roundtrip: SNR vs input {snr(audio, out32):.2f} dB, "
              f"corr {np.corrcoef(audio.flatten(), out32.flatten())[0,1]:.5f}, lat std {lat32.std():.3f}")
        lat4, out4 = roundtrip("encoder_q4.onnx", "decoder_q4.onnx", audio)
        sf.write("test_q4.wav", out4.T, SR)
        print(f"q4 roundtrip:   SNR vs input {snr(audio, out4):.2f} dB, "
              f"corr {np.corrcoef(audio.flatten(), out4.flatten())[0,1]:.5f}")
        print(f"q4 vs fp32 recon: SNR {snr(out32, out4):.2f} dB, latent SNR {snr(lat32, lat4):.2f} dB")
