"""TemporalStep + DepthStep -> temporal.tflite, depth.tflite, sos.json."""
import json, sys, time, torch, litert_torch
from common import load_model
from frame_step import TemporalStep, DepthStep, zero_state, sos_x

prefix = sys.argv[1] if len(sys.argv) > 1 else ''
m = load_model()
df = m.depthformer
sk, sv, ck, cv = zero_state(df.cfg)
t0 = time.time()
litert_torch.convert(TemporalStep(df).eval(), (torch.full((1, 144), 7, dtype=torch.int32), sos_x(df), torch.zeros(1, dtype=torch.int32), sk, sv, ck, cv),
                     enable_x64=False).export(prefix + 'temporal_fp32.tflite')
print('temporal converted in %.0fs' % (time.time() - t0))
t0 = time.time()
litert_torch.convert(DepthStep(df).eval(), (torch.zeros(1, 1, 1024), torch.zeros(12, 1024), torch.ones(1), torch.full((1,), 40, dtype=torch.int32)),
                     enable_x64=False).export(prefix + 'depth_fp32.tflite')
print('depth converted in %.0fs' % (time.time() - t0))
json.dump([round(v, 7) for v in sos_x(df).reshape(-1).tolist()], open(prefix + 'sos.json', 'w'))
print('wrote sos.json')
