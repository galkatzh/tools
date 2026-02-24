(function () {
  'use strict';

  // ========== State ==========
  const state = {
    tool: 'select',        // 'select' | 'text' | 'draw'
    bgImage: null,         // HTMLImageElement
    canvasW: 800,
    canvasH: 600,
    texts: [],             // { id, text, x, y, size, color, outline, lines (computed) }
    drawings: [],          // { points: [{x,y}], color, width }
    currentDrawing: null,
    selectedTextId: null,
    dragging: false,
    dragMoved: false,
    dragOffset: { x: 0, y: 0 },
    history: [],           // snapshots
    historyIndex: -1,
    imageLoaded: false,
  };

  let nextTextId = 1;

  // ========== DOM refs ==========
  const canvas = document.getElementById('meme-canvas');
  const ctx = canvas.getContext('2d');
  const container = document.getElementById('canvas-container');
  const emptyState = document.getElementById('empty-state');

  const btnSelect = document.getElementById('btn-select');
  const btnText = document.getElementById('btn-text');
  const btnDraw = document.getElementById('btn-draw');
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');
  const btnSearch = document.getElementById('btn-search');
  const btnUpload = document.getElementById('btn-upload');
  const btnSave = document.getElementById('btn-save');
  const btnPaste = document.getElementById('btn-paste');
  const btnGetStarted = document.getElementById('btn-get-started');

  const optionsBar = document.getElementById('options-bar');
  const drawOptions = document.getElementById('draw-options');
  const textOptions = document.getElementById('text-options');

  const drawColorInput = document.getElementById('draw-color');
  const drawWidthInput = document.getElementById('draw-width');
  const drawWidthVal = document.getElementById('draw-width-val');

  const textColorInput = document.getElementById('text-color');
  const textSizeInput = document.getElementById('text-size');
  const textSizeVal = document.getElementById('text-size-val');
  const textOutlineInput = document.getElementById('text-outline');
  const btnDeleteText = document.getElementById('btn-delete-text');

  const searchModal = document.getElementById('search-modal');
  const btnCloseSearch = document.getElementById('btn-close-search');

  const textEditModal = document.getElementById('text-edit-modal');
  const btnCloseTextEdit = document.getElementById('btn-close-text-edit');
  const textInput = document.getElementById('text-input');
  const modalTextColor = document.getElementById('modal-text-color');
  const modalTextOutline = document.getElementById('modal-text-outline');
  const modalTextSize = document.getElementById('modal-text-size');
  const modalTextSizeVal = document.getElementById('modal-text-size-val');
  const btnAddText = document.getElementById('btn-add-text');

  const fileInput = document.getElementById('file-input');

  // ========== Canvas Setup ==========
  function resizeCanvas() {
    if (!state.imageLoaded) {
      canvas.width = 800;
      canvas.height = 600;
      canvas.style.display = 'none';
      return;
    }
    canvas.style.display = 'block';

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const imgW = state.canvasW;
    const imgH = state.canvasH;
    const scale = Math.min(cw / imgW, ch / imgH, 1);
    canvas.style.width = (imgW * scale) + 'px';
    canvas.style.height = (imgH * scale) + 'px';
    canvas.width = imgW;
    canvas.height = imgH;
    render();
  }

  window.addEventListener('resize', resizeCanvas);

  // ========== Coordinate helpers ==========
  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      clientX = e.changedTouches[0].clientX;
      clientY = e.changedTouches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  // ========== Render ==========
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    if (state.bgImage) {
      ctx.drawImage(state.bgImage, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Drawings
    for (const d of state.drawings) {
      drawStroke(d);
    }
    if (state.currentDrawing) {
      drawStroke(state.currentDrawing);
    }

    // Texts
    for (const t of state.texts) {
      drawText(t, t.id === state.selectedTextId);
    }
  }

  function drawStroke(d) {
    if (d.points.length === 0) return;
    if (d.points.length === 1) {
      ctx.beginPath();
      ctx.arc(d.points[0].x, d.points[0].y, d.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(d.points[0].x, d.points[0].y);
    for (let i = 1; i < d.points.length; i++) {
      ctx.lineTo(d.points[i].x, d.points[i].y);
    }
    ctx.strokeStyle = d.color;
    ctx.lineWidth = d.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawText(t, selected) {
    const lines = t.text.split('\n');
    ctx.font = `bold ${t.size}px Impact, Arial Black, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const lineHeight = t.size * 1.15;
    const totalH = lines.length * lineHeight;

    // Compute bounding box for selection
    let maxW = 0;
    for (const line of lines) {
      const m = ctx.measureText(line);
      if (m.width > maxW) maxW = m.width;
    }
    t._bbox = {
      x: t.x - maxW / 2 - 8,
      y: t.y - 4,
      w: maxW + 16,
      h: totalH + 8,
    };

    // Draw selection box
    if (selected) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#e94560';
      ctx.lineWidth = 2;
      ctx.strokeRect(t._bbox.x, t._bbox.y, t._bbox.w, t._bbox.h);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Draw text with outline
    for (let i = 0; i < lines.length; i++) {
      const ly = t.y + i * lineHeight;
      if (t.outline && t.outline !== 'transparent') {
        ctx.strokeStyle = t.outline;
        ctx.lineWidth = Math.max(2, t.size / 10);
        ctx.lineJoin = 'round';
        ctx.strokeText(lines[i], t.x, ly);
      }
      ctx.fillStyle = t.color;
      ctx.fillText(lines[i], t.x, ly);
    }
  }

  // ========== History / Undo-Redo ==========
  function snapshot() {
    const snap = {
      texts: JSON.parse(JSON.stringify(state.texts.map(t => ({
        id: t.id, text: t.text, x: t.x, y: t.y,
        size: t.size, color: t.color, outline: t.outline,
      })))),
      drawings: JSON.parse(JSON.stringify(state.drawings)),
    };
    // Discard future
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(snap);
    state.historyIndex = state.history.length - 1;
    updateUndoRedo();
  }

  function restoreSnapshot(snap) {
    state.texts = snap.texts.map(t => ({ ...t }));
    state.drawings = snap.drawings.map(d => ({ ...d, points: d.points.map(p => ({ ...p })) }));
    state.selectedTextId = null;
    updateTextOptionsVisibility();
    render();
  }

  function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    restoreSnapshot(state.history[state.historyIndex]);
    updateUndoRedo();
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    restoreSnapshot(state.history[state.historyIndex]);
    updateUndoRedo();
  }

  function updateUndoRedo() {
    btnUndo.disabled = state.historyIndex <= 0;
    btnRedo.disabled = state.historyIndex >= state.history.length - 1;
  }

  btnUndo.addEventListener('click', undo);
  btnRedo.addEventListener('click', redo);

  // ========== Tool switching ==========
  function setTool(tool) {
    state.tool = tool;
    btnSelect.classList.toggle('active', tool === 'select');
    btnText.classList.toggle('active', tool === 'text');
    btnDraw.classList.toggle('active', tool === 'draw');

    drawOptions.classList.toggle('hidden', tool !== 'draw');
    textOptions.classList.add('hidden');

    if (tool === 'draw') {
      optionsBar.classList.remove('hidden');
    } else {
      optionsBar.classList.add('hidden');
    }

    if (tool !== 'select') {
      state.selectedTextId = null;
      render();
    }

    updateTextOptionsVisibility();
  }

  function updateTextOptionsVisibility() {
    const show = state.tool === 'select' && state.selectedTextId != null;
    textOptions.classList.toggle('hidden', !show);
    btnDeleteText.style.display = show ? 'inline-block' : 'none';
    if (show) {
      optionsBar.classList.remove('hidden');
      const t = state.texts.find(t => t.id === state.selectedTextId);
      if (t) {
        textColorInput.value = t.color;
        textSizeInput.value = t.size;
        textSizeVal.textContent = t.size;
        textOutlineInput.value = t.outline;
      }
    } else if (state.tool === 'select') {
      optionsBar.classList.add('hidden');
    }
  }

  btnSelect.addEventListener('click', () => setTool('select'));
  btnText.addEventListener('click', () => {
    if (!state.imageLoaded) return;
    setTool('text');
    openTextEditModal();
  });
  btnDraw.addEventListener('click', () => setTool('draw'));

  // ========== Text options (inline) ==========
  textColorInput.addEventListener('input', () => {
    const t = state.texts.find(t => t.id === state.selectedTextId);
    if (t) { t.color = textColorInput.value; render(); }
  });
  textColorInput.addEventListener('change', () => snapshot());

  textOutlineInput.addEventListener('input', () => {
    const t = state.texts.find(t => t.id === state.selectedTextId);
    if (t) { t.outline = textOutlineInput.value; render(); }
  });
  textOutlineInput.addEventListener('change', () => snapshot());

  textSizeInput.addEventListener('input', () => {
    textSizeVal.textContent = textSizeInput.value;
    const t = state.texts.find(t => t.id === state.selectedTextId);
    if (t) { t.size = parseInt(textSizeInput.value); render(); }
  });
  textSizeInput.addEventListener('change', () => snapshot());

  btnDeleteText.addEventListener('click', () => {
    state.texts = state.texts.filter(t => t.id !== state.selectedTextId);
    state.selectedTextId = null;
    updateTextOptionsVisibility();
    render();
    snapshot();
  });

  // ========== Draw options ==========
  drawWidthInput.addEventListener('input', () => {
    drawWidthVal.textContent = drawWidthInput.value;
  });

  // ========== Text edit modal ==========
  let editingTextId = null;

  function openTextEditModal(existingId) {
    editingTextId = existingId || null;
    if (editingTextId) {
      const t = state.texts.find(t => t.id === editingTextId);
      if (t) {
        textInput.value = t.text;
        modalTextColor.value = t.color;
        modalTextOutline.value = t.outline;
        modalTextSize.value = t.size;
        modalTextSizeVal.textContent = t.size;
        btnAddText.textContent = 'Update Text';
      }
    } else {
      textInput.value = '';
      modalTextColor.value = '#ffffff';
      modalTextOutline.value = '#000000';
      modalTextSize.value = 40;
      modalTextSizeVal.textContent = '40';
      btnAddText.textContent = 'Add Text';
    }
    textEditModal.classList.remove('hidden');
    textInput.focus();
  }

  function closeTextEditModal() {
    textEditModal.classList.add('hidden');
    editingTextId = null;
  }

  btnCloseTextEdit.addEventListener('click', closeTextEditModal);
  textEditModal.addEventListener('click', (e) => {
    if (e.target === textEditModal) closeTextEditModal();
  });

  modalTextSize.addEventListener('input', () => {
    modalTextSizeVal.textContent = modalTextSize.value;
  });

  btnAddText.addEventListener('click', () => {
    const val = textInput.value.trim();
    if (!val) return;

    if (editingTextId) {
      const t = state.texts.find(t => t.id === editingTextId);
      if (t) {
        t.text = val;
        t.color = modalTextColor.value;
        t.outline = modalTextOutline.value;
        t.size = parseInt(modalTextSize.value);
      }
    } else {
      state.texts.push({
        id: nextTextId++,
        text: val,
        x: canvas.width / 2,
        y: state.texts.length === 0 ? 40 : canvas.height - parseInt(modalTextSize.value) - 40,
        size: parseInt(modalTextSize.value),
        color: modalTextColor.value,
        outline: modalTextOutline.value,
      });
    }

    closeTextEditModal();
    setTool('select');
    render();
    snapshot();
  });

  // ========== Canvas pointer events ==========
  function onPointerDown(e) {
    if (!state.imageLoaded) return;
    e.preventDefault();
    const pos = canvasCoords(e);

    if (state.tool === 'draw') {
      state.currentDrawing = {
        points: [pos],
        color: drawColorInput.value,
        width: parseInt(drawWidthInput.value),
      };
    } else if (state.tool === 'select') {
      // Hit test texts (reverse order for top-most)
      let hit = null;
      for (let i = state.texts.length - 1; i >= 0; i--) {
        const t = state.texts[i];
        if (t._bbox && pos.x >= t._bbox.x && pos.x <= t._bbox.x + t._bbox.w &&
            pos.y >= t._bbox.y && pos.y <= t._bbox.y + t._bbox.h) {
          hit = t;
          break;
        }
      }
      if (hit) {
        state.selectedTextId = hit.id;
        state.dragging = true;
        state.dragMoved = false;
        state.dragOffset = { x: pos.x - hit.x, y: pos.y - hit.y };
        updateTextOptionsVisibility();
        render();
      } else {
        state.selectedTextId = null;
        state.dragging = false;
        updateTextOptionsVisibility();
        render();
      }
    }
  }

  function onPointerMove(e) {
    if (!state.imageLoaded) return;
    e.preventDefault();
    const pos = canvasCoords(e);

    if (state.tool === 'draw' && state.currentDrawing) {
      state.currentDrawing.points.push(pos);
      render();
    } else if (state.tool === 'select' && state.dragging && state.selectedTextId) {
      state.dragMoved = true;
      const t = state.texts.find(t => t.id === state.selectedTextId);
      if (t) {
        t.x = pos.x - state.dragOffset.x;
        t.y = pos.y - state.dragOffset.y;
        render();
      }
    }
  }

  function onPointerUp(e) {
    if (!state.imageLoaded) return;
    e.preventDefault();

    if (state.tool === 'draw' && state.currentDrawing) {
      if (state.currentDrawing.points.length >= 1) {
        state.drawings.push(state.currentDrawing);
        snapshot();
      }
      state.currentDrawing = null;
      render();
    } else if (state.tool === 'select' && state.dragging) {
      state.dragging = false;
      if (state.dragMoved) snapshot();
    }
  }

  // Mouse events
  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('mouseleave', onPointerUp);

  // Touch events
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  canvas.addEventListener('touchmove', onPointerMove, { passive: false });
  canvas.addEventListener('touchcancel', onPointerUp, { passive: false });

  // Combined touchend: handle pointer up + double-tap detection
  let lastTap = 0;
  canvas.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      // Double tap - skip normal pointer up to avoid spurious snapshots
      e.preventDefault();
      state.dragging = false;
      handleDoubleTap(e);
    } else {
      onPointerUp(e);
    }
    lastTap = now;
  }, { passive: false });

  // Desktop double-click to edit text
  canvas.addEventListener('dblclick', (e) => {
    handleDoubleTap(e);
  });

  function handleDoubleTap(e) {
    if (state.tool !== 'select') return;
    const pos = canvasCoords(e);
    for (let i = state.texts.length - 1; i >= 0; i--) {
      const t = state.texts[i];
      if (t._bbox && pos.x >= t._bbox.x && pos.x <= t._bbox.x + t._bbox.w &&
          pos.y >= t._bbox.y && pos.y <= t._bbox.y + t._bbox.h) {
        openTextEditModal(t.id);
        return;
      }
    }
  }

  // ========== Image loading ==========
  function showLoading() {
    let overlay = container.querySelector('.loading-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'loading-overlay';
      overlay.innerHTML = '<div class="spinner"></div> Loading image...';
      container.appendChild(overlay);
    }
  }

  function hideLoading() {
    const overlay = container.querySelector('.loading-overlay');
    if (overlay) overlay.remove();
  }

  // CORS proxy chain - try each in order on failure
  const CORS_PROXIES = [
    (url) => 'https://corsproxy.io/?' + encodeURIComponent(url),
    (url) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
  ];

  function loadImage(src, _proxyIndex) {
    const proxyIndex = _proxyIndex || 0;
    console.log('[Meme] loadImage called | proxyIndex:', proxyIndex, '| url:', src.substring(0, 150));
    showLoading();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      console.log('[Meme] Image loaded | natural:', img.naturalWidth, 'x', img.naturalHeight, '| url:', src.substring(0, 150));
      // Reject tiny placeholder images (< 10x10) when we expect real content
      if (img.naturalWidth < 10 || img.naturalHeight < 10) {
        console.log('[Meme] Rejected: image too small');
        img.onerror();
        return;
      }
      state.bgImage = img;
      state.canvasW = img.naturalWidth;
      state.canvasH = img.naturalHeight;
      // Limit max canvas size for performance
      const maxDim = 1200;
      if (state.canvasW > maxDim || state.canvasH > maxDim) {
        const ratio = Math.min(maxDim / state.canvasW, maxDim / state.canvasH);
        state.canvasW = Math.round(state.canvasW * ratio);
        state.canvasH = Math.round(state.canvasH * ratio);
      }
      console.log('[Meme] Canvas size set to:', state.canvasW, 'x', state.canvasH);
      state.imageLoaded = true;
      state.texts = [];
      state.drawings = [];
      state.history = [];
      state.historyIndex = -1;
      state.selectedTextId = null;
      nextTextId = 1;
      emptyState.style.display = 'none';
      hideLoading();
      resizeCanvas();
      snapshot();
    };
    img.onerror = () => {
      console.log('[Meme] Image load error | proxyIndex:', proxyIndex, '| url:', src.substring(0, 150));
      // If this was a direct load (no proxy yet), try proxies in order
      if (!_proxyIndex && proxyIndex === 0 && !src.startsWith('data:')) {
        console.log('[Meme] Retrying with proxy 0');
        loadImage(CORS_PROXIES[0](src), 1);
        return;
      }
      // Try next proxy
      if (_proxyIndex && _proxyIndex < CORS_PROXIES.length) {
        console.log('[Meme] Retrying with proxy', _proxyIndex);
        loadImage(CORS_PROXIES[_proxyIndex](state._originalLoadUrl || src), _proxyIndex + 1);
        return;
      }
      hideLoading();
      alert('Failed to load image. The image may be protected or unavailable. Try uploading the image directly instead.');
    };
    // Store original URL for proxy chain
    if (!_proxyIndex) {
      state._originalLoadUrl = src;
    }
    img.src = src;
  }

  // ========== File upload ==========
  btnUpload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      loadImage(ev.target.result);
    };
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  // ========== Clipboard paste ==========

  /**
   * Extract an image blob from a DataTransferItemList or File array.
   * Returns the first image/* item found, or null.
   */
  function extractImageFromItems(items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type && item.type.startsWith('image/')) {
        return item.getAsFile ? item.getAsFile() : item;
      }
    }
    return null;
  }

  /** Check if a string looks like a URL pointing to an image. */
  function looksLikeImageUrl(text) {
    const trimmed = text.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    // Direct image file extension
    if (/\.(jpe?g|png|gif|webp|bmp|svg)(\?.*)?$/i.test(trimmed)) return trimmed;
    // Common image host patterns (imgur, etc.) even without extension
    if (/imgur\.com\/\w+/i.test(trimmed)) return trimmed;
    return null;
  }

  /** Load an image File/Blob into the canvas via object URL. */
  function loadImageFromBlob(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // Re-encode to data URL so loadImage's CORS handling works cleanly
      const tmp = document.createElement('canvas');
      tmp.width = img.naturalWidth;
      tmp.height = img.naturalHeight;
      tmp.getContext('2d').drawImage(img, 0, 0);
      try {
        loadImage(tmp.toDataURL('image/png'));
      } catch (err) {
        console.error('[Meme] Paste re-encode failed:', err);
        // Fallback: load the object URL directly
        loadImage(URL.createObjectURL(blob));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      console.error('[Meme] Pasted image failed to decode');
    };
    img.src = url;
  }

  // Ctrl+V / Cmd+V — intercept paste events with image data
  document.addEventListener('paste', (e) => {
    // Don't intercept when typing in text fields
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;

    // Prefer image blob if available
    const blob = extractImageFromItems(items);
    if (blob) {
      e.preventDefault();
      console.log('[Meme] Image pasted from clipboard via Ctrl+V');
      loadImageFromBlob(blob);
      return;
    }

    // Fallback: check for a pasted image URL as text (common on iOS Safari)
    const text = e.clipboardData.getData('text/plain');
    const imageUrl = text && looksLikeImageUrl(text);
    if (imageUrl) {
      e.preventDefault();
      console.log('[Meme] Image URL pasted from clipboard:', imageUrl.substring(0, 120));
      loadImage(imageUrl);
    }
  });

  // "Paste" button — uses async Clipboard API for mobile/tappable access.
  // Checks for image blobs first, then falls back to text URLs since iOS
  // Safari often copies images as URLs rather than blobs.
  btnPaste.addEventListener('click', async () => {
    try {
      const clipItems = await navigator.clipboard.read();
      for (const item of clipItems) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          console.log('[Meme] Image pasted from clipboard via button');
          loadImageFromBlob(blob);
          return;
        }
      }
      // No image blob — check for text that looks like an image URL
      for (const item of clipItems) {
        if (item.types.includes('text/plain')) {
          const textBlob = await item.getType('text/plain');
          const text = await textBlob.text();
          const imageUrl = looksLikeImageUrl(text);
          if (imageUrl) {
            console.log('[Meme] Image URL pasted from clipboard via button:', imageUrl.substring(0, 120));
            loadImage(imageUrl);
            return;
          }
        }
      }
      alert('No image found in clipboard. Copy an image or image URL first, then paste.');
    } catch (err) {
      console.error('[Meme] Clipboard read failed:', err);
      // Fallback: try the simpler readText API which has broader support
      try {
        const text = await navigator.clipboard.readText();
        const imageUrl = text && looksLikeImageUrl(text);
        if (imageUrl) {
          console.log('[Meme] Image URL pasted via readText fallback:', imageUrl.substring(0, 120));
          loadImage(imageUrl);
          return;
        }
      } catch (textErr) {
        console.error('[Meme] Clipboard readText also failed:', textErr);
      }
      alert('Could not read clipboard. Your browser may require permission, or there may be no image copied.');
    }
  });

  // ========== Search modal ==========
  btnSearch.addEventListener('click', openSearchModal);
  btnGetStarted.addEventListener('click', openSearchModal);

  function openSearchModal() {
    searchModal.classList.remove('hidden');
  }

  function closeSearchModal() {
    searchModal.classList.add('hidden');
  }

  btnCloseSearch.addEventListener('click', closeSearchModal);
  searchModal.addEventListener('click', (e) => {
    if (e.target === searchModal) closeSearchModal();
  });

  // ========== CSE Integration ==========
  // Strategy: Let users interact with CSE results normally. When they click
  // a result, CSE shows an expanded preview panel with a larger image and
  // (often) the original image link. We detect these preview panels via
  // MutationObserver and inject "Use as Template" buttons that extract the
  // full-resolution image URL from the preview.

  var cseResultsData = [];

  /**
   * Find the best (original, full-res) image URL within a DOM container.
   * Priority: direct image file links > data-ctorig > largest non-cached img.
   */
  function findOriginalImageUrl(container) {
    // 1. <a> links pointing directly to image files
    var links = container.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].href || '';
      if (/\.(jpe?g|png|gif|webp|bmp|svg)(\?.*)?$/i.test(href) &&
          !href.includes('encrypted-tbn') && !href.includes('gstatic.com/images')) {
        console.log('[MemeCSE] Found direct image link:', href.substring(0, 120));
        return href;
      }
    }

    // 2. Images with data-ctorig that looks like an image URL
    var allImgs = container.querySelectorAll('img');
    for (var i = 0; i < allImgs.length; i++) {
      var ctorig = allImgs[i].getAttribute('data-ctorig') || '';
      if (/\.(jpe?g|png|gif|webp|bmp|svg)(\?.*)?$/i.test(ctorig)) {
        console.log('[MemeCSE] Found data-ctorig image:', ctorig.substring(0, 120));
        return ctorig;
      }
    }

    // 3. Largest non-Google-cached <img> by rendered or natural size
    var best = null, bestArea = 0;
    for (var i = 0; i < allImgs.length; i++) {
      var src = allImgs[i].getAttribute('data-src') || allImgs[i].src || '';
      if (!src || src.includes('encrypted-tbn') || src.includes('gstatic.com/images')) continue;
      var w = allImgs[i].naturalWidth || allImgs[i].width || 0;
      var h = allImgs[i].naturalHeight || allImgs[i].height || 0;
      var area = w * h;
      if (area > bestArea) {
        bestArea = area;
        best = src;
      }
    }
    if (best) {
      console.log('[MemeCSE] Found best image by size:', best.substring(0, 120), '| area:', bestArea);
      return best;
    }

    // 4. Fallback: any non-Google-cached image
    for (var i = 0; i < allImgs.length; i++) {
      var src = allImgs[i].getAttribute('data-src') || allImgs[i].src || '';
      if (src && !src.includes('encrypted-tbn') && !src.includes('gstatic.com/images') && !src.startsWith('data:')) {
        console.log('[MemeCSE] Fallback image:', src.substring(0, 120));
        return src;
      }
    }

    return null;
  }

  /**
   * Create and inject "Use as Meme Template" and "Copy Image" buttons into a container.
   */
  function injectTemplateButton(imageUrl, parent) {
    if (!imageUrl || !parent) return;
    if (parent.querySelector('.meme-template-btn')) return;

    var btnStyle = [
      'display:inline-block; margin:4px; background:#e94560; color:#fff;',
      'border:none; padding:10px 16px; border-radius:6px; font-size:14px;',
      'font-weight:bold; cursor:pointer; transition:background 0.15s;',
      'z-index:100; position:relative;',
    ].join('');

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'text-align:center; margin:8px auto;';

    var btnUse = document.createElement('button');
    btnUse.className = 'meme-template-btn';
    btnUse.textContent = 'Use as Template';
    btnUse.style.cssText = btnStyle;
    btnUse.onmouseenter = function () { btnUse.style.background = '#ff6b81'; };
    btnUse.onmouseleave = function () { btnUse.style.background = '#e94560'; };
    btnUse.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeSearchModal();
      loadImage(imageUrl);
    });

    var btnCopy = document.createElement('button');
    btnCopy.className = 'meme-template-btn meme-copy-btn';
    btnCopy.textContent = 'Copy Image';
    btnCopy.style.cssText = btnStyle.replace('#e94560', '#0984e3');
    btnCopy.onmouseenter = function () { btnCopy.style.background = '#74b9ff'; };
    btnCopy.onmouseleave = function () { btnCopy.style.background = '#0984e3'; };
    btnCopy.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      copyImageToClipboard(imageUrl, btnCopy);
    });

    wrapper.appendChild(btnUse);
    wrapper.appendChild(btnCopy);
    parent.appendChild(wrapper);
    console.log('[MemeCSE] Injected buttons | url:', imageUrl.substring(0, 120));
  }

  /**
   * Fetch an image URL, convert to PNG blob, and write to clipboard.
   * Shows feedback on the button to confirm success/failure.
   */
  async function copyImageToClipboard(imageUrl, btn) {
    var original = btn.textContent;
    btn.textContent = 'Copying…';
    btn.disabled = true;
    try {
      // Use the CORS proxy from loadImage to fetch the image
      var proxied = 'https://corsproxy.io/?' + encodeURIComponent(imageUrl);
      var img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise(function (resolve, reject) {
        img.onload = resolve;
        img.onerror = function () { reject(new Error('Failed to load image')); };
        img.src = proxied;
      });
      var c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      var blob = await new Promise(function (resolve) { c.toBlob(resolve, 'image/png'); });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      btn.textContent = 'Copied!';
      console.log('[MemeCSE] Image copied to clipboard');
    } catch (err) {
      console.error('[MemeCSE] Copy failed:', err);
      btn.textContent = 'Copy failed';
    }
    setTimeout(function () { btn.textContent = original; btn.disabled = false; }, 2000);
  }

  /**
   * Scan the CSE container for expanded preview panels and inject buttons.
   * Targets: expansion areas, image popups, any element with large images.
   */
  function scanForPreviews() {
    var cse = document.getElementById('cse-container');
    if (!cse) return;

    // 1. Check known CSE expansion/preview selectors
    var selectors = [
      '.gsc-expansionArea',
      '.gs-image-popup-box',
      '.gsc-modal-background-image-visible',
      '.gs-result-image-popup',
      '.gs-imagePreviewArea',
    ];
    for (var s = 0; s < selectors.length; s++) {
      var panels = cse.querySelectorAll(selectors[s]);
      for (var i = 0; i < panels.length; i++) {
        if (panels[i].dataset.memeBtnScanned) continue;
        panels[i].dataset.memeBtnScanned = 'true';
        console.log('[MemeCSE] Found preview panel:', selectors[s]);
        var url = findOriginalImageUrl(panels[i]);
        if (url) injectTemplateButton(url, panels[i]);
      }
    }

    // 2. Check for any element that contains a large, non-cached image
    //    (catches preview panels with unexpected class names)
    var allImgs = cse.querySelectorAll('img');
    for (var i = 0; i < allImgs.length; i++) {
      var img = allImgs[i];
      if (img.dataset.memeBtnScanned) continue;
      var w = img.naturalWidth || img.width || 0;
      var h = img.naturalHeight || img.height || 0;
      if (w > 300 || h > 300) {
        var src = img.getAttribute('data-ctorig') || img.getAttribute('data-src') || img.src || '';
        if (src && !src.includes('encrypted-tbn') && !src.includes('gstatic.com/images')) {
          img.dataset.memeBtnScanned = 'true';
          var parent = img.closest('.gsc-expansionArea') ||
                       img.closest('.gs-result') ||
                       img.closest('.gsc-webResult') ||
                       img.parentElement;
          if (parent) {
            console.log('[MemeCSE] Large image found:', w, 'x', h, '| src:', src.substring(0, 80));
            injectTemplateButton(src, parent);
          }
        }
      }
    }
  }

  /**
   * Log all CSE-related elements for debugging (helps identify the exact
   * class names used for preview panels).
   */
  function logCSEElement(node) {
    if (!node.className) return;
    var cls = node.className.toString();
    if (cls.includes('gsc-') || cls.includes('gs-')) {
      var imgCount = node.querySelectorAll ? node.querySelectorAll('img').length : 0;
      var linkCount = node.querySelectorAll ? node.querySelectorAll('a').length : 0;
      console.log('[MemeCSE] DOM+', node.tagName, cls.substring(0, 100),
        '| imgs:', imgCount, '| links:', linkCount,
        '| size:', node.offsetWidth, 'x', node.offsetHeight);
    }
  }

  function setupCSEObserver() {
    var cse = document.getElementById('cse-container');
    if (!cse) return;

    var scanTimer = null;
    function debouncedScan() {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(scanForPreviews, 150);
    }

    // MutationObserver: watches for DOM changes in the CSE container
    var observer = new MutationObserver(function (mutations) {
      var dominated = false;
      for (var m = 0; m < mutations.length; m++) {
        var added = mutations[m].addedNodes;
        for (var n = 0; n < added.length; n++) {
          var node = added[n];
          if (node.nodeType !== 1) continue;
          dominated = true;
          logCSEElement(node);
        }
      }
      if (dominated) debouncedScan();
    });
    observer.observe(cse, { childList: true, subtree: true });

    // Also scan on clicks (catches preview panels shown via CSS, not DOM changes)
    cse.addEventListener('click', function () {
      setTimeout(scanForPreviews, 300);
      setTimeout(scanForPreviews, 800);
    }, true);

    console.log('[MemeCSE] Observer active');
  }

  // Configure __gcse BEFORE loading the CSE script.
  window.__gcse = {
    parsetags: 'onready',
    callback: function () {
      setupCSEObserver();
      console.log('[MemeCSE] CSE ready');
    },
    searchCallbacks: {
      web: {
        // 'ready' fires with raw result objects — store data for reference
        ready: function (_name, _q, _promos, results) {
          console.log('[MemeCSE] ready:', results && results.length, 'results');
          cseResultsData = (results || []).map(function (r) {
            var img = null;
            try { img = r.richSnippet.cseImage.src; } catch (e) {}
            if (!img) { try { img = r.richSnippet.metatags['og:image']; } catch (e) {} }
            if (!img) { try { img = r.richSnippet.metatags['twitter:image']; } catch (e) {} }
            var thumb = null;
            try { thumb = r.richSnippet.cseThumbnail.src; } catch (e) {}
            console.log('[MemeCSE] result:', (r.unescapedUrl || r.url || '').substring(0, 80),
              '| img:', img ? img.substring(0, 80) : 'null',
              '| thumb:', thumb ? thumb.substring(0, 80) : 'null');
            return { imageUrl: img, thumbnailUrl: thumb, pageUrl: r.unescapedUrl || r.url };
          });
        },
      },
    },
  };

  // Dynamically load the CSE script (must happen AFTER __gcse is set)
  (function () {
    var s = document.createElement('script');
    s.src = 'https://cse.google.com/cse.js?cx=262c9d0e5c0b94398';
    s.async = true;
    document.head.appendChild(s);
  })();

  // ========== Keyboard shortcuts ==========
  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      redo();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedTextId) {
        state.texts = state.texts.filter(t => t.id !== state.selectedTextId);
        state.selectedTextId = null;
        updateTextOptionsVisibility();
        render();
        snapshot();
      }
    }
  });

  // ========== Save ==========
  btnSave.addEventListener('click', saveAsImage);

  function saveAsImage() {
    if (!state.imageLoaded) return;

    // Deselect text to remove selection indicator
    const prevSelected = state.selectedTextId;
    state.selectedTextId = null;
    render();

    function restoreSelection() {
      state.selectedTextId = prevSelected;
      render();
    }

    // Use toBlob for better compatibility
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          // Fallback to toDataURL
          try {
            const dataUrl = canvas.toDataURL('image/png');
            downloadDataUrl(dataUrl, 'meme.png');
          } catch (err) {
            alert('Cannot save image due to cross-origin restrictions. Try uploading the template image directly instead.');
          }
        } else {
          const url = URL.createObjectURL(blob);
          downloadDataUrl(url, 'meme.png');
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
        restoreSelection();
      }, 'image/png');
    } catch (err) {
      // toBlob itself can throw SecurityError on tainted canvas
      alert('Cannot save image due to cross-origin restrictions. Try uploading the template image directly instead.');
      restoreSelection();
    }
  }

  function downloadDataUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ========== Init ==========
  setTool('select');
  resizeCanvas();

})();
