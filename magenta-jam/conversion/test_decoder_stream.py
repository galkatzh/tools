"""Parity: DecoderStream (chunked, explicit state) vs reference decode_streaming."""
import numpy as np
import torch
from common import load_model
from decoder_stream import DecoderStream, init_states, ROWS_PER_FRAME
import mrt2port.spectrostream as S

m = load_model()
N = 4
ds = DecoderStream(m.codec, m.quant, N).eval()
states = init_states(m.codec, N)
print('states:', [(k, tuple(s.shape)) for k, s in zip(ds.keys, states)][:6], '...', len(states))
rng = np.random.RandomState(0)
codes = torch.from_numpy(rng.randint(0, 1024, size=(1, 3 * N, 12)).astype(np.int32))
with torch.no_grad():
    # reference: streaming with the port's own state handling (includes warm trim + tail)
    ref_state = {}
    ref = torch.cat([m.codec.decode_streaming(S.codes_to_embeddings(codes[:, i:i + N].long(), m.quant), ref_state)
                     for i in range(0, 3 * N, N)], dim=1)[0].numpy()        # [samples, 2]
    # ours: frames + host-side overlap-add
    tail = np.zeros((2, S.FRAME_STEP), np.float32)
    out = []
    first = True
    for i in range(0, 3 * N, N):
        fr, *states = ds(codes[:, i:i + N], *states)
        fr = fr[0].numpy()                                                   # [2, 4N, 960]
        rows = range(ROWS_PER_FRAME * S.DECODER_LOOKAHEAD if first else 0, fr.shape[1])
        first = False
        for r in rows:
            out.append(tail + fr[:, r, :S.FRAME_STEP]); tail = fr[:, r, S.FRAME_STEP:]
out = np.concatenate(out, axis=1).T
print('ref', ref.shape, 'ours', out.shape, 'max|diff|', np.abs(ref - out).max(), 'peak', np.abs(ref).max())
assert ref.shape == out.shape and np.abs(ref - out).max() < 1e-4
print('DECODER PARITY OK')
