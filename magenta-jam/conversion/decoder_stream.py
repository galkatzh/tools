"""Export-friendly streaming SpectroStream decoder.

Mirrors SpectroStreamDecoder.decode_streaming but with every conv/transpose-conv
time-context carried as explicit fixed-shape state tensors, and the inverse FFT
expressed as a matmul. Output is per-STFT-frame windows [1, 2, 4*N, 960]; the
host does the (trivial) overlap-add and the one-time 4-row lookahead trim.
"""
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from mrt2port import spectrostream as S

ROWS_PER_FRAME = 4  # STFT frames per 40 ms codec frame (hop 480 @ 48 kHz)


def _dilate2d(x, strides):
    """Zero-insert between rows/cols (export-clean: no in-place slice writes)."""
    sh, sw = strides
    b, c, h, w = x.shape
    if sh > 1:
        x = torch.cat([x.unsqueeze(3), x.new_zeros(b, c, h, sh - 1, w)], dim=3).reshape(b, c, h * sh, w)[:, :, :(h - 1) * sh + 1]
        h = x.shape[2]
    if sw > 1:
        x = torch.cat([x.unsqueeze(4), x.new_zeros(b, c, h, w, sw - 1)], dim=4).reshape(b, c, h, w * sw)[:, :, :, :(w - 1) * sw + 1]
    return x


def irfft_matrices(n=S.FFT_LENGTH, bins=481):
    k = np.arange(bins)[:, None]
    t = np.arange(n)[None, :]
    ang = 2 * np.pi * k * t / n
    w = np.full((bins, 1), 2.0); w[0] = 1.0; w[-1] = 1.0
    C = (w * np.cos(ang) / n).astype(np.float32)
    Sn = (-w * np.sin(ang) / n).astype(np.float32)
    return torch.from_numpy(C), torch.from_numpy(Sn)


