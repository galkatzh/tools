"""SAME-L autoencoder (stable-audio-3-medium) — inference-only PyTorch port.

Faithful port of the official MLX reference implementation
(stable-audio-3/optimized/mlx/models/defs/same_l_{encoder,decoder}.py),
written with ONNX-export-friendly ops only:

  - sliding-window attention as grouped blocks (17 queries x 51 keys) built
    with pad + reshape + concat (no as_strided, no dynamic band masks)
  - differential attention batched into a single SDPA call (q/q_diff stacked
    on the head axis, then split and subtracted)
  - partial NeoX-style RoPE (first 32 of 64 head dims)

Encoder:  audio  (1, 2, N)        -> latent (1, 256, N/4096), N % 4096 == 0
Decoder:  latent (1, 256, T)      -> audio  (1, 2, T*4096)

Both graphs include the patched pretransform (patch_size=256 reshape) and the
softnorm bottleneck scaling, so the ONNX I/O is plain audio <-> latents.
"""

import math
import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

LATENT_DIM = 256
DIM = 1536
NUM_HEADS = 24
HEAD_DIM = 64
ROPE_DIMS = 32
NUM_BLOCKS = 12
FF_INNER = 4608          # ff_mult=3
SIN_START_BLOCK = 5      # decoder blocks 5..11 use sin(pi*x) FF gate
PATCH = 256              # patched pretransform: stereo -> 512 channels
STRIDE = 16              # latents per 16 patch positions
SUB = STRIDE + 1         # 17-token groups (16 audio slots + 1 latent slot)
WIN = 3 * SUB            # 51-token KV window per query group


def _band_mask():
    """Static (17, 51) additive mask: +-17-token band inside the 3-group window."""
    q = torch.arange(SUB)[:, None]
    kv = torch.arange(WIN)[None, :]
    valid = (kv >= q) & (kv <= q + 2 * SUB)
    return torch.where(valid, 0.0, -1e9).float()


class DyT(nn.Module):
    """DynamicTanh norm: gamma * tanh(alpha * x) + beta."""

    def __init__(self, dim):
        super().__init__()
        self.alpha = nn.Parameter(torch.ones(1))
        self.gamma = nn.Parameter(torch.ones(dim))
        self.beta = nn.Parameter(torch.zeros(dim))

    def forward(self, x):
        return self.gamma * torch.tanh(self.alpha * x) + self.beta


