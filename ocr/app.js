/**
 * PaddleOCR browser app using onnxruntime-web.
 * Pipeline: text detection (DB) → crop text regions → text recognition (CRNN+CTC).
 * Models: PP-OCRv3 detection + PP-OCRv5 English recognition from HuggingFace.
 */

const HF = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main';
const DET_URL = `${HF}/detection/v3/det.onnx`;
const REC_URL = `${HF}/languages/english/rec.onnx`;
const DICT_URL = `${HF}/languages/english/dict.txt`;
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const DET_MAX_SIDE = 960;
const DET_THRESH = 0.3;
const MIN_BOX_AREA = 50;
const BOX_PAD = 5;
const REC_HEIGHT = 48;

// ── State ──

let detSession = null;
let recSession = null;
let dictionary = null;
let loading = false;

// ── DOM ──

const $ = (s) => document.querySelector(s);
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
const statusEl = $('#status');
const resultsEl = $('#results');
const outputEl = $('#output');
const copyBtn = $('#copy-btn');

// ── Model loading ──

function showStatus(msg) {
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
}

function hideStatus() {
  statusEl.classList.add('hidden');
}

async function ensureModels() {
  if (detSession && recSession && dictionary) return;
  if (loading) throw new Error('Models are still loading');
  loading = true;

  ort.env.wasm.wasmPaths = ORT_WASM;

  showStatus('Loading detection model (2 MB)…');
  detSession = await ort.InferenceSession.create(DET_URL);

  showStatus('Loading recognition model (8 MB)…');
  recSession = await ort.InferenceSession.create(REC_URL);

  showStatus('Loading dictionary…');
  const res = await fetch(DICT_URL);
  dictionary = (await res.text()).trim().split('\n');

  loading = false;
  hideStatus();
}

// ── Image helpers ──

/** Draw an image source onto a fresh canvas and return its ImageData. */
function toImageData(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Resize ImageData using an offscreen canvas. */
function resizeImageData(imgData, newW, newH) {
  const src = document.createElement('canvas');
  src.width = imgData.width;
  src.height = imgData.height;
  src.getContext('2d').putImageData(imgData, 0, 0);
  return toImageData(src, newW, newH);
}

/**
 * Normalize pixel data to NCHW Float32Array.
 * Layout: [1, 3, H, W] with ImageNet mean/std normalization.
 */
function toNCHW(imgData) {
  const { width: w, height: h, data } = imgData;
  const out = new Float32Array(3 * h * w);
  const plane = h * w;
  for (let i = 0; i < plane; i++) {
    const si = i * 4;
    out[i] = (data[si] / 255 - MEAN[0]) / STD[0];
    out[plane + i] = (data[si + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * plane + i] = (data[si + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

// ── Detection ──

/** Preprocess image for the DB detection model. */
function prepareDetInput(imgData) {
  const { width: ow, height: oh } = imgData;
  const scale = Math.min(DET_MAX_SIDE / Math.max(ow, oh), 1);
  let nw = Math.max(32, Math.ceil((ow * scale) / 32) * 32);
  let nh = Math.max(32, Math.ceil((oh * scale) / 32) * 32);
  const resized = resizeImageData(imgData, nw, nh);
  const float32 = toNCHW(resized);
  return {
    tensor: new ort.Tensor('float32', float32, [1, 3, nh, nw]),
    nw, nh,
    sx: ow / nw,
    sy: oh / nh,
  };
}

/**
 * Morphological dilation on a binary mask to merge nearby text.
 * Uses a square kernel of (2*r+1) for speed.
 */
function dilate(mask, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let dy = y0; dy <= y1; dy++)
        for (let dx = x0; dx <= x1; dx++) out[dy * w + dx] = 1;
    }
  }
  return out;
}

/**
 * Find bounding boxes of text regions from the detection probability map.
 * Uses flood-fill connected component labeling on the thresholded + dilated mask.
 */
function findBoxes(prob, w, h, sx, sy) {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = prob[i] > DET_THRESH ? 1 : 0;

  const mask = dilate(bin, w, h, 2);
  const visited = new Uint8Array(w * h);
  const boxes = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || visited[idx]) continue;

      // Flood-fill to find connected component bounds
      let minX = x, maxX = x, minY = y, maxY = y, area = 0;
      const stack = [idx];
      while (stack.length) {
        const i = stack.pop();
        if (visited[i]) continue;
        visited[i] = 1;
        area++;
        const cy = (i / w) | 0, cx = i % w;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const ni = ny * w + nx;
            if (mask[ni] && !visited[ni]) stack.push(ni);
          }
        }
      }

      if (area < MIN_BOX_AREA) continue;
      boxes.push({
        x: Math.max(0, Math.round((minX - BOX_PAD) * sx)),
        y: Math.max(0, Math.round((minY - BOX_PAD) * sy)),
        w: Math.round((maxX - minX + 1 + 2 * BOX_PAD) * sx),
        h: Math.round((maxY - minY + 1 + 2 * BOX_PAD) * sy),
      });
    }
  }

  // Reading order: top-to-bottom, then left-to-right for same row
  boxes.sort((a, b) => {
    const rowDiff = a.y - b.y;
    return Math.abs(rowDiff) > Math.min(a.h, b.h) * 0.4 ? rowDiff : a.x - b.x;
  });
  return boxes;
}

