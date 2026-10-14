"""Export-friendly single-frame step of the MRT2 Depthformer.

One graph does everything a 40 ms frame needs:
  conditioning -> encoder -> temporal transformer (windowed KV cache, sinks)
  -> 12 unrolled depth-transformer levels with in-graph top-k/gumbel sampling.

All state is explicit, fixed-shape tensors so it converts to a static .tflite:
  self_k/self_v/cross_k/cross_v : [L, H, W, D] sliding windows, newest last.
  cache_pos                     : frames generated so far (masks unfilled slots).
Sampling noise (gumbel) is an input so the host controls the RNG.

Written for LiteRT.js's WebGPU delegate: single-query attention is expressed
with MUL + SUM instead of BATCH_MATMUL (which it rejects for these shapes),
embeddings use F.embedding (GATHER) rather than indexing (GATHER_ND), and a
one-key softmax (depth level 0) is skipped since it lowers to x/x.
"""
import sys
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, '.')
from mrt2port import layers as L  # noqa: E402

NEG = -3e4   # masking value that survives fp16 (-1e9 overflows to -inf and the GPU delegate turns it into NaN)


# fp16-safe normalisation: activations reach ~600, whose squares overflow fp16
# inside the reference RMSNorm/LayerNorm. Normalising by the row's max first
# keeps every intermediate in [0, 1]; the maths is identical (eps just scales).
def rms_norm(norm, x):
    m = x.abs().amax(-1, keepdim=True)
    v = x / m
    y = v * torch.rsqrt(v.pow(2).mean(-1, keepdim=True) + norm.eps / (m * m))
    return y * norm.scale if norm.scale is not None else y


def layer_norm(norm, x):
    m = x.abs().amax(-1, keepdim=True)
    v = x / m
    mean = v.mean(-1, keepdim=True)
    var = (v - mean).pow(2).mean(-1, keepdim=True)
    return (v - mean) * torch.rsqrt(var + norm.eps / (m * m)) * norm.scale + norm.bias


def ffn(blk, x):
    """FFN block with the fp16-safe norms (same maths as layers.FFN)."""
    f = blk['ffn']
    h = f.ffn_layer2(f.ffn_layer1(rms_norm(f.pre_norm, x)))
    return x + rms_norm(f.post_norm, h)


