"""
Export SCNet source separation model to ONNX format.

This script:
  1. Downloads the pretrained SCNet-PyTorch checkpoint
  2. Builds the model architecture
  3. Wraps it to accept/return spectrograms (STFT/iSTFT handled in browser JS)
  4. Exports to ONNX with dynamic time axis

Usage:
    pip install torch torchaudio onnx onnxsim
    python export_onnx.py [--output scnet.onnx] [--checkpoint path/to/ckpt]
    python export_onnx.py --fp16           # also export float16 model (recommended)
    python export_onnx.py --quantize-int8  # also export int8 dynamically-quantized model

The resulting .onnx file should be uploaded to HuggingFace for the web app.
"""

import argparse
import math
import sys
from collections import deque

import torch
import torch.nn as nn
import torch.nn.functional as F


# ── Model architecture (from github.com/starrytong/SCNet) ──────────────────

class Swish(nn.Module):
    def forward(self, x):
        return x * x.sigmoid()


class ConvolutionModule(nn.Module):
    """Convolution module in SD block with GLU gating and depthwise conv."""
    def __init__(self, channels, depth=2, compress=4, kernel=3):
        super().__init__()
        self.depth = abs(depth)
        hidden_size = int(channels / compress)
        self.layers = nn.ModuleList()
        for _ in range(self.depth):
            padding = kernel // 2
            layer = nn.Sequential(
                nn.GroupNorm(1, channels),
                nn.Conv1d(channels, hidden_size * 2, kernel, padding=padding),
                nn.GLU(1),
                nn.Conv1d(hidden_size, hidden_size, kernel, padding=padding, groups=hidden_size),
                nn.GroupNorm(1, hidden_size),
                Swish(),
                nn.Conv1d(hidden_size, channels, 1),
            )
            self.layers.append(layer)

    def forward(self, x):
        for layer in self.layers:
            x = x + layer(x)
        return x


class FusionLayer(nn.Module):
    """Fusion layer in the decoder with GLU gating."""
    def __init__(self, channels, kernel_size=3, stride=1, padding=1):
        super().__init__()
        self.conv = nn.Conv2d(channels * 2, channels * 2, kernel_size, stride=stride, padding=padding)

    def forward(self, x, skip=None):
        if skip is not None:
            x = x + skip
        x = x.repeat(1, 2, 1, 1)
        x = self.conv(x)
        x = F.glu(x, dim=1)
        return x


class SDlayer(nn.Module):
    """Sparse Down-sample Layer: splits spectrum into frequency bands."""
    def __init__(self, channels_in, channels_out, band_configs):
        super().__init__()
        self.convs = nn.ModuleList()
        self.strides = []
        self.kernels = []
        for config in band_configs.values():
            self.convs.append(nn.Conv2d(
                channels_in, channels_out,
                (config['kernel'], 1), (config['stride'], 1), (0, 0)
            ))
            self.strides.append(config['stride'])
            self.kernels.append(config['kernel'])
        self.SR_low = band_configs['low']['SR']
        self.SR_mid = band_configs['mid']['SR']

    def forward(self, x):
        B, C, Fr, T = x.shape
        splits = [
            (0, math.ceil(Fr * self.SR_low)),
            (math.ceil(Fr * self.SR_low), math.ceil(Fr * (self.SR_low + self.SR_mid))),
            (math.ceil(Fr * (self.SR_low + self.SR_mid)), Fr)
        ]
        outputs = []
        original_lengths = []
        for conv, stride, kernel, (start, end) in zip(self.convs, self.strides, self.kernels, splits):
            extracted = x[:, :, start:end, :]
            original_lengths.append(end - start)
            current_length = extracted.shape[2]
            if stride == 1:
                total_padding = kernel - stride
            else:
                total_padding = (stride - current_length % stride) % stride
            pad_left = total_padding // 2
            pad_right = total_padding - pad_left
            padded = F.pad(extracted, (0, 0, pad_left, pad_right))
            outputs.append(conv(padded))
        return outputs, original_lengths


