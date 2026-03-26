"""
Benchmark SCNet ONNX variants: original, onnxsim-simplified, and int8-quantized.

Downloads a test song, runs each model variant on it, and reports wall-clock times.

Usage:
    pip install onnx onnxruntime onnxsim numpy
    python benchmark.py [--song URL] [--model scnet.onnx]

The script expects scnet.onnx in the current directory (or --model path).
It generates scnet_sim.onnx and scnet_int8.onnx automatically if missing.
"""

import argparse
import os
import time
import urllib.request

import numpy as np
import onnx
import onnxruntime as ort
from onnxsim import simplify
from onnxruntime.quantization import quantize_dynamic, QuantType

DEFAULT_SONG = (
    'https://archive.org/download/MACINTOSHPLUS-FLORALSHOPPE_complete/'
    '01%20%E3%83%96%E3%83%BC%E3%83%88.mp3'
)

# Audio config matching the app
SAMPLE_RATE = 44100
N_FFT = 4096
HOP_LENGTH = 1024
N_FREQ = N_FFT // 2 + 1
CHUNK_SECONDS = 11
CHUNK_SAMPLES = CHUNK_SECONDS * SAMPLE_RATE


def download_song(url, dest='/tmp/benchmark_song.mp3'):
    """Download test song with progress."""
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        print(f"Using cached {dest} ({os.path.getsize(dest) / 1e6:.1f} MB)")
        return dest
    print(f"Downloading {url}...")

    def progress(count, block, total):
        if total > 0:
            print(f"\r  {count * block * 100 // total}%", end='', flush=True)

    urllib.request.urlretrieve(url, dest, reporthook=progress)
    print(f"\n  Done ({os.path.getsize(dest) / 1e6:.1f} MB)")
    return dest


def decode_audio(path):
    """Decode audio to numpy arrays using ffmpeg (avoids needing torchaudio)."""
    import subprocess
    import struct

    proc = subprocess.run(
        ['ffmpeg', '-i', path, '-ar', str(SAMPLE_RATE), '-ac', '2', '-f', 's16le', '-'],
        capture_output=True, check=True,
    )
    raw = proc.stdout
    n_samples = len(raw) // 4  # 2 channels * 2 bytes
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    left = samples[0::2]
    right = samples[1::2]
    print(f"  Decoded: {n_samples / SAMPLE_RATE:.1f}s, {n_samples} samples")
    return left, right