class DecoderStream(nn.Module):
    def __init__(self, codec: S.SpectroStreamDecoder, quant: torch.Tensor, frames: int):
        super().__init__()
        self.codec = codec
        self.frames = frames
        self.register_buffer('quant', quant[:12].clone())          # [12,1024,256]
        C, Sn = irfft_matrices()
        self.register_buffer('C', C)
        self.register_buffer('S', Sn)
        self.register_buffer('inv_window', codec.inv_window.clone())
        self.keys = self.state_keys()

    # ---- state bookkeeping: order/shapes discovered from the reference once ----
    @staticmethod
    def state_keys():
        keys = ['ilru/a', 'ilru/b', 'd0/ct', 'd0/b']
        for g in range(S.CHANNEL_SPLITS):
            for i in range(1, len(S.RATIOS)):
                keys += [f'g{g}/d{i}/ct', f'g{g}/d{i}/b']
            keys.append(f'g{g}/out')
        return keys

    # ---- conv primitives with explicit context ----
    def _conv2d(self, x, prefix, kh, kw, ctx, strides=(1, 1)):
        pt = S._semicausal_pad(kh, strides[0])
        pf = S._sym_freq_pad(kw, strides[1])
        xc = torch.cat([ctx, x], dim=2) if pt[0] > 0 else x
        new_ctx = xc[:, :, xc.shape[2] - pt[0]:, :] if pt[0] > 0 else ctx
        xp = F.pad(xc, (pf[0], pf[1], 0, pt[1]))
        w = self.codec._g(prefix + '/conv/kernel'); b = self.codec._g(prefix + '/conv/bias')
        return F.conv2d(xp, w.permute(3, 2, 0, 1), bias=b, stride=strides), new_ctx

    def _conv_t(self, x, prefix, kh, kw, strides, ctx):
        """Transposed conv with explicit time context. Uses conv_transpose2d (a real
        TRANSPOSE_CONV, no zero-insertion): its zero-padding output equals
        dilate -> pad(k-1 both sides) -> correlate, so the semicausal/same pads
        of the reference are recovered by slicing that full output."""
        sh, sw = strides
        pt = S._transpose_pad(kh, sh, 'causal'); pf = S._transpose_pad(kw, sw, 'same')
        n_ctx = (pt[0] + sh - 1) // sh + 1
        T = x.shape[2]
        xc = torch.cat([ctx, x], dim=2)
        new_ctx = xc[:, :, xc.shape[2] - n_ctx:, :]
        w = self.codec._g(prefix + '/conv/kernel'); b = self.codec._g(prefix + '/conv/bias')
        wt = w.flip(0, 1).permute(2, 3, 0, 1)                                  # [cin,cout,kh,kw], flipped
        full = F.conv_transpose2d(xc, wt, bias=b, stride=strides)
        out = full[:, :, kh - 1 - pt[0]: full.shape[2] - (kh - 1 - pt[1]),
                   kw - 1 - pf[0]: full.shape[3] - (kw - 1 - pf[1])]
        return out[:, :, out.shape[2] - T * sh:, :], new_ctx

    def _resunit(self, x, prefix, strides, transposed, kt, st, key):
        c = self.codec
        inp = x; y = S.elu(x)
        if transposed:
            kh, kw = kt
            y, st[key + '/ct'] = self._conv_t(y, prefix + '/conv2dtranspose_%dx%d' % (kh, kw), kh, kw, strides, st[key + '/ct'])
        else:
            y, st[key + '/a'] = self._conv2d(y, prefix + '/conv2d_3x3_a', 3, 3, st[key + '/a'])
        y = S.elu(y)
        y, st[key + '/b'] = self._conv2d(y, prefix + '/conv2d_3x3', 3, 3, st[key + '/b'])
        sc = inp
        if (prefix + '/shortcut_layer/conv1x1/conv/kernel').replace('/', '__') in c.w:
            sc = c._conv1x1(sc, prefix + '/shortcut_layer/conv1x1')
        if strides != (1, 1):   # nearest-neighbour upsample == repeat_interleave, but lowers to RESIZE_NEAREST_NEIGHBOR
            sc = F.interpolate(sc, scale_factor=strides, mode='nearest')
        return y + sc

    def forward(self, codes, *states):
        """codes [1,N,12] int32 -> (frames [1,2,4N,960], *new_states)."""
        c = self.codec
        st = dict(zip(self.keys, states))
        emb = sum(F.embedding(codes[:, :, i], self.quant[i]) for i in range(12))   # [1,N,256] (GATHER, WebGPU-friendly)
        b, t, _ = emb.shape
        x = emb.permute(0, 2, 1).unsqueeze(-1)
        main = c._conv1x1(x, 'input_layer/conv1x1_first')
        sc = S.elu(c._conv1x1(x, 'input_layer/shortcut_layer/conv1x1_b1'))
        sc = c._conv1x1(sc, 'input_layer/shortcut_layer/conv1x1_b2')
        x = (main + sc).squeeze(-1).view(b, S.INPUT_BINS, S.INPUT_CHANNELS, t).permute(0, 2, 3, 1)
        x = self._resunit(x, 'input_layers_residual_unit', (1, 1), False, None, st, 'ilru')
        rev = S.RATIOS[::-1]
        x = self._resunit(x, 'decoder_0', rev[0], True, (max(3, 2 * rev[0][0]), max(3, 2 * rev[0][1])), st, 'd0')
        outs = []
        for gi, g in enumerate(torch.chunk(x, S.CHANNEL_SPLITS, dim=1)):
            h = g
            for i in range(1, len(S.RATIOS)):
                s = rev[i]
                h = self._resunit(h, f'decoder_{i}', s, True, (max(3, 2 * s[0]), max(3, 2 * s[1])), st, f'g{gi}/d{i}')
            h = S.elu(h)
            h, st[f'g{gi}/out'] = self._conv2d(h, 'output_layer/base_conv_last', 7, 7, st[f'g{gi}/out'])
            outs.append(h)
        spec = torch.cat(outs, dim=1)                                      # [1,4,4N,480]
        # inverse STFT as matmul: [c0re, c0im, c1re, c1im] -> per-channel frames
        v = F.pad(spec, (0, 1))                                             # 480 -> 481 bins (DC pad right)
        fr = torch.stack([v[:, 0] @ self.C + v[:, 1] @ self.S,
                          v[:, 2] @ self.C + v[:, 3] @ self.S], dim=1)      # [1,2,4N,960]
        fr = fr * self.inv_window
        return (fr, *[st[k] for k in self.keys])


def init_states(codec, frames):
    """Run the reference streaming decoder once to learn each context's shape."""
    st = {}
    with torch.no_grad():
        codec.decode_streaming(torch.zeros(1, frames, 256), st)
    return [torch.zeros_like(st[k]) for k in DecoderStream.state_keys()]