class SUlayer(nn.Module):
    """Sparse Up-sample Layer in decoder."""
    def __init__(self, channels_in, channels_out, band_configs):
        super().__init__()
        self.convtrs = nn.ModuleList([
            nn.ConvTranspose2d(channels_in, channels_out, [c['kernel'], 1], [c['stride'], 1])
            for c in band_configs.values()
        ])

    def forward(self, x, lengths, origin_lengths):
        splits = [
            (0, lengths[0]),
            (lengths[0], lengths[0] + lengths[1]),
            (lengths[0] + lengths[1], None)
        ]
        outputs = []
        for idx, (convtr, (start, end)) in enumerate(zip(self.convtrs, splits)):
            out = convtr(x[:, :, start:end, :])
            current = out.shape[2]
            dist = abs(origin_lengths[idx] - current) // 2
            outputs.append(out[:, :, dist:dist + origin_lengths[idx], :])
        return torch.cat(outputs, dim=2)


class SDblock(nn.Module):
    """Sparse Down-sample block in encoder."""
    def __init__(self, channels_in, channels_out, band_configs, conv_config, depths, kernel_size=3):
        super().__init__()
        self.SDlayer = SDlayer(channels_in, channels_out, band_configs)
        self.conv_modules = nn.ModuleList([
            ConvolutionModule(channels_out, depth, **conv_config) for depth in depths
        ])
        self.globalconv = nn.Conv2d(channels_out, channels_out, kernel_size, 1, (kernel_size - 1) // 2)

    def forward(self, x):
        bands, original_lengths = self.SDlayer(x)
        bands = [
            F.gelu(
                conv(band.permute(0, 2, 1, 3).reshape(-1, band.shape[1], band.shape[3]))
                .view(band.shape[0], band.shape[2], band.shape[1], band.shape[3])
                .permute(0, 2, 1, 3)
            )
            for conv, band in zip(self.conv_modules, bands)
        ]
        lengths = [band.size(-2) for band in bands]
        full_band = torch.cat(bands, dim=2)
        skip = full_band
        output = self.globalconv(full_band)
        return output, skip, lengths, original_lengths


# ── Separation network ─────────────────────────────────────────────────────

class FeatureConversion(nn.Module):
    """Converts between time/frequency domains using DFT matrix multiplication.

    Uses explicit cos/sin matmuls instead of torch.fft, which isn't exportable to ONNX.
    Precomputes DFT matrices as buffers for the expected time dimension (t_frames=474
    corresponds to ~11s chunks at hop=1024, sr=44100).
    """
    def __init__(self, channels, inverse, t_frames=474):
        super().__init__()
        self.inverse = inverse
        self.channels = channels
        T = t_frames
        N_freq = T // 2 + 1

        if not inverse:
            # rfft DFT matrix matching torch.fft.rfft default (no normalization):
            # X[k] = Σ_n x[n]·e^{-2πikn/T}
            n = torch.arange(T).float()
            k = torch.arange(N_freq).float()
            angles = (2 * math.pi / T) * n.unsqueeze(1) * k.unsqueeze(0)  # (T, N_freq)
            self.register_buffer('W_re', torch.cos(angles))    # (T, N_freq)
            self.register_buffer('W_im', -torch.sin(angles))   # (T, N_freq)
        else:
            # irfft DFT matrix matching torch.fft.irfft default (1/T normalization):
            # x[n] = (1/T) * (X[0] + 2·Σ_{k=1}^{N/2-1} X[k]·e^{2πikn/T} + X[N/2])
            n = torch.arange(T).float()
            k = torch.arange(N_freq).float()
            angles = (2 * math.pi / T) * k.unsqueeze(1) * n.unsqueeze(0)  # (N_freq, T)
            w = torch.ones(N_freq, 1)
            w[1:-1] = 2.0
            s = w / T
            self.register_buffer('iW_re', torch.cos(angles) * s)   # (N_freq, T)
            self.register_buffer('iW_im', torch.sin(angles) * s)   # (N_freq, T)

    def forward(self, x):
        x = x.float()
        if self.inverse:
            C_half = self.channels // 2
            x_r = x[:, :C_half, :, :]  # (B, C/2, F, N_freq)
            x_i = x[:, C_half:, :, :]
            return x_r @ self.iW_re - x_i @ self.iW_im  # (B, C/2, F, T)
        else:
            x_real = x @ self.W_re  # (B, C, F, T) @ (T, N_freq) → (B, C, F, N_freq)
            x_imag = x @ self.W_im
            return torch.cat([x_real, x_imag], dim=1)  # (B, 2C, F, N_freq)


class DualPathRNN(nn.Module):
    """Dual-path RNN for sequence modeling along freq and time axes."""
    def __init__(self, d_model, expand, bidirectional=True):
        super().__init__()
        self.d_model = d_model
        self.hidden_size = d_model * expand
        self.lstm_layers = nn.ModuleList([
            nn.LSTM(d_model, self.hidden_size, num_layers=1, bidirectional=bidirectional, batch_first=True)
            for _ in range(2)
        ])
        self.linear_layers = nn.ModuleList([nn.Linear(self.hidden_size * 2, d_model) for _ in range(2)])
        self.norm_layers = nn.ModuleList([nn.GroupNorm(1, d_model) for _ in range(2)])

    def forward(self, x):
        B, C, F, T = x.shape
        # Frequency path
        original_x = x
        x = self.norm_layers[0](x)
        x = x.transpose(1, 3).contiguous().view(B * T, F, C)
        x, _ = self.lstm_layers[0](x)
        x = self.linear_layers[0](x)
        x = x.view(B, T, F, C).transpose(1, 3)
        x = x + original_x
        # Time path
        original_x = x
        x = self.norm_layers[1](x)
        x = x.transpose(1, 2).contiguous().view(B * F, C, T).transpose(1, 2)
        x, _ = self.lstm_layers[1](x)
        x = self.linear_layers[1](x)
        x = x.transpose(1, 2).contiguous().view(B, F, C, T).transpose(1, 2)
        x = x + original_x
        return x


class SeparationNet(nn.Module):
    """Alternates DualPathRNN and FeatureConversion layers."""
    def __init__(self, channels, expand=1, num_layers=6):
        super().__init__()
        self.num_layers = num_layers
        self.dp_modules = nn.ModuleList([
            DualPathRNN(channels * (2 if i % 2 == 1 else 1), expand)
            for i in range(num_layers)
        ])
        self.feature_conversion = nn.ModuleList([
            FeatureConversion(channels * 2, inverse=(i % 2 != 0))
            for i in range(num_layers)
        ])

    def forward(self, x):
        for i in range(self.num_layers):
            x = self.dp_modules[i](x)
            x = self.feature_conversion[i](x)
        return x


# ── Full SCNet (with STFT inside forward) ──────────────────────────────────

class SCNet(nn.Module):
    """Full SCNet with STFT/iSTFT for waveform→waveform separation."""
    def __init__(self, sources=None, audio_channels=2, dims=None, nfft=4096,
                 hop_size=1024, win_size=4096, normalized=True,
                 band_SR=None, band_stride=None, band_kernel=None,
                 conv_depths=None, compress=4, conv_kernel=3,
                 num_dplayer=6, expand=1):
        super().__init__()
        sources = sources or ['drums', 'bass', 'other', 'vocals']
        dims = dims or [4, 32, 64, 128]
        band_SR = band_SR or [0.175, 0.392, 0.433]
        band_stride = band_stride or [1, 4, 16]
        band_kernel = band_kernel or [3, 4, 16]
        conv_depths = conv_depths or [3, 2, 1]

        self.sources = sources
        self.audio_channels = audio_channels
        self.dims = dims
        band_keys = ['low', 'mid', 'high']
        self.band_configs = {
            band_keys[i]: {'SR': band_SR[i], 'stride': band_stride[i], 'kernel': band_kernel[i]}
            for i in range(len(band_keys))
        }
        self.hop_length = hop_size
        self.conv_config = {'compress': compress, 'kernel': conv_kernel}
        self.stft_config = {
            'n_fft': nfft, 'hop_length': hop_size,
            'win_length': win_size, 'center': True, 'normalized': normalized,
        }

        self.encoder = nn.ModuleList()
        self.decoder = nn.ModuleList()
        for index in range(len(dims) - 1):
            self.encoder.append(SDblock(
                dims[index], dims[index + 1], self.band_configs,
                self.conv_config, conv_depths
            ))
            self.decoder.insert(0, nn.Sequential(
                FusionLayer(channels=dims[index + 1]),
                SUlayer(
                    dims[index + 1],
                    dims[index] if index != 0 else dims[index] * len(sources),
                    self.band_configs,
                ),
            ))
        self.separation_net = SeparationNet(dims[-1], expand, num_dplayer)


# ── ONNX wrapper (STFT/iSTFT handled in JS) ───────────────────────────────

class SCNetCore(nn.Module):
    """
    Wrapper for ONNX export that takes pre-computed spectrograms.

    Input:  (B, 4, F, T) — [L_re, L_im, R_re, R_im] normalized STFT
    Output: (B, n_sources, 4, F, T) — separated spectrograms per source
    """
    def __init__(self, scnet):
        super().__init__()
        self.encoder = scnet.encoder
        self.separation_net = scnet.separation_net
        self.decoder = scnet.decoder
        self.dims = scnet.dims
        self.n_sources = len(scnet.sources)

    def forward(self, x):
        B, C, Fr, T = x.shape

        # Instance normalization (matching official forward pass)
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)

        # Encoder: collect skip connections and band lengths
        skips = []
        lengths_list = []
        orig_lengths_list = []
        for sd_block in self.encoder:
            x, skip, lengths, original_lengths = sd_block(x)
            skips.append(skip)
            lengths_list.append(lengths)
            orig_lengths_list.append(original_lengths)

        # Separation
        x = self.separation_net(x)

        # Decoder
        for dec in self.decoder:
            fusion_layer, su_layer = dec[0], dec[1]
            x = fusion_layer(x, skips.pop())
            x = su_layer(x, lengths_list.pop(), orig_lengths_list.pop())

        # Reshape to (B, n_sources, C=4, Fr, T) and denormalize
        # Decoder outputs sources grouped: [src0_ch0..ch3, src1_ch0..ch3, ...]
        C = self.dims[0]  # 4 (audio_channels * 2 = real+imag for L and R)
        x = x.view(B, self.n_sources, C, Fr, T)  # (B, S, 4, Fr, T)
        x = x * std.unsqueeze(1) + mean.unsqueeze(1)
        return x