def make_spectrogram_chunks(left, right):
    """Compute STFT and return list of spectrogram chunks (matching app pipeline)."""
    from numpy.fft import rfft

    total = len(left)
    step = CHUNK_SAMPLES
    n_chunks = max(1, (total + step - 1) // step)
    window = np.hanning(N_FFT + 1)[:N_FFT].astype(np.float32)

    chunks = []
    for i in range(n_chunks):
        start = i * step
        end = min(start + CHUNK_SAMPLES, total)

        # Pad to chunk size
        l_chunk = np.zeros(CHUNK_SAMPLES, dtype=np.float32)
        r_chunk = np.zeros(CHUNK_SAMPLES, dtype=np.float32)
        l_chunk[:end - start] = left[start:end]
        r_chunk[:end - start] = right[start:end]

        # STFT for each channel
        n_frames = 1 + CHUNK_SAMPLES // HOP_LENGTH
        spec = np.zeros((1, 4, N_FREQ, n_frames), dtype=np.float32)
        for ch_idx, signal in enumerate([l_chunk, r_chunk]):
            # Pad for center mode
            padded = np.pad(signal, N_FFT // 2)
            for t in range(n_frames):
                frame = padded[t * HOP_LENGTH:t * HOP_LENGTH + N_FFT] * window
                ft = rfft(frame)
                # Normalize like PyTorch normalized=True
                norm = 1.0 / np.sqrt(N_FFT)
                spec[0, ch_idx * 2, :, t] = ft.real.astype(np.float32) * norm
                spec[0, ch_idx * 2 + 1, :, t] = ft.imag.astype(np.float32) * norm

        chunks.append(spec)

    return chunks


def ensure_variants(base_path):
    """Generate simplified and quantized variants if they don't exist."""
    base, ext = os.path.splitext(base_path)
    sim_path = f"{base}_sim{ext}"
    int8_path = f"{base}_int8{ext}"

    if not os.path.exists(sim_path):
        print("Generating simplified model...")
        model = onnx.load(base_path)
        sim_model, ok = simplify(model)
        if not ok:
            print("  WARNING: simplification could not be validated, using result anyway")
        onnx.save(sim_model, sim_path)
        print(f"  Saved {sim_path} ({os.path.getsize(sim_path) / 1e6:.1f} MB)")
    else:
        print(f"Using existing {sim_path}")

    if not os.path.exists(int8_path):
        print("Generating int8-quantized model...")
        quantize_dynamic(
            model_input=base_path,
            model_output=int8_path,
            weight_type=QuantType.QInt8,
        )
        print(f"  Saved {int8_path} ({os.path.getsize(int8_path) / 1e6:.1f} MB)")
    else:
        print(f"Using existing {int8_path}")

    return {
        'original': base_path,
        'simplified': sim_path,
        'int8': int8_path,
    }


def benchmark_model(model_path, chunks, label):
    """Run all chunks through a model and return total inference time."""
    print(f"\n{'─' * 50}")
    size_mb = os.path.getsize(model_path) / (1024 * 1024)
    print(f"  {label}: {model_path} ({size_mb:.1f} MB)")

    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    # Warmup with first chunk
    print(f"  Warming up...")
    sess.run([out_name], {inp_name: chunks[0]})

    # Timed run
    print(f"  Running {len(chunks)} chunks...")
    start = time.perf_counter()
    for i, chunk in enumerate(chunks):
        sess.run([out_name], {inp_name: chunk})
        print(f"\r  Chunk {i + 1}/{len(chunks)}", end='', flush=True)
    elapsed = time.perf_counter() - start
    print(f"\r  {len(chunks)} chunks in {elapsed:.1f}s ({elapsed / len(chunks):.2f}s/chunk)")
    return elapsed


def main():
    parser = argparse.ArgumentParser(description="Benchmark SCNet ONNX variants")
    parser.add_argument('--model', default='scnet.onnx', help='Path to base ONNX model')
    parser.add_argument('--song', default=DEFAULT_SONG, help='URL or path to test audio')
    args = parser.parse_args()

    if not os.path.exists(args.model):
        print(f"ERROR: {args.model} not found. Download it first:")
        print(f"  huggingface-cli download bgkb/scnet_onnx scnet.onnx --local-dir .")
        return

    # Prepare models
    variants = ensure_variants(args.model)

    # Prepare audio
    print("\n── Preparing audio ──")
    if args.song.startswith('http'):
        song_path = download_song(args.song)
    else:
        song_path = args.song
    left, right = decode_audio(song_path)
    chunks = make_spectrogram_chunks(left, right)
    duration = len(left) / SAMPLE_RATE
    print(f"  {len(chunks)} chunks from {duration:.0f}s of audio")

    # Benchmark each
    results = {}
    for label, path in variants.items():
        results[label] = benchmark_model(path, chunks, label.upper())

    # Summary
    print(f"\n{'═' * 50}")
    print(f"  RESULTS — {duration:.0f}s song, {len(chunks)} chunks")
    print(f"{'═' * 50}")
    for label, elapsed in results.items():
        size = os.path.getsize(variants[label]) / (1024 * 1024)
        ratio = elapsed / duration
        print(f"  {label:12s}  {size:5.1f} MB  {elapsed:6.1f}s  ({ratio:.2f}x realtime)")
    print()


if __name__ == '__main__':
    main()
