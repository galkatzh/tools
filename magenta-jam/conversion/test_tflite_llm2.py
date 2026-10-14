"""Chain temporal.tflite + depth.tflite with the interpreter over the saved sequence; compare with ref_codes.npy."""
import json, sys, time, numpy as np
from ai_edge_litert.interpreter import Interpreter
tpath, dpath = sys.argv[1], sys.argv[2]
forced = len(sys.argv) > 3 and sys.argv[3] == 'forced'
ref = np.load('ref_codes.npy'); noise = np.load('ref_noise.npy'); conds = np.load('ref_conds.npy')
sos = np.array(json.load(open('sos.json')), np.float32).reshape(1, 1, 1024)
T = Interpreter(model_path=tpath, num_threads=4); T.allocate_tensors()
D = Interpreter(model_path=dpath, num_threads=4); D.allocate_tensors()
ti, to = T.get_input_details(), T.get_output_details(); di, do = D.get_input_details(), D.get_output_details()
print('temporal in:', [(d['name'][-6:], list(d['shape']), d['dtype'].__name__) for d in ti]); print('temporal out:', [(list(d['shape'])) for d in to])
print('depth in:', [(d['name'][-6:], list(d['shape']), d['dtype'].__name__) for d in di]); print('depth out:', [(list(d['shape'])) for d in do])
def run(it, ins, outs, feeds):
    for d, v in zip(ins, feeds):
        assert list(d['shape']) == list(v.shape), (d['name'], d['shape'], v.shape); it.set_tensor(d['index'], v.astype(d['dtype']))
    it.invoke(); return [it.get_tensor(d['index']) for d in outs]
state = [np.zeros(d['shape'], np.float32) for d in ti[3:7]]
x = sos; out = []; times = []
for f in range(len(ref)):
    t0 = time.time()
    t_out, *state = run(T, ti, to, [conds[f].reshape(1, 144), x, np.array([f], np.int32), *state])
    codes, x = run(D, di, do, [t_out, noise[f], np.array([1.3], np.float32), np.array([40], np.int32)])
    times.append(time.time() - t0)
    if forced:  # teacher-force: next input from the reference codes requires the table; approximate by running depth's embedding via own codes -> skip
        pass
    out.append(codes.reshape(12))
out = np.stack(out); mism = (out != ref).any(1)
print('%s+%s: %.1f ms/frame; code agreement %.3f; first mismatch: %s' % (tpath, dpath, np.mean(times[5:]) * 1000, (out == ref).mean(), np.argmax(mism) if mism.any() else 'none'))