class FrameStep(nn.Module):
    def __init__(self, df):
        super().__init__()
        self.enc = df.encoder
        self.dec = df.decoder
        cfg = df.cfg
        self.cfg = cfg
        self.W = cfg.temporal_max_past + 1      # 42: past horizon + current frame
        self.Q = cfg.num_codebooks              # 12
        self.CB = cfg.codebook_size             # 1024
        self.R = cfg.num_reserved_tokens        # 6
        self.register_buffer('slot', torch.arange(self.W, dtype=torch.int32))

    # ------------------------------------------------------------ attention
    @staticmethod
    def _attend(attn, q, kh, vh, valid=None):
        """Single-query attention. q [1,1,H,D]; kh, vh [H,T,D]; valid [T] bool or None.
        The attention sink is folded in as key/value slot 0 (its key pre-divided by
        the query scale, since sink logits use the unscaled query) so the logits
        are one MUL+SUM+SELECT+SOFTMAX chain: concatenating a sink logit column
        onto masked logits is computed wrongly by LiteRT.js's WebGPU delegate."""
        H, T, D = kh.shape
        qh = q.view(H, D)
        scale = L._query_scale_vector(attn.per_dim_scale, D, q.dtype)          # [D]
        sink_k, sink_v = attn.sink_key_embeddings, attn.sink_value_embeddings
        if T == 1 and sink_k is None:
            return vh.reshape(1, 1, H, D)                                       # softmax over one key == 1
        if sink_k is not None:
            kh = torch.cat([(sink_k / scale).view(H, 1, D), kh], dim=1)
            vh = torch.cat([sink_v.view(H, 1, D), vh], dim=1)
            if valid is not None:
                valid = torch.cat([torch.ones(1, dtype=torch.bool), valid])
        logits = ((qh * scale).unsqueeze(1) * kh).sum(-1)                      # [H,T(+1)]
        if valid is not None:
            logits = torch.where(valid.view(1, -1), logits, torch.full_like(logits, NEG))
        w = torch.softmax(logits, dim=-1)
        return (w.unsqueeze(-1) * vh).sum(1).view(1, 1, H, D)

    def _self_attn(self, sa, x, win_k, win_v, valid):
        """sa: SelfAttention module; win_k/win_v: previous windows [H,W,D] (oldest first)."""
        h = rms_norm(sa.pre_norm, x)
        a = sa.attention
        q = a.project(h, a.query_projection_kernel)
        k = a.project(h, a.key_projection_kernel).view(-1, 1, a.units_per_head)   # [H,1,D]
        v = a.project(h, a.value_projection_kernel).view(-1, 1, a.units_per_head)
        wk = torch.cat([win_k[:, 1:], k], dim=1)
        wv = torch.cat([win_v[:, 1:], v], dim=1)
        ctx = self._attend(a, q, wk, wv, valid)
        return x + rms_norm(sa.post_norm, torch.einsum('btnh,dnh->btd', ctx, sa.output_projection_kernel)), wk, wv

    def _cross_attn(self, ca, x, source, win_k, win_v, valid):
        h = rms_norm(ca.pre_norm, x)
        a = ca.attention
        q = torch.einsum('btd,dnh->btnh', h, a.query_projection_kernel)
        sk, sv = ca._kv(source)
        D = sk.shape[-1]
        wk = torch.cat([win_k[:, 1:], sk.view(-1, 1, D)], dim=1)
        wv = torch.cat([win_v[:, 1:], sv.view(-1, 1, D)], dim=1)
        ctx = self._attend(a, q, wk, wv, valid)
        return x + rms_norm(ca.post_norm, torch.einsum('btnh,dnh->btd', ctx, ca.output_projection_kernel)), wk, wv

    def _temporal(self, x, source, cache_pos, self_k, self_v, cross_k, cross_v):
        n_valid = torch.clamp(cache_pos + 1, max=self.W)                 # [1]
        valid = self.slot >= (self.W - n_valid)                          # newest slots are valid (bool [W])
        nsk, nsv, nck, ncv = [], [], [], []
        for i, blk in enumerate(self.dec.temporal_body.layers):
            x, wk, wv = self._self_attn(blk['self_attention'], x, self_k[i], self_v[i], valid)
            nsk.append(wk); nsv.append(wv)
            x, wk, wv = self._cross_attn(blk['cross_attention'], x, source, cross_k[i], cross_v[i], valid)
            nck.append(wk); ncv.append(wv)
            x = ffn(blk, x)
        return x, torch.stack(nsk), torch.stack(nsv), torch.stack(nck), torch.stack(ncv)

    def _depth_level(self, depth_in, kv):
        """One depth level. kv: per-layer (k, v) [H,T,D] lists or None. Returns logits, new kv."""
        h = self.dec.depth_input_adapter(depth_in) if self.dec.depth_input_adapter is not None else depth_in
        new_kv = []
        for i, blk in enumerate(self.dec.depth_body.layers):
            sa = blk['self_attention']
            hn = rms_norm(sa.pre_norm, h)
            a = sa.attention
            q = a.project(hn, a.query_projection_kernel)
            k = a.project(hn, a.key_projection_kernel).view(-1, 1, a.units_per_head)
            v = a.project(hn, a.value_projection_kernel).view(-1, 1, a.units_per_head)
            if kv is not None:
                k = torch.cat([kv[i][0], k], dim=1)
                v = torch.cat([kv[i][1], v], dim=1)
            new_kv.append((k, v))
            ctx = self._attend(a, q, k, v)
            h = h + rms_norm(sa.post_norm, torch.einsum('btnh,dnh->btd', ctx, sa.output_projection_kernel))
            h = ffn(blk, h)
        h = layer_norm(self.dec.final_ln, h)
        logits = self.dec.to_logits(h)
        c = self.cfg.soft_cap_logits
        return torch.tanh(logits / c) * c, new_kv

    def _sample(self, logits_slice, noise, temperature, top_k):
        """Top-k + gumbel-max over one codebook slice [1,CB] -> local id [1].
        The k-th largest logit is found by ranking (count of strictly greater
        logits) instead of sorting, so it lowers to plain TFLite ops and top_k
        can stay a runtime input. Ties are kept, like the reference's >= kth."""
        x = logits_slice.view(-1)
        rank = (x.view(1, -1) > x.view(-1, 1)).to(torch.int32).sum(dim=1)     # [CB]
        masked = torch.where(rank < top_k, x, torch.full_like(x, NEG))
        return torch.argmax(masked + noise.view(-1) * temperature).view(1)

    def _encode(self, cond):
        """EncoderEmbedding.forward with embedding lookups (GATHER) instead of
        advanced indexing (GATHER_ND, which LiteRT.js cannot run on WebGPU)."""
        e = self.enc
        m = e.m
        mulan = cond[:, :m] + e.mulan_offset.to(torch.int32)                       # [1,12]
        emb = F.embedding(mulan, e.mulan_dequantizer).sum(dim=1, keepdim=True)     # [1,1,768]
        mulan_out = e.mulan_adapter(emb)
        ridx = cond[:, m:] + e.regular_offsets.to(torch.int32)                     # [1,132]
        regular_out = F.embedding(ridx, e.regular_embedding).mean(dim=1, keepdim=True)
        return layer_norm(e.encoder_ln, (mulan_out + regular_out) / 2.0)           # [1,1,enc]

    def _embed(self, tokens):
        return F.embedding(tokens, self.dec.embedding) * self.dec.embed_scale

    def forward(self, cond, prev_codes, cache_pos, self_k, self_v, cross_k, cross_v,
                noise, temperature, top_k):
        source = self._encode(cond)                                     # [1,1,enc]
        x = self._embed(prev_codes).mean(dim=1, keepdim=True)          # [1,1,1024]
        t_out, nsk, nsv, nck, ncv = self._temporal(x, source, cache_pos, self_k, self_v, cross_k, cross_v)

        depth_in = t_out
        kv = None
        codes = []
        for q in range(self.Q):
            logits, kv = self._depth_level(depth_in, kv)
            lo = self.R + q * self.CB
            local = self._sample(logits[0, :, lo:lo + self.CB], noise[q], temperature, top_k)
            tok = local.to(torch.int32) + lo
            codes.append(tok)
            if q < self.Q - 1:
                depth_in = self._embed(tok.view(1, 1))
        return torch.stack(codes, dim=-1), nsk, nsv, nck, ncv           # codes [1,12]


