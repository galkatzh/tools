"""Decoder .tflite (interpreter) vs eager DecoderStream on random codes: max diff + SNR."""
import sys, time, numpy as np, torch
from ai_edge_litert.interpreter import Interpreter
from common import load_model
from decoder_stream import DecoderStream, init_states
path = sys.argv[1]
m = load_model()
it = Interpreter(model_path=path, num_threads=4); it.allocate_tensors()
ins = it.get_input_details(); outs = it.get_output_details()
N = ins[0]['shape'][1]
ds = DecoderStream(m.codec, m.quant, N).eval()
ops = {}
for o in it._get_ops_details(): ops[o['op_name']] = ops.get(o['op_name'], 0) + 1
print('ops:', ops)
rng = np.random.RandomState(1)
tstate = init_states(m.codec, N)
state = [np.zeros(d['shape'], np.float32) for d in ins[1:]]
ref_all, out_all, times = [], [], []
with torch.no_grad():
    for c in range(4):
        cc = rng.randint(0, 1024, size=(1, N, 12)).astype(np.int32)
        fr, *tstate = ds(torch.from_numpy(cc), *tstate)
        it.set_tensor(ins[0]['index'], cc)
        for d, s in zip(ins[1:], state): it.set_tensor(d['index'], s)
        t0 = time.time(); it.invoke(); times.append(time.time() - t0)
        res = [it.get_tensor(d['index']) for d in outs]
        out = [r for r in res if r.shape[-1] == 960][0]; state = [r for r in res if r.shape[-1] != 960]
        ref_all.append(fr.numpy().reshape(-1)); out_all.append(out.reshape(-1))
ref = np.concatenate(ref_all); out = np.concatenate(out_all)
snr = 10 * np.log10((ref ** 2).sum() / ((ref - out) ** 2).sum())
print('%s: %.0f ms/chunk of %d frames (4 threads); max|diff| %.2e peak %.3f SNR %.1f dB' % (path, np.mean(times[1:]) * 1000, N, np.abs(ref - out).max(), np.abs(ref).max(), snr))