class DifferentialSWA(nn.Module):
    """Differential attention with a grouped sliding-window mask."""

    def __init__(self):
        super().__init__()
        self.to_qkv = nn.Linear(DIM, 5 * DIM, bias=False)
        self.to_out = nn.Linear(DIM, DIM, bias=False)
        self.q_norm = DyT(HEAD_DIM)
        self.k_norm = DyT(HEAD_DIM)
        inv_freq = 1.0 / (10000 ** (torch.arange(0, ROPE_DIMS, 2).float() / ROPE_DIMS))
        self.register_buffer("inv_freq", inv_freq, persistent=False)
        self.register_buffer("band", _band_mask(), persistent=False)

    def _rope(self, t, cos, sin):
        # Partial NeoX rope on the first ROPE_DIMS of each head.
        t_rot, t_pass = t[..., :ROPE_DIMS], t[..., ROPE_DIMS:]
        half = ROPE_DIMS // 2
        x1, x2 = t_rot[..., :half], t_rot[..., half:]
        rotated = torch.cat((-x2, x1), dim=-1)
        return torch.cat((t_rot * cos + rotated * sin, t_pass), dim=-1)

    def forward(self, x):
        B, T, _ = x.shape
        H, D = NUM_HEADS, HEAD_DIM
        G = T // SUB

        q1, k1, v, q2, k2 = self.to_qkv(x).chunk(5, dim=-1)
        heads = lambda t: t.reshape(B, T, H, D).transpose(1, 2)
        q1, k1, v, q2, k2 = map(heads, (q1, k1, v, q2, k2))

        q1, k1 = self.q_norm(q1), self.k_norm(k1)
        q2, k2 = self.q_norm(q2), self.k_norm(k2)

        pos = torch.arange(T, device=x.device, dtype=torch.float32)
        freqs = pos[:, None] * self.inv_freq[None, :]
        cos = torch.cat((freqs, freqs), dim=-1).cos()
        sin = torch.cat((freqs, freqs), dim=-1).sin()
        q1, k1 = self._rope(q1, cos, sin), self._rope(k1, cos, sin)
        q2, k2 = self._rope(q2, cos, sin), self._rope(k2, cos, sin)

        # Group queries: (B, 2H, G, 17, D) -> (B*G, 2H, 17, D)
        def fold_q(q):
            return q.reshape(B, H, G, SUB, D)
        Q = torch.cat((fold_q(q1), fold_q(q2)), dim=1).permute(0, 2, 1, 3, 4).reshape(B * G, 2 * H, SUB, D)

        # Window keys/values: pad one group each side, take 3 consecutive groups.
        def fold_kv(t):
            t = F.pad(t, (0, 0, SUB, SUB))                      # (B, H, T+34, D)
            blocks = t.reshape(B, H, G + 2, SUB, D)
            return torch.cat((blocks[:, :, :-2], blocks[:, :, 1:-1], blocks[:, :, 2:]), dim=-2)
        K = torch.cat((fold_kv(k1), fold_kv(k2)), dim=1).permute(0, 2, 1, 3, 4).reshape(B * G, 2 * H, WIN, D)
        V = fold_kv(v)
        V = torch.cat((V, V), dim=1).permute(0, 2, 1, 3, 4).reshape(B * G, 2 * H, WIN, D)

        # Mask: band limit + suppress the zero-padded KV groups at the edges.
        g = torch.arange(G, device=x.device)[:, None]
        w = torch.arange(WIN, device=x.device)[None, :]
        padded_pos = g * SUB + w
        boundary = torch.where((padded_pos >= SUB) & (padded_pos < T + SUB), 0.0, -1e9).float()
        mask = (self.band[None, :, :] + boundary[:, None, :]).reshape(G, 1, SUB, WIN)
        mask = mask.expand(B * G, 1, SUB, WIN) if B > 1 else mask

        out = F.scaled_dot_product_attention(Q, K, V, attn_mask=mask)
        out1, out2 = out.chunk(2, dim=1)
        out = out1 - out2                                        # (B*G, H, 17, D)
        out = out.reshape(B, G, H, SUB, D).permute(0, 2, 1, 3, 4).reshape(B, H, T, D)
        out = out.transpose(1, 2).reshape(B, T, H * D)
        return self.to_out(out)


class FeedForward(nn.Module):
    """GLU feed-forward; sin(pi*x) gate on late decoder blocks, SiLU otherwise."""

    def __init__(self, use_sin):
        super().__init__()
        self.use_sin = use_sin
        self.glu_proj = nn.Linear(DIM, FF_INNER * 2, bias=True)
        self.proj_out = nn.Linear(FF_INNER, DIM, bias=True)

    def forward(self, x):
        value, gate = self.glu_proj(x).chunk(2, dim=-1)
        gate = torch.sin(math.pi * gate) if self.use_sin else F.silu(gate)
        return self.proj_out(value * gate)


class Block(nn.Module):
    def __init__(self, use_sin):
        super().__init__()
        self.pre_norm = DyT(DIM)
        self.attn = DifferentialSWA()
        self.ff_norm = DyT(DIM)
        self.ff = FeedForward(use_sin)

    def forward(self, x):
        x = x + self.attn(self.pre_norm(x))
        x = x + self.ff(self.ff_norm(x))
        return x