def zero_state(cfg):
    td = cfg.temporal
    W = cfg.temporal_max_past + 1
    z = lambda: torch.zeros(td.num_layers, td.num_heads, W, td.dim_per_head)
    return z(), z(), z(), z()


# LiteRT.js's WebGPU compiler aborts on the fused graph (temporal + 12 depth
# levels), while each half compiles fine, so the frame is shipped as two graphs.
class TemporalStep(FrameStep):
    """cond + previous frame's mean code embedding -> temporal output + KV windows."""

    def forward(self, cond, prev_x, cache_pos, self_k, self_v, cross_k, cross_v):
        source = self._encode(cond)
        return self._temporal(prev_x, source, cache_pos, self_k, self_v, cross_k, cross_v)


class DepthStep(FrameStep):
    """temporal output -> 12 sampled codes and the next frame's mean code embedding."""

    def forward(self, t_out, noise, temperature, top_k):
        depth_in, kv, codes = t_out, None, []
        for q in range(self.Q):
            logits, kv = self._depth_level(depth_in, kv)
            lo = self.R + q * self.CB
            tok = self._sample(logits[0, :, lo:lo + self.CB], noise[q], temperature, top_k).to(torch.int32) + lo
            codes.append(tok)
            if q < self.Q - 1:
                depth_in = self._embed(tok.view(1, 1))
        codes = torch.stack(codes, dim=-1)                               # [1,12]
        return codes, self._embed(codes).mean(dim=1, keepdim=True)       # next prev_x [1,1,1024]


def sos_x(df):
    """Temporal input for the first frame: mean embedding of the all-SOS (0) frame."""
    return (F.embedding(torch.zeros(1, 12, dtype=torch.int32), df.decoder.embedding) * df.decoder.embed_scale).mean(dim=1, keepdim=True)
