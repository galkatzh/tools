"""
Export SCNet source separation model to ONNX format.

This script:
  1. Downloads the pretrained SCNet-PyTorch checkpoint
  2. Builds the model architecture
  3. Wraps it to accept/return spectrograms (STFT/iSTFT handled in browser JS)
  4. Exports to ONNX with dynamic time axis

Usage:
    pip install torch torchaudio onnx
    python export_onnx.py [--output scnet.onnx] [--checkpoint path/to/ckpt]

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
        self.sd = SDlayer(channels_in, channels_out, band_configs)
        self.conv_modules = nn.ModuleList([
            ConvolutionModule(channels_out, depth, **conv_config) for depth in depths
        ])
        self.globalconv = nn.Conv2d(channels_out, channels_out, kernel_size, 1, (kernel_size - 1) // 2)

    def forward(self, x):
        bands, original_lengths = self.sd(x)
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
    """Converts between time and frequency domain within the separation net."""
    def __init__(self, channels, inverse):
        super().__init__()
        self.inverse = inverse
        self.channels = channels

    def forward(self, x):
        if self.inverse:
            x = x.float()
            x_r = x[:, :self.channels // 2, :, :]
            x_i = x[:, self.channels // 2:, :, :]
            x = torch.complex(x_r, x_i)
            x = torch.fft.irfft(x, dim=3, norm="ortho")
        else:
            x = x.float()
            x = torch.fft.rfft(x, dim=3, norm="ortho")
            x = torch.cat([x.real, x.imag], dim=1)
        return x


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
        n = self.dims[0]  # 4
        x = x.view(B, n, -1, Fr, T)        # (B, 4, S, Fr, T)
        x = x.permute(0, 2, 1, 3, 4)       # (B, S, 4, Fr, T)
        x = x * std.unsqueeze(1) + mean.unsqueeze(1)
        return x


# ── Export logic ───────────────────────────────────────────────────────────

def load_official_checkpoint(path):
    """Load checkpoint from the official SCNet repo format."""
    ckpt = torch.load(path, map_location='cpu', weights_only=False)
    # Official repo saves entire model state or {'state': ..., 'optimizer': ...}
    if isinstance(ckpt, dict):
        if 'state' in ckpt:
            return ckpt['state']
        if 'model_state_dict' in ckpt:
            return ckpt['model_state_dict']
        if 'state_dict' in ckpt:
            return ckpt['state_dict']
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


def main():
    parser = argparse.ArgumentParser(description="Export SCNet to ONNX")
    parser.add_argument('--checkpoint', type=str, default=None,
                        help='Path to pretrained checkpoint (.th or .pth)')
    parser.add_argument('--output', type=str, default='scnet.onnx',
                        help='Output ONNX file path')
    parser.add_argument('--opset', type=int, default=17,
                        help='ONNX opset version (17+ for DFT support)')
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
    print()
    print("Next steps:")
    print("  1. Upload to HuggingFace:")
    print(f"     huggingface-cli upload your-username/scnet-onnx {args.output}")
    print("  2. Update MODEL_URL in audio-splitter/app.js with the HuggingFace URL")


if __name__ == '__main__':
    main()