class SAMELEncoder(nn.Module):
    """audio (B, 2, N) -> latent (B, 256, N/4096); requires N % 4096 == 0."""

    def __init__(self):
        super().__init__()
        self.mapping = nn.Linear(2 * PATCH, DIM, bias=True)
        self.new_tokens = nn.Parameter(torch.zeros(1, 1, DIM))
        self.blocks = nn.ModuleList(Block(False) for _ in range(NUM_BLOCKS))
        self.project_out = nn.Linear(DIM, LATENT_DIM, bias=True)
        self.scaling_factor = nn.Parameter(torch.ones(1, LATENT_DIM, 1))
        self.bias = nn.Parameter(torch.zeros(1, LATENT_DIM, 1))
        self.running_std = nn.Parameter(torch.ones(1))

    def forward(self, audio):
        B = audio.shape[0]
        n_pat = audio.shape[2] // PATCH
        t_lat = n_pat // STRIDE

        # Patched pretransform: 'b c (l h) -> b (c h) l' with h=256, then to tokens.
        x = audio.reshape(B, 2, n_pat, PATCH).permute(0, 2, 1, 3).reshape(B, n_pat, 2 * PATCH)
        x = self.mapping(x)                                       # (B, n_pat, DIM)

        # Group 16 patch tokens + 1 latent slot (new_token at the END).
        x = x.reshape(B * t_lat, STRIDE, DIM)
        nt = self.new_tokens.expand(B * t_lat, 1, DIM)
        x = torch.cat((x, nt), dim=1).reshape(B, t_lat * SUB, DIM)

        for blk in self.blocks:
            x = blk(x)

        x = x.reshape(B, t_lat, SUB, DIM)[:, :, -1, :]            # latent-slot outputs
        x = self.project_out(x).transpose(1, 2)                   # (B, 256, t_lat)

        # Softnorm bottleneck (encode direction).
        return (x * self.scaling_factor + self.bias) / self.running_std


class SAMELDecoder(nn.Module):
    """latent (B, 256, T) -> audio (B, 2, T*4096)."""

    def __init__(self):
        super().__init__()
        self.running_std = nn.Parameter(torch.ones(1))
        self.project_in = nn.Linear(LATENT_DIM, DIM, bias=True)
        self.new_tokens = nn.Parameter(torch.zeros(1, 1, DIM))
        self.blocks = nn.ModuleList(Block(i >= SIN_START_BLOCK) for i in range(NUM_BLOCKS))
        self.mapping = nn.Linear(DIM, 2 * PATCH, bias=True)

    def forward(self, latent):
        B, _, t_lat = latent.shape[0], latent.shape[1], latent.shape[2]

        x = latent * self.running_std                             # softnorm decode
        x = self.project_in(x.transpose(1, 2))                    # (B, T, DIM)

        # 1 latent token followed by 16 broadcast new_tokens per group.
        x = x.reshape(B * t_lat, 1, DIM)
        nt = self.new_tokens.expand(B * t_lat, STRIDE, DIM)
        x = torch.cat((x, nt), dim=1).reshape(B, t_lat * SUB, DIM)

        for blk in self.blocks:
            x = blk(x)

        # Drop the latent slot, keep the 16 audio slots per group.
        x = x.reshape(B, t_lat, SUB, DIM)[:, :, 1:, :].reshape(B, t_lat * STRIDE, DIM)
        x = self.mapping(x)                                       # (B, T*16, 512)

        # Un-patch: 'b l (c h) -> b c (l h)' with h=256.
        n_pat = t_lat * STRIDE
        x = x.reshape(B, n_pat, 2, PATCH).permute(0, 2, 1, 3).reshape(B, 2, n_pat * PATCH)
        return x


def load_npz(model, path):
    """Load the official MLX-extracted npz weights; fail on any mismatch."""
    z = np.load(path)
    state = {}
    for k in z.files:
        t = torch.from_numpy(z[k])
        if k == "mapping.weight" and t.ndim == 3:                # Conv1d k=1 -> Linear
            t = t.reshape(t.shape[0], t.shape[1])
        state[k] = t
    result = model.load_state_dict(state, strict=False)
    missing = [k for k in result.missing_keys]
    assert not result.unexpected_keys, f"unexpected: {result.unexpected_keys}"
    assert not missing, f"missing: {missing}"
    return model
