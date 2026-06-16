"""Export SAME-L encoder/decoder to ONNX (dynamic length) and verify vs PyTorch.

I/O matches shoegazerstella/stable-audio-morph-onnx conventions:
  encoder.onnx:  audio  (1, 2, 4096*L) f32 -> latent (1, 256, L) f32
  decoder.onnx:  latent (1, 256, L)    f32 -> audio  (1, 2, 4096*L) f32
"""

import sys
import numpy as np
import torch
from torch.export import Dim

from same_pt import SAMELEncoder, SAMELDecoder


def load_pt(model, path):
    r = model.load_state_dict(torch.load(path), strict=False)
    assert not r.unexpected_keys and not r.missing_keys
    return model.eval()


def export(model, sample, dynamic_shapes, path, in_name, out_name):
    prog = torch.onnx.export(
        model, (sample,),
        dynamo=True,
        dynamic_shapes=dynamic_shapes,
        input_names=[in_name],
        output_names=[out_name],
        opset_version=18,
        external_data=True,
    )
    prog.optimize()
    prog.save(path)
    print("saved", path)


which = sys.argv[1]
L = Dim("L", min=1, max=8192)

if which == "encoder":
    model = load_pt(SAMELEncoder(), "encoder_state.pt")
    sample = torch.randn(1, 2, 4096 * 4)
    export(model, sample, ({2: 4096 * L},), "encoder.onnx", "audio", "latent")
else:
    model = load_pt(SAMELDecoder(), "decoder_state.pt")
    sample = torch.randn(1, 256, 4)
    export(model, sample, ({2: L},), "decoder.onnx", "latent", "audio")
