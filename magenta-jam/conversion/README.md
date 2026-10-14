# Converting Magenta RealTime 2 to LiteRT

Scripts used to produce `../models/`. They expect the PyTorch port
[magenta-community/magenta-realtime-2-small](https://huggingface.co/magenta-realtime-2-small)
(`*.py` + `model.safetensors`, plus `cudagraph.py`) in `torchport/`, copied to a
package dir `mrt2port/` with an empty `__init__.py`.

```bash
uv venv --python 3.11 venv && . venv/bin/activate
uv pip install --extra-index-url https://download.pytorch.org/whl/cpu "torch==2.13.*" \
    "litert-torch==0.9.4" transformers sentencepiece safetensors numpy
python test_frame_step.py        # FrameStep (export graph) == reference loop
python test_decoder_stream.py    # DecoderStream == reference streaming decode
python convert_llm2.py && python test_tflite_llm2.py temporal_fp32.tflite depth_fp32.tflite
python quantize_ops.py temporal_fp32.tflite temporal_w8.tflite FULLY_CONNECTED
python quantize_ops.py depth_fp32.tflite depth_w8.tflite FULLY_CONNECTED
python convert_decoder.py 4 decoder4_fp32.tflite && python test_tflite_decoder.py decoder4_fp32.tflite
python chunk_models.py temporal=temporal_w8.tflite depth=depth_w8.tflite decoder=decoder4_fp32.tflite && cp sos.json ../models/
```

## Lessons

- `torch.topk` with a runtime `k` lowers to `STABLEHLO_SORT`, which LiteRT
  cannot run. Ranking by counting strictly-greater logits (`frame_step.py`)
  keeps top-k a runtime input using only GREATER/SUM/SELECT/ARG_MAX.
- Advanced indexing (`table[idx]`) becomes `GATHER_ND` and
  `repeat_interleave` becomes `BROADCAST_TO`; neither runs on LiteRT.js's
  WebGPU backend. `F.embedding` (GATHER) and `F.interpolate(mode='nearest')`
  do. LiteRT.js also refuses INT64 and BOOL tensors at the model boundary, so
  convert with `enable_x64=False` and keep masks internal.
- Transposed convolutions written as zero-insertion + conv doubled the
  decoder's MACs; `conv_transpose2d` with a flipped kernel and a slice of the
  full output reproduces the reference's semicausal/same padding exactly.
- The WebGPU delegate rejects `BATCH_MATMUL` with a constant operand and a
  one-key softmax (it lowers to x/x), so single-query attention is written as
  MUL + SUM and depth level 0 skips the softmax. It also silently computes
  the wrong result when a sink-logit column is concatenated onto masked
  logits, so the attention sink is folded in as KV slot 0 (its key divided by
  the query scale) and the mask is applied once over the full row.
- The SpectroStream decoder's activations reach ~4e6, so it must run in fp32
  on the GPU; the LLM runs in fp16 (all three in fp32 exceed the WASM heap).
  In fp16 the LLM's attention-output projections reach ~600, whose squares
  overflow inside RMSNorm, so every norm first divides the row by its max
  (`rms_norm`/`layer_norm` in `frame_step.py`, mathematically identical). It also cannot run
  `DEQUANTIZE` (fp16 weights) or a constant-only `CAST`, so the decoder stays
  fp32; int8 dynamic-range convs lost 90 dB of SNR anyway.
- `ai-edge-quantizer` quantizes `BATCH_MATMUL` with a constant operand onto
  the wrong side (kernel rejects int8 LHS), so restrict dynamic int8 to
  `FULLY_CONNECTED`.
- LiteRT.js's WebGPU compiler aborts on the fused frame graph (temporal + 12
  depth levels) while each half compiles, hence `temporal.tflite` + `depth.tflite`.
- In fp16 GPU mode a `-1e9` mask constant overflows to -inf and SELECT turns it
  into NaN (the whole frame becomes garbage); `-3e4` masks just as well.
- Feed LiteRT.js inputs by name (`args_N`): positional `run()` does not follow
  the signature order.
- The port's functional `step_f` attends 42 past keys once its window is
  full; sequence_layers' streaming attention keeps a 41-key buffer. The export
  follows the library, so parity with `step_f` holds only for the first 42 frames.
