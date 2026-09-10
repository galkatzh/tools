"""Dynamic-range int8 weights for selected op types only.
usage: quantize_ops.py in.tflite out.tflite FULLY_CONNECTED,CONV_2D,..."""
import sys, time
from ai_edge_quantizer import quantizer
from ai_edge_quantizer.qtyping import TFLOperationName
src, dst, ops = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
t0 = time.time()
qt = quantizer.Quantizer(src)
for op in ops:
    qt.add_dynamic_config('.*', getattr(TFLOperationName, op), 8)
qt.quantize().export_model(dst)
print('quantized %s in %.0fs -> %s' % (ops, time.time() - t0, dst))
