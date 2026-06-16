"""Ground-truth check: my reimplementation vs the original stable_audio_3 code.

Loads the original AudioAutoencoder (SAMEEncoder/SAMEDecoder + softnorm +
patched pretransform) with the real medium checkpoint weights (range-fetched
from the safetensors), runs encode and decode on fixed inputs, and compares
against the outputs of same_pt.py loaded from the official npz extracts.

Stochastic parts are disabled to match official optimized inference:
mask_noise=0 (encoder/decoder) and noise_regularize=False (bottleneck).
"""

import json
import struct
import sys

import numpy as np
import torch

sys.path.insert(0, "/tmp/stable-audio-3")

# Force the deterministic eager attention fallback (no flash, no flex compile).
import stable_audio_3.models.transformer as sat
sat.flex_attention_available = False
sat.flex_attention_compiled = None

from stable_audio_3.models.autoencoders import SAMEEncoder, SAMEDecoder, AudioAutoencoder
from stable_audio_3.models.bottleneck import SoftNormBottleneck
from stable_audio_3.models.pretransforms import PatchedPretransform

BLOCK_START = 5813473344  # data_offsets origin of the range-fetched block


def load_pretransform_state():
    hdr = json.load(open("/tmp/st_header.json"))
    dtmap = {"F32": np.float32}
    state = {}
    with open("pretransform_block.bin", "rb") as f:
        blob = f.read()
    for k, v in hdr.items():
        if not k.startswith("pretransform.model."):
            continue
        s, e = v["data_offsets"]
        arr = np.frombuffer(blob, dtype=dtmap[v["dtype"]], count=(e - s) // 4, offset=s - BLOCK_START)
        state[k.removeprefix("pretransform.model.")] = torch.from_numpy(arr.reshape(v["shape"]).copy())
    return state


cfg = json.load(open("/tmp/model_config.json"))["model"]["pretransform"]["config"]
for side in ("encoder", "decoder"):
    cfg[side]["config"]["mask_noise"] = 0.0
    cfg[side]["config"]["checkpointing"] = False
    cfg[side]["config"]["use_flash"] = False
cfg["bottleneck"]["config"]["noise_regularize"] = False

encoder = SAMEEncoder(**cfg["encoder"]["config"])
decoder = SAMEDecoder(**cfg["decoder"]["config"])
bottleneck = SoftNormBottleneck(**cfg["bottleneck"]["config"])
pretransform = PatchedPretransform(**cfg["pretransform"]["config"])
model = AudioAutoencoder(
    encoder, decoder,
    latent_dim=cfg["latent_dim"], downsampling_ratio=cfg["downsampling_ratio"],
    sample_rate=44100, io_channels=cfg["io_channels"],
    bottleneck=bottleneck, pretransform=pretransform,
).eval()

state = load_pretransform_state()
result = model.load_state_dict(state, strict=False)
unexpected = [k for k in result.unexpected_keys]
missing = [k for k in result.missing_keys]
assert not unexpected, f"unexpected: {unexpected[:5]}"
assert not missing, f"missing: {missing[:5]}"
print("original model loaded: all", len(state), "tensors matched")

smoke = torch.load("smoke.pt")
audio, my_lat, my_out = smoke["audio"], smoke["lat"], smoke["out"]

with torch.no_grad():
    ref_lat = model.encode(audio)
    ref_out = model.decode(my_lat)


def report(name, a, b):
    diff = (a - b).abs()
    denom = b.abs().max().item()
    print(f"{name}: max|diff|={diff.max().item():.3e}  rel={diff.max().item()/denom:.3e}  "
          f"corr={torch.corrcoef(torch.stack([a.flatten(), b.flatten()]))[0,1].item():.8f}")


report("encode (reimpl vs original)", my_lat, ref_lat)
report("decode (reimpl vs original)", my_out, ref_out)
torch.save({"ref_lat": ref_lat, "ref_out": ref_out}, "ref.pt")