# ── Export logic ───────────────────────────────────────────────────────────

def load_official_checkpoint(path):
    """Load checkpoint from the official SCNet repo format."""
    ckpt = torch.load(path, map_location='cpu', weights_only=False)
    # Official repo saves entire model state or {'state': ..., 'optimizer': ...}
    if isinstance(ckpt, dict):
        for key in ('best_state', 'state', 'model_state_dict', 'state_dict'):
            if key in ckpt:
                return ckpt[key]
    return ckpt


def download_checkpoint(url, dest):
    """Download a file with progress display."""
    import urllib.request
    print(f"Downloading checkpoint from {url}...")

    def progress(count, block, total):
        pct = count * block * 100 // total if total > 0 else 0
        print(f"\r  Progress: {pct}%", end='', flush=True)

    urllib.request.urlretrieve(url, dest, reporthook=progress)
    print("\n  Done.")
    return dest


def _topological_sort(graph):
    """Sort ONNX graph nodes so every input is produced before it's consumed."""
    available = set()
    for inp in graph.input:
        available.add(inp.name)
    for init in graph.initializer:
        available.add(init.name)

    remaining = list(graph.node)
    sorted_nodes = []
    max_iter = len(remaining) ** 2 + 1
    for _ in range(max_iter):
        if not remaining:
            break
        for i, node in enumerate(remaining):
            if all(inp == '' or inp in available for inp in node.input):
                sorted_nodes.append(node)
                for out in node.output:
                    available.add(out)
                remaining.pop(i)
                break
    sorted_nodes.extend(remaining)  # append any stragglers
    return sorted_nodes


