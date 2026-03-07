#!/usr/bin/env python3
"""
Convert PaddleOCR-VL 0.9B to ONNX format.

Exports 5 ONNX models:
  1. patch_embed.onnx       - Conv2d patch embedding (3x14x14 -> 1152)
  2. vision_encoder.onnx    - Vision transformer encoder (no RoPE, no flash attn)
  3. vision_projector.onnx  - MLP projector (1152*4 -> 1024, with 2x2 spatial merge)
  4. decoder_prefill.onnx   - LLM prefill: full prompt → logits + KV cache
  5. decoder_decode.onnx    - LLM decode: 1 token + KV cache → logits + updated cache

Position encoding interpolation and 3D RoPE computation are NOT included in the
ONNX models - they must be done in the inference runtime. See the `verify_pipeline`
function for a reference implementation.

Requirements:
  pip install torch transformers einops onnx onnxruntime pillow torchvision sentencepiece onnxscript

Usage:
  python convert_paddleocr_vl.py [--output-dir ./paddleocr-vl-onnx] [--opset 17]
"""

import argparse
import json
import os
import numpy as np
import torch
import torch.nn as nn

MODEL_ID = "PaddlePaddle/PaddleOCR-VL"


def load_model():
    """Load PaddleOCR-VL model and processor from HuggingFace."""
    from transformers import AutoModelForCausalLM, AutoProcessor

    print(f"Loading {MODEL_ID}...")
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
        dtype=torch.float32,
        device_map="cpu",
    )
    model.eval()
    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    print(f"  Loaded: {sum(p.numel() for p in model.parameters())/1e6:.0f}M params")
    return model, processor


# ── Wrapper Modules ─────────────────────────────────────────────────────────

class PatchEmbedWrapper(nn.Module):
    """Patch embedding: Conv2d(3, 1152, k=14, s=14) + flatten.

    Input:  pixel_values [N, 3, 14, 14]  (individual patches from processor)
    Output: patch_embeds [N, 1152]
    """

    def __init__(self, conv):
        super().__init__()
        self.conv = conv

    def forward(self, pixel_values):
        # Conv2d [N,3,14,14] -> [N,1152,1,1] -> [N,1152]
        return self.conv(pixel_values).flatten(1)


class VisionEncoderWrapper(nn.Module):
    """Vision transformer encoder layers + post-layernorm (no RoPE, no window attn).

    Without RoPE/flash-attn, attention is standard (Q*K^T*V with softmax).

    Input:  hidden_states [1, N, 1152]
    Output: encoded       [1, N, 1152]
    """

    def __init__(self, encoder, post_layernorm):
        super().__init__()
        self.layers = encoder.layers
        self.post_layernorm = post_layernorm

    def forward(self, hidden_states):
        for layer in self.layers:
            layer_out = layer(
                hidden_states,
                attention_mask=None,
                output_attentions=False,
                cu_seqlens=None,
                rope_emb=None,
            )
            hidden_states = layer_out[0]
        return self.post_layernorm(hidden_states)


