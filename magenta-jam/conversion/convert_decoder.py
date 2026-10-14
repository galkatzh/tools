"""DecoderStream -> .tflite (fp32)."""
import sys
import time
import torch
import litert_torch
from common import load_model
from decoder_stream import DecoderStream, init_states

N = int(sys.argv[1]) if len(sys.argv) > 1 else 4
out = sys.argv[2] if len(sys.argv) > 2 else f'decoder{N}_fp32.tflite'
m = load_model()
ds = DecoderStream(m.codec, m.quant, N).eval()
states = init_states(m.codec, N)
sample = (torch.zeros(1, N, 12, dtype=torch.int32), *states)
t0 = time.time()
edge = litert_torch.convert(ds, sample, enable_x64=False)
print('converted in %.0fs' % (time.time() - t0))
edge.export(out)
print('wrote', out)