def main():
    parser = argparse.ArgumentParser(description="Export SCNet to ONNX")
    parser.add_argument('--checkpoint', type=str, default=None,
                        help='Path to pretrained checkpoint (.th or .pth)')
    parser.add_argument('--output', type=str, default='scnet.onnx',
                        help='Output ONNX file path')
    parser.add_argument('--opset', type=int, default=18,
                        help='ONNX opset version')
    parser.add_argument('--quantize-int8', action='store_true',
                        help='Also export an int8 dynamically-quantized ONNX model')
    parser.add_argument('--fp16', action='store_true',
                        help='Also export a float16 model (half size, same inference speed)')
    args = parser.parse_args()

    # Build model
    print("Building SCNet model...")
    model = SCNet()

    # Load weights
    if args.checkpoint:
        print(f"Loading checkpoint from {args.checkpoint}...")
        state = load_official_checkpoint(args.checkpoint)
        model.load_state_dict(state, strict=False)
    else:
        print("\n⚠  No checkpoint provided. Exporting with random weights.")
        print("   For a useful model, provide a checkpoint:")
        print("     python export_onnx.py --checkpoint path/to/best_model.th")
        print()
        print("   You can get pretrained weights from:")
        print("     - https://github.com/starrytong/SCNet (official)")
        print("     - https://github.com/amanteur/SCNet-PyTorch (unofficial)")
        print()

    model.eval()

    # Wrap for spectrogram I/O
    core = SCNetCore(model)
    core.eval()

    # Create dummy input: (B=1, C=4, F=2049, T=474)
    # T=474 corresponds to ~11 seconds at hop=1024, sr=44100
    T_frames = 474
    dummy = torch.randn(1, 4, 2049, T_frames)

    print(f"Exporting to ONNX (opset {args.opset})...")
    print(f"  Input shape:  {list(dummy.shape)} [B, C=4, F=2049, T]")

    try:
        torch.onnx.export(
            core,
            dummy,
            args.output,
            opset_version=args.opset,
            input_names=['spectrogram'],
            output_names=['sources'],
            dynamic_axes={
                'spectrogram': {0: 'batch', 3: 'time'},
                'sources': {0: 'batch', 4: 'time'},
            },
        )
    except Exception as e:
        print(f"\n✗ Export failed: {e}")
        print("\nIf this is due to FFT/RFFT ops, try opset 20:")
        print(f"  python export_onnx.py --opset 20 --checkpoint {args.checkpoint or 'path/to/ckpt'}")
        sys.exit(1)

    # Verify
    import onnx
    onnx_model = onnx.load(args.output)
    onnx.checker.check_model(onnx_model)

    import os
    size_mb = os.path.getsize(args.output) / (1024 * 1024)
    print(f"\n✓ Exported: {args.output} ({size_mb:.1f} MB)")
    print(f"  Output shape: [B, {len(model.sources)}, 4, 2049, T]")
    print(f"  Sources: {model.sources}")

    # Float16 conversion (with graph optimization)
    if args.fp16:
        from onnxruntime.transformers.float16 import convert_float_to_float16
        from onnxsim import simplify

        base, ext = os.path.splitext(args.output)
        fp16_output = f"{base}_fp16{ext}"

        # Simplify graph first: fold constants, eliminate dead nodes, merge ops.
        # This halves the node count, reducing parse time and inference overhead.
        print(f"\nSimplifying graph before fp16 conversion...")
        sim_model, ok = simplify(onnx_model)
        if not ok:
            print("  WARNING: onnxsim validation failed, using simplified model anyway")
        orig_nodes = len(onnx_model.graph.node)
        sim_nodes = len(sim_model.graph.node)
        print(f"  Nodes: {orig_nodes} → {sim_nodes} ({orig_nodes - sim_nodes} removed)")

        print(f"Converting to float16...")
        fp16_model = convert_float_to_float16(sim_model, keep_io_types=True)

        # fp16 conversion can break topological sort by inserting Cast nodes
        # in arbitrary positions — re-sort to fix.
        sorted_nodes = _topological_sort(fp16_model.graph)
        del fp16_model.graph.node[:]
        fp16_model.graph.node.extend(sorted_nodes)

        onnx.save(fp16_model, fp16_output)
        fp16_size_mb = os.path.getsize(fp16_output) / (1024 * 1024)
        print(f"✓ FP16: {fp16_output} ({fp16_size_mb:.1f} MB, {fp16_size_mb/size_mb:.0%} of original, "
              f"{len(fp16_model.graph.node)} nodes)")

    # Int8 dynamic quantization
    if args.quantize_int8:
        from onnxruntime.quantization import quantize_dynamic, QuantType

        base, ext = os.path.splitext(args.output)
        q_output = f"{base}_int8{ext}"
        print(f"\nQuantizing to int8 (dynamic)...")
        quantize_dynamic(
            model_input=args.output,
            model_output=q_output,
            weight_type=QuantType.QInt8,
        )
        q_size_mb = os.path.getsize(q_output) / (1024 * 1024)
        print(f"✓ Quantized: {q_output} ({q_size_mb:.1f} MB, {q_size_mb/size_mb:.0%} of original)")

    print()
    print("Next steps:")
    print("  1. Upload to HuggingFace:")
    print(f"     huggingface-cli upload your-username/scnet-onnx {args.output}")
    print("  2. Update MODEL_URL in audio-splitter/app.js with the HuggingFace URL")


if __name__ == '__main__':
    main()