class VisionProjectorWrapper(nn.Module):
    """MLP projector with 2x2 spatial merge.

    Merges 2x2 adjacent patches before projecting: (h*w, 1152) -> (h/2*w/2, 1024).
    Expects patches in row-major order for a single image tile (t=1).

    Input:  features [N, 1152]  where N = h * w (h and w must be even)
            grid_h   int        height in patches
            grid_w   int        width in patches
    Output: projected [N/4, 1024]

    Note: grid_h and grid_w are NOT ONNX inputs - they're baked in at export time.
    For dynamic grids, export multiple variants or handle merging externally.
    """

    def __init__(self, projector, grid_h, grid_w):
        super().__init__()
        self.pre_norm = projector.pre_norm
        self.linear_1 = projector.linear_1
        self.act = projector.act
        self.linear_2 = projector.linear_2
        self.grid_h = grid_h
        self.grid_w = grid_w

    def forward(self, features):
        # features: [N, 1152] where N = grid_h * grid_w
        x = self.pre_norm(features)
        h, w = self.grid_h, self.grid_w
        d = x.shape[-1]  # 1152

        # Spatial merge: (h*w, d) -> (h/2 * w/2, 4*d) via 2x2 grouping
        # einops: "(h p1 w p2) d -> (h w) (p1 p2 d)" with p1=p2=2
        x = x.view(h // 2, 2, w // 2, 2, d)
        x = x.permute(0, 2, 1, 3, 4)      # [h/2, w/2, 2, 2, d]
        x = x.reshape(h // 2 * w // 2, 4 * d)

        x = self.linear_1(x)
        x = self.act(x)
        x = self.linear_2(x)
        return x  # [N/4, 1024]


class DecoderPrefillWrapper(nn.Module):
    """LLM decoder prefill: processes full prompt, returns logits + KV cache.

    Input:  input_ids      [1, seq_len]       token ids
            position_ids   [3, 1, seq_len]    3D RoPE positions (t, h, w)
            attention_mask  [1, seq_len]       1=attend, 0=ignore
    Output: logits         [1, seq_len, vocab] raw logits
            past_key_N     [1, num_kv_heads, seq_len, head_dim]  per layer
            past_value_N   [1, num_kv_heads, seq_len, head_dim]  per layer
    """

    def __init__(self, embed_tokens, transformer, lm_head, num_layers):
        super().__init__()
        self.embed_tokens = embed_tokens
        self.transformer = transformer
        self.lm_head = lm_head
        self.num_layers = num_layers

    def forward(self, input_ids, position_ids, attention_mask):
        embeds = self.embed_tokens(input_ids)
        out = self.transformer(
            input_ids=None,
            inputs_embeds=embeds,
            position_ids=position_ids,
            attention_mask=attention_mask,
            use_cache=True,
            output_attentions=False,
            output_hidden_states=False,
            return_dict=True,
        )
        logits = self.lm_head(out.last_hidden_state)
        # Flatten KV cache: (k0, v0, k1, v1, ..., kN, vN)
        cache = out.past_key_values
        kv_flat = []
        for i in range(self.num_layers):
            kv_flat.append(cache.key_cache[i])
            kv_flat.append(cache.value_cache[i])
        return (logits, *kv_flat)


class DecoderDecodeWrapper(nn.Module):
    """LLM decoder single-step: processes one token with KV cache.

    Input:  input_ids      [1, 1]             single token id
            position_ids   [3, 1, 1]          3D RoPE position for this step
            attention_mask  [1, past_len + 1]  full attention mask
            past_key_N     [1, num_kv_heads, past_len, head_dim]  per layer
            past_value_N   [1, num_kv_heads, past_len, head_dim]  per layer
    Output: logits         [1, 1, vocab]       logits for next token
            new_key_N      [1, num_kv_heads, past_len+1, head_dim]  per layer
            new_value_N    [1, num_kv_heads, past_len+1, head_dim]  per layer
    """

    def __init__(self, embed_tokens, transformer, lm_head, num_layers):
        super().__init__()
        self.embed_tokens = embed_tokens
        self.transformer = transformer
        self.lm_head = lm_head
        self.num_layers = num_layers

    def forward(self, input_ids, position_ids, attention_mask, *past_kv_flat):
        """past_kv_flat: k0, v0, k1, v1, ..., kN, vN as positional args."""
        from transformers import DynamicCache

        # Reconstruct DynamicCache from flat tensor args
        past_kv = DynamicCache()
        for i in range(self.num_layers):
            past_kv.update(
                past_kv_flat[2 * i],      # key
                past_kv_flat[2 * i + 1],  # value
                layer_idx=i,
            )

        embeds = self.embed_tokens(input_ids)
        out = self.transformer(
            input_ids=None,
            inputs_embeds=embeds,
            position_ids=position_ids,
            attention_mask=attention_mask,
            past_key_values=past_kv,
            use_cache=True,
            output_attentions=False,
            output_hidden_states=False,
            return_dict=True,
        )
        logits = self.lm_head(out.last_hidden_state)
        # Flatten updated KV cache
        cache = out.past_key_values
        kv_flat = []
        for i in range(self.num_layers):
            kv_flat.append(cache.key_cache[i])
            kv_flat.append(cache.value_cache[i])
        return (logits, *kv_flat)


# ── Export Functions ────────────────────────────────────────────────────────

def onnx_export(wrapper, args, path, input_names, output_names, dynamic_axes, opset):
    """Export a module to ONNX using legacy (JIT) tracing."""
    torch.onnx.export(
        wrapper,
        args,
        path,
        opset_version=opset,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        dynamo=False,  # use legacy JIT tracer, not dynamo
    )
    size_mb = os.path.getsize(path) / 1024 / 1024
    print(f"  Saved: {os.path.basename(path)} ({size_mb:.1f} MB)")
    return path


def export_patch_embed(model, output_dir, opset):
    """Export the patch embedding Conv2d."""
    print("\n── Patch embedding ──")
    wrapper = PatchEmbedWrapper(model.visual.vision_model.embeddings.patch_embedding)
    wrapper.eval()

    dummy = torch.randn(4, 3, 14, 14)  # 4 patches
    path = os.path.join(output_dir, "patch_embed.onnx")

    return onnx_export(
        wrapper, (dummy,), path,
        input_names=["pixel_values"],
        output_names=["patch_embeds"],
        dynamic_axes={
            "pixel_values": {0: "num_patches"},
            "patch_embeds": {0: "num_patches"},
        },
        opset=opset,
    )


def export_vision_encoder(model, output_dir, opset):
    """Export the vision transformer encoder (without RoPE)."""
    print("\n── Vision encoder ──")
    vt = model.visual.vision_model
    wrapper = VisionEncoderWrapper(vt.encoder, vt.post_layernorm)
    wrapper.eval()

    num_patches = 196  # example: 14x14 grid
    dummy = torch.randn(1, num_patches, 1152)
    path = os.path.join(output_dir, "vision_encoder.onnx")

    return onnx_export(
        wrapper, (dummy,), path,
        input_names=["hidden_states"],
        output_names=["encoded"],
        dynamic_axes={
            "hidden_states": {1: "num_patches"},
            "encoded": {1: "num_patches"},
        },
        opset=opset,
    )


def export_vision_projector(model, output_dir, opset):
    """Export the MLP projector with 2x2 spatial merge.

    Bakes in a default grid of 24x34 (from a typical 200x300 image).
    Re-export with different grid_h/grid_w for other resolutions,
    or handle the merge reshape externally.
    """
    print("\n── Vision projector ──")
    grid_h, grid_w = 24, 34  # must be even
    wrapper = VisionProjectorWrapper(model.mlp_AR, grid_h, grid_w)
    wrapper.eval()

    num_patches = grid_h * grid_w  # 816
    dummy = torch.randn(num_patches, 1152)
    path = os.path.join(output_dir, "vision_projector.onnx")

    return onnx_export(
        wrapper, (dummy,), path,
        input_names=["features"],
        output_names=["projected"],
        dynamic_axes={
            "features": {0: "num_patches"},
            "projected": {0: "num_merged"},
        },
        opset=opset,
    )


def export_decoder_prefill(model, output_dir, opset):
    """Export the decoder prefill model (full prompt → logits + KV cache)."""
    print("\n── LLM decoder (prefill) ──")
    num_layers = model.config.num_hidden_layers
    num_kv_heads = model.config.num_key_value_heads
    head_dim = model.config.head_dim
    wrapper = DecoderPrefillWrapper(
        model.model.embed_tokens, model.model, model.lm_head, num_layers
    )
    wrapper.eval()

    seq_len = 32
    dummy_ids = torch.randint(0, 1000, (1, seq_len))
    dummy_pos = torch.arange(seq_len).unsqueeze(0).unsqueeze(0).expand(3, 1, -1).clone()
    dummy_mask = torch.ones(1, seq_len, dtype=torch.long)
    path = os.path.join(output_dir, "decoder_prefill.onnx")

    # Build I/O names and dynamic axes for KV cache outputs
    output_names = ["logits"]
    dynamic_axes = {
        "input_ids": {1: "seq_len"},
        "position_ids": {2: "seq_len"},
        "attention_mask": {1: "seq_len"},
        "logits": {1: "seq_len"},
    }
    for i in range(num_layers):
        for kind in ("key", "value"):
            name = f"past_{kind}_{i}"
            output_names.append(name)
            dynamic_axes[name] = {2: "seq_len"}

    return onnx_export(
        wrapper, (dummy_ids, dummy_pos, dummy_mask), path,
        input_names=["input_ids", "position_ids", "attention_mask"],
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset=opset,
    )


def export_decoder_decode(model, output_dir, opset):
    """Export the decoder single-step model (1 token + KV cache → logits + updated cache)."""
    print("\n── LLM decoder (decode) ──")
    num_layers = model.config.num_hidden_layers
    num_kv_heads = model.config.num_key_value_heads
    head_dim = model.config.head_dim
    wrapper = DecoderDecodeWrapper(
        model.model.embed_tokens, model.model, model.lm_head, num_layers
    )
    wrapper.eval()

    past_len = 32  # example past sequence length
    dummy_ids = torch.randint(0, 1000, (1, 1))
    dummy_pos = torch.zeros(3, 1, 1, dtype=torch.long)
    dummy_mask = torch.ones(1, past_len + 1, dtype=torch.long)

    # Build dummy KV cache inputs
    dummy_kv = []
    for _ in range(num_layers):
        dummy_kv.append(torch.randn(1, num_kv_heads, past_len, head_dim))  # key
        dummy_kv.append(torch.randn(1, num_kv_heads, past_len, head_dim))  # value
    dummy_args = (dummy_ids, dummy_pos, dummy_mask, *dummy_kv)

    path = os.path.join(output_dir, "decoder_decode.onnx")

    # Build I/O names and dynamic axes
    input_names = ["input_ids", "position_ids", "attention_mask"]
    output_names = ["logits"]
    dynamic_axes = {
        "input_ids": {},
        "position_ids": {},
        "attention_mask": {1: "total_len"},
        "logits": {},
    }

    for i in range(num_layers):
        for kind in ("key", "value"):
            in_name = f"past_{kind}_{i}"
            out_name = f"new_{kind}_{i}"
            input_names.append(in_name)
            output_names.append(out_name)
            dynamic_axes[in_name] = {2: "past_len"}
            dynamic_axes[out_name] = {2: "total_len"}

    return onnx_export(
        wrapper, dummy_args, path,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset=opset,
    )


# ── Verification ───────────────────────────────────────────────────────────

def verify_onnx(path):
    """Validate ONNX model structure."""
    import onnx

    model = onnx.load(path)
    onnx.checker.check_model(model, full_check=True)
    inputs = [(i.name, [d.dim_param or d.dim_value for d in i.type.tensor_type.shape.dim]) for i in model.graph.input]
    outputs = [(o.name, [d.dim_param or d.dim_value for d in o.type.tensor_type.shape.dim]) for o in model.graph.output]
    print(f"  ✓ {os.path.basename(path)}")
    for name, shape in inputs:
        print(f"      in:  {name} {shape}")
    for name, shape in outputs:
        print(f"      out: {name} {shape}")


def save_metadata(model, processor, output_dir):
    """Save config, tokenizer, and inference metadata."""
    print("\n── Saving metadata ──")
    # Processor (tokenizer + image processor)
    processor.save_pretrained(output_dir)

    # Position embedding weights (needed for interpolation in JS)
    pos_embed = model.visual.vision_model.embeddings.position_embedding.weight.detach().cpu().numpy()
    np.save(os.path.join(output_dir, "position_embedding.npy"), pos_embed)

    # Inference metadata
    config = model.config
    meta = {
        "model_id": MODEL_ID,
        "vision": {
            "hidden_size": config.vision_config.hidden_size,
            "patch_size": config.vision_config.patch_size,
            "image_size": config.vision_config.image_size,
            "num_positions": (config.vision_config.image_size // config.vision_config.patch_size) ** 2,
            "spatial_merge_size": config.vision_config.spatial_merge_size,
        },
        "text": {
            "hidden_size": config.hidden_size,
            "vocab_size": config.vocab_size,
            "num_layers": config.num_hidden_layers,
            "num_kv_heads": config.num_key_value_heads,
            "head_dim": config.head_dim,
        },
        "special_tokens": {
            "image_token_id": config.image_token_id,
            "vision_start_token_id": config.vision_start_token_id,
            "vision_end_token_id": config.vision_end_token_id,
        },
    }
    with open(os.path.join(output_dir, "inference_config.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"  Saved: inference_config.json, position_embedding.npy, tokenizer files")


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Convert PaddleOCR-VL to ONNX")
    parser.add_argument("--output-dir", default="./paddleocr-vl-onnx")
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--skip-verify", action="store_true")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    model, processor = load_model()

    paths = []
    with torch.no_grad():
        paths.append(export_patch_embed(model, args.output_dir, args.opset))
        paths.append(export_vision_encoder(model, args.output_dir, args.opset))
        paths.append(export_vision_projector(model, args.output_dir, args.opset))
        paths.append(export_decoder_prefill(model, args.output_dir, args.opset))
        paths.append(export_decoder_decode(model, args.output_dir, args.opset))

    save_metadata(model, processor, args.output_dir)

    if not args.skip_verify:
        print("\n── Verification ──")
        for path in paths:
            verify_onnx(path)

    total_mb = sum(os.path.getsize(p) for p in paths) / 1024 / 1024
    print(f"\n── Done ──")
    print(f"  Total: {total_mb:.1f} MB in {args.output_dir}")
    print(f"  Files: {', '.join(os.path.basename(p) for p in paths)}")
    print()
    print("  Inference pipeline:")
    print("    1. Image → processor → pixel_values [N, 3, 14, 14]")
    print("    2. patch_embed(pixel_values) → patch_embeds [N, 1152]")
    print("    3. Add interpolated position embeddings (use position_embedding.npy)")
    print("    4. vision_encoder([1, N, 1152]) → encoded [1, N, 1152]")
    print("    5. vision_projector(encoded) → projected [N/4, 1024]")
    print("    6. Build input_ids with <image> tokens replaced by projected features")
    print("    7. Compute 3D position_ids (see get_rope_index in modeling code)")
    print("    8. decoder_prefill(ids, pos, mask) → logits + KV cache")
    print("    9. Loop: decoder_decode(next_id, pos, mask, kv) → logits + updated KV")


if __name__ == "__main__":
    main()
