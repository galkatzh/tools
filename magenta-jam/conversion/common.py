"""Shared helpers: load the PyTorch reference model, build conditioning, reference sampler."""
import json
import sys

import numpy as np
import torch

sys.path.insert(0, '.')
from mrt2port.configuration_magenta_rt2 import MagentaRT2Config  # noqa: E402
from mrt2port.modeling_magenta_rt2 import MagentaRT2ForConditionalGeneration, discretize_cfg  # noqa: E402
from safetensors.torch import load_file  # noqa: E402

STYLE_DISCO = [660, 597, 668, 315, 857, 217, 930, 175, 655, 343, 534, 137]
STYLE_LOFI = [1000, 469, 528, 962, 463, 977, 993, 488, 495, 88, 850, 252]


def load_model():
    raw = json.load(open('torchport/config.json'))
    cfg = MagentaRT2Config(**{k: v for k, v in raw.items()
                              if k not in ('architectures', 'auto_map', 'transformers_version', 'dtype')})
    m = MagentaRT2ForConditionalGeneration(cfg).eval()
    missing, unexpected = m.load_state_dict(load_file('torchport/model.safetensors'), strict=False)
    assert not missing and not unexpected, (missing, unexpected)
    for p in m.parameters():
        p.requires_grad_(False)
    return m


def make_cond(style, notes=None, cfg=(3.0, 1.0, 1.0)):
    """144-vector: style[12] + notes[128] + drums[1] + cfg[3], each + 7 (int32 numpy)."""
    notes = [-1] * 128 if notes is None else list(notes)
    cfgs = [discretize_cfg(cfg[0], 0.2, 40), discretize_cfg(cfg[1], 0.2, 40), discretize_cfg(cfg[2], 1.0, 8)]
    return (np.array(list(style) + notes + [-1] + cfgs, dtype=np.int32) + 7)


def noise_sampler(noise_frames, temperature, top_k):
    """Reference-style sampler (mask range, top-k, gumbel-max) driven by explicit
    noise[frame][level] arrays so runs are reproducible across implementations."""
    counter = {'f': 0, 'q': 0}

    def sampler(logits, q, lo, hi):
        logits = logits.float()
        v = logits.shape[-1]
        idx = torch.arange(v)
        logits = torch.where((idx >= lo) & (idx < hi), logits, torch.full_like(logits, -1e9))
        kth = torch.topk(logits, top_k, dim=-1).values[..., -1:]
        logits = torch.where(logits >= kth, logits, torch.full_like(logits, -1e9))
        n = torch.zeros_like(logits)
        n[..., lo:hi] = torch.from_numpy(noise_frames[counter['f']][q])
        counter['q'] = q
        if q == 11:
            counter['f'] += 1
        return (logits + n * temperature).argmax(dim=-1)
    return sampler


def gumbel(rng, shape):
    u = rng.uniform(1e-10, 1 - 1e-7, size=shape).astype(np.float32)
    return (-np.log(-np.log(u))).astype(np.float32)