// ── Recognition ──

/** Crop a region from ImageData and prepare it for the recognition model. */
function prepareRecInput(imgData, box) {
  const { width: iw, height: ih } = imgData;
  // Clamp box to image bounds
  const bx = Math.max(0, box.x);
  const by = Math.max(0, box.y);
  const bw = Math.min(box.w, iw - bx);
  const bh = Math.min(box.h, ih - by);
  if (bw <= 0 || bh <= 0) return null;

  // Crop via canvas
  const src = document.createElement('canvas');
  src.width = iw;
  src.height = ih;
  src.getContext('2d').putImageData(imgData, 0, 0);

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = bw;
  cropCanvas.height = bh;
  cropCanvas.getContext('2d').drawImage(src, bx, by, bw, bh, 0, 0, bw, bh);

  // Resize to target height, keep aspect ratio
  const aspect = bw / bh;
  const tw = Math.max(1, Math.round(REC_HEIGHT * aspect));
  const resized = resizeImageData(
    cropCanvas.getContext('2d').getImageData(0, 0, bw, bh),
    tw, REC_HEIGHT,
  );

  const float32 = toNCHW(resized);
  return new ort.Tensor('float32', float32, [1, 3, REC_HEIGHT, tw]);
}

/**
 * CTC greedy decode: take argmax at each timestep, collapse repeats, remove blanks (index 0).
 */
function ctcDecode(output) {
  const [, steps, classes] = output.dims;
  const data = output.data;
  let prev = 0, text = '';

  for (let t = 0; t < steps; t++) {
    let best = 0, bestVal = -Infinity;
    const off = t * classes;
    for (let c = 0; c < classes; c++) {
      if (data[off + c] > bestVal) { bestVal = data[off + c]; best = c; }
    }
    if (best !== 0 && best !== prev && best - 1 < dictionary.length) {
      text += dictionary[best - 1];
    }
    prev = best;
  }
  return text;
}

// ── Full OCR pipeline ──

async function ocr(imgData) {
  // Detection
  const det = prepareDetInput(imgData);
  const detOut = await detSession.run({ [detSession.inputNames[0]]: det.tensor });
  const prob = detOut[detSession.outputNames[0]].data;
  const boxes = findBoxes(prob, det.nw, det.nh, det.sx, det.sy);

  if (!boxes.length) return '(No text detected)';

  // Recognition for each box
  const lines = [];
  for (const box of boxes) {
    const tensor = prepareRecInput(imgData, box);
    if (!tensor) continue;
    const recOut = await recSession.run({ [recSession.inputNames[0]]: tensor });
    const text = ctcDecode(recOut[recSession.outputNames[0]]);
    if (text.trim()) lines.push(text);
  }
  return lines.join('\n') || '(No text recognized)';
}

// ── PDF handling ──

async function pdfToImageDataList(arrayBuffer) {
  const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 2 }); // 2× for better OCR accuracy
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pages.push(ctx.getImageData(0, 0, vp.width, vp.height));
  }
  return pages;
}

// ── File processing ──

async function processFile(file) {
  resultsEl.classList.add('hidden');
  showStatus('Loading models…');

  try {
    await ensureModels();
  } catch (err) {
    console.error('Model loading failed:', err);
    showStatus(`Error loading models: ${err.message}`);
    return;
  }

  try {
    let pages;
    if (file.type === 'application/pdf') {
      showStatus('Rendering PDF…');
      const buf = await file.arrayBuffer();
      pages = await pdfToImageDataList(buf);
    } else {
      showStatus('Loading image…');
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
      pages = [toImageData(img, img.naturalWidth, img.naturalHeight)];
      URL.revokeObjectURL(img.src);
    }

    const allText = [];
    for (let i = 0; i < pages.length; i++) {
      showStatus(`OCR page ${i + 1}/${pages.length}…`);
      const text = await ocr(pages[i]);
      allText.push(pages.length > 1 ? `── Page ${i + 1} ──\n${text}` : text);
    }

    outputEl.textContent = allText.join('\n\n');
    resultsEl.classList.remove('hidden');
    hideStatus();
  } catch (err) {
    console.error('OCR failed:', err);
    showStatus(`Error: ${err.message}`);
  }
}

// ── Events ──

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) processFile(fileInput.files[0]);
  fileInput.value = '';
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('active');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('active');
  if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(outputEl.textContent);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  } catch (err) {
    console.error('Copy failed:', err);
  }
});

// ── Service worker ──

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e));
}
