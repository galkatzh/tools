"""Parity: FrameStep (export graph, eager torch) vs the port's reference step_f."""
import time
import numpy as np
import torch
from common import load_model, make_cond, noise_sampler, gumbel, STYLE_DISCO, STYLE_LOFI
from frame_step import FrameStep, zero_state

torch.manual_seed(0)
m = load_model()
dec = m.depthformer.decoder
fs = FrameStep(m.depthformer).eval()
N, T, K = 60, 1.3, 40
rng = np.random.RandomState(0)
noise = gumbel(rng, (N, 12, 1024))
# cond changes mid-stream (style + a held note) to exercise the cross-attention cache
conds = [make_cond(STYLE_DISCO) if f < 30 else make_cond(STYLE_LOFI, notes=[-1] * 60 + [3] + [-1] * 67) for f in range(N)]

# --- reference ---
with torch.no_grad():
    st = dec.init_streaming_f(1, 'cpu', torch.float32)
    samp = noise_sampler(noise, T, K)
    ref = []
    for f in range(N):
        src = m.depthformer.encode(torch.from_numpy(conds[f]).long().view(1, 1, -1))
        ref.append(dec.step_f(st, src, sampler=samp)[0, 0].numpy())
ref = np.stack(ref)

# --- FrameStep ---
with torch.no_grad():
    sk, sv, ck, cv = zero_state(m.depthformer.cfg)
    prev = torch.zeros(1, 12, dtype=torch.int32)
    out = []
    t0 = time.time()
    for f in range(N):
        codes, sk, sv, ck, cv = fs(torch.from_numpy(conds[f]).view(1, -1), prev, torch.tensor([f], dtype=torch.int32),
                                   sk, sv, ck, cv, torch.from_numpy(noise[f]), torch.tensor([T]), torch.tensor([K], dtype=torch.int32))
        prev = codes
        out.append(codes[0].numpy())
    print('FrameStep eager: %.1f ms/frame' % ((time.time() - t0) / N * 1000))
out = np.stack(out)
mism = (out != ref).sum(1)
print('frames with mismatching codes:', (mism > 0).sum(), '/', N, ' first mismatch frame:', np.argmax(mism > 0) if mism.any() else None)
print('ref[0]', ref[0]); print('out[0]', out[0])
# The port's step_f attends 42 past keys once its window is full (43 incl. current);
# sequence_layers keeps a 41-key buffer (42 incl. current), which FrameStep implements.
# So only frames < 42 are comparable against step_f.
assert (out[:42] == ref[:42]).all(), 'MISMATCH within the comparable range'
print('PARITY OK (frames < 42)')
np.save('ref_codes.npy', out); np.save('ref_noise.npy', noise); np.save('ref_conds.npy', np.stack(conds))
