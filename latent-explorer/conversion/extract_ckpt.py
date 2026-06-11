"""Extract SAME-L encoder/decoder state dicts (same_pt.py naming) directly from
the stable-audio-3-medium checkpoint block, collapsing weight_norm (g, v -> w).
"""

import json
import numpy as np
import torch

BS = 5813473344
hdr = json.load(open("/tmp/st_header.json"))
blob = open("pretransform_block.bin", "rb").read()


def get(k):
    v = hdr["pretransform.model." + k]
    s, e = v["data_offsets"]
    arr = np.frombuffer(blob, np.float32, (e - s) // 4, s - BS).reshape(v["shape"])
    return torch.from_numpy(arr.copy())


def wn(prefix):
    """Collapse weight-norm conv1d k=1 into a Linear weight (out, in)."""
    g, v = get(prefix + ".weight_g"), get(prefix + ".weight_v")
    w = g * v / v.norm(dim=(1, 2), keepdim=True)
    return w.squeeze(-1)


def block_state(src, dst, i, side):
    p = f"{side}.transformers.{i}."
    out = {}
    for norm in ("pre_norm", "ff_norm"):
        for a in ("alpha", "gamma", "beta"):
            out[f"blocks.{i}.{norm}.{a}"] = get(p + f"{norm}.{a}")
    for qk in ("q_norm", "k_norm"):
        for a in ("alpha", "gamma", "beta"):
            out[f"blocks.{i}.attn.{qk}.{a}"] = get(p + f"self_attn.{qk}.{a}")
    out[f"blocks.{i}.attn.to_qkv.weight"] = get(p + "self_attn.to_qkv.weight")
    out[f"blocks.{i}.attn.to_out.weight"] = get(p + "self_attn.to_out.weight")
    out[f"blocks.{i}.ff.glu_proj.weight"] = get(p + "ff.ff.0.proj.weight")
    out[f"blocks.{i}.ff.glu_proj.bias"] = get(p + "ff.ff.0.proj.bias")
    out[f"blocks.{i}.ff.proj_out.weight"] = get(p + "ff.ff.2.weight")
    out[f"blocks.{i}.ff.proj_out.bias"] = get(p + "ff.ff.2.bias")
    return out


enc = {
    "mapping.weight": wn("encoder.layers.0.mapping"),
    "mapping.bias": get("encoder.layers.0.mapping.bias"),
    "new_tokens": get("encoder.layers.0.new_tokens"),
    "project_out.weight": get("encoder.layers.2.weight"),
    "project_out.bias": get("encoder.layers.2.bias"),
    "scaling_factor": get("bottleneck.scaling_factor"),
    "bias": get("bottleneck.bias"),
    "running_std": get("bottleneck.running_std"),
}
for i in range(12):
    enc.update(block_state(None, None, i, "encoder.layers.0"))

dec = {
    "project_in.weight": get("decoder.layers.1.weight"),
    "project_in.bias": get("decoder.layers.1.bias"),
    "new_tokens": get("decoder.layers.3.new_tokens"),
    "mapping.weight": wn("decoder.layers.3.mapping"),
    "mapping.bias": get("decoder.layers.3.mapping.bias"),
    "running_std": get("bottleneck.running_std"),
}
for i in range(12):
    dec.update(block_state(None, None, i, "decoder.layers.3"))

torch.save(enc, "encoder_state.pt")
torch.save(dec, "decoder_state.pt")
print("saved", len(enc), "encoder tensors,", len(dec), "decoder tensors")

# sanity: rope inv_freq in checkpoint should equal ours
from same_pt import DifferentialSWA
ref = get("decoder.layers.3.transformers.0.rope.inv_freq")
mine = DifferentialSWA().inv_freq
print("rope inv_freq maxdiff:", (ref - mine).abs().max().item())
