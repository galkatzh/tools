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

  function loadImage(src) {
    showLoading();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
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
      hideLoading();
      // Try proxy fallback for CORS issues
      if (!src.includes('images1-focus-opensocial') && !src.includes('corsproxy') && !src.startsWith('data:')) {
        loadImage('https://corsproxy.io/?' + encodeURIComponent(src));
      } else {
        alert('Failed to load image. The image may be protected or unavailable.');
      }
    };
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

  // ========== Search modal ==========
  btnSearch.addEventListener('click', openSearchModal);
  btnGetStarted.addEventListener('click', openSearchModal);

  function openSearchModal() {
    searchModal.classList.remove('hidden');
    setupCSEImageInterception();
  }

  function closeSearchModal() {
    searchModal.classList.add('hidden');
  }

  btnCloseSearch.addEventListener('click', closeSearchModal);
  searchModal.addEventListener('click', (e) => {
    if (e.target === searchModal) closeSearchModal();
  });

  // ========== CSE Integration ==========
  // The key challenge: intercept clicks on CSE image results and load them onto canvas
  // We use a MutationObserver to watch for search results and inject click handlers

  let cseObserver = null;

  function setupCSEImageInterception() {
    const cseContainer = document.getElementById('cse-container');

    // Inject a "Use this image" button overlay on image results
    function processResults() {
      // Target image result thumbnails in CSE
      const images = cseContainer.querySelectorAll('.gs-image-box img, .gs-image img, img.gs-image');
      images.forEach((img) => {
        if (img.dataset.memeProcessed) return;
        img.dataset.memeProcessed = 'true';

        // Wrap or add click handler
        const wrapper = img.closest('a') || img.parentElement;
        const useBtn = document.createElement('div');
        useBtn.textContent = '✓ Use';
        useBtn.style.cssText = `
          position: absolute; bottom: 2px; right: 2px;
          background: #e94560; color: #fff; padding: 2px 8px;
          border-radius: 4px; font-size: 11px; font-weight: bold;
          cursor: pointer; z-index: 100; opacity: 0.9;
          pointer-events: auto;
        `;

        // Make parent positioned
        const parent = img.parentElement;
        if (parent) {
          parent.style.position = 'relative';
          parent.appendChild(useBtn);
        }

        function loadFromResult(e) {
          e.preventDefault();
          e.stopPropagation();
          // Try to get the full-res image URL
          // CSE stores the original URL in data attributes or parent anchor href
          let fullUrl = '';
          const anchor = img.closest('a[href]');
          if (anchor) {
            // The href might be google redirect, try to extract image URL
            const href = anchor.href;
            // Check for direct image link
            if (/\.(jpg|jpeg|png|gif|webp|bmp)/i.test(href)) {
              fullUrl = href;
            }
          }
          // Try data-ctorig (original image URL from CSE)
          if (!fullUrl) {
            const ctorigEl = img.closest('[data-ctorig]') || img.closest('.gsc-result, .gs-result');
            if (ctorigEl) {
              const ctorig = ctorigEl.getAttribute('data-ctorig');
              if (ctorig) fullUrl = ctorig;
            }
          }
          // Fallback: use the thumbnail src or data-src
          if (!fullUrl) {
            fullUrl = img.getAttribute('data-ctorig') || img.getAttribute('data-src') || img.src;
          }
          // CSE thumbnails are often encoded.google.com URLs, get original
          if (fullUrl.includes('encrypted-tbn') || fullUrl.includes('gstatic.com')) {
            // Try to find the link to the actual page with image
            const resultParent = img.closest('.gsc-result, .gs-result, [data-cturl]');
            if (resultParent) {
              const dataUrl = resultParent.getAttribute('data-cturl');
              if (dataUrl) fullUrl = dataUrl;
            }
          }

          if (fullUrl) {
            closeSearchModal();
            loadImage(fullUrl);
          }
        }

        useBtn.addEventListener('click', loadFromResult);
        useBtn.addEventListener('touchend', (e) => {
          e.preventDefault();
          loadFromResult(e);
        });
      });

      // Also intercept full result links for image loading
      const resultLinks = cseContainer.querySelectorAll('a.gs-title, a.gs-image');
      resultLinks.forEach((link) => {
        if (link.dataset.memeProcessed) return;
        link.dataset.memeProcessed = 'true';
        link.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const imgUrl = link.getAttribute('data-ctorig') || link.href;
          if (imgUrl) {
            closeSearchModal();
            loadImage(imgUrl);
          }
        });
      });
    }

    // Use MutationObserver to catch dynamically loaded results
    if (cseObserver) cseObserver.disconnect();
    cseObserver = new MutationObserver(() => {
      processResults();
      injectCSEResultHandlers();
    });
    cseObserver.observe(cseContainer, { childList: true, subtree: true });

    // Also run once now
    processResults();
    injectCSEResultHandlers();
  }

  // Deeper integration: override CSE result rendering to add load-to-canvas buttons
  function injectCSEResultHandlers() {
    const cseContainer = document.getElementById('cse-container');

    // Find all search result items and intercept their clicks
    const results = cseContainer.querySelectorAll('.gsc-thumbnail-inside a[data-ctorig], .gs-title a, .gsc-url-top a');
    results.forEach((a) => {
      if (a.dataset.memeHandled) return;
      a.dataset.memeHandled = 'true';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const imgUrl = a.getAttribute('data-ctorig') || a.href;
        if (imgUrl) {
          closeSearchModal();
          loadImage(imgUrl);
        }
      });
    });

    // The most reliable approach: find all visible images and their parent result
    // containers, and add "Use as Template" buttons
    const allResults = cseContainer.querySelectorAll('.gsc-webResult, .gsc-imageResult, .gs-webResult, .gs-imageResult');
    allResults.forEach((result) => {
      if (result.dataset.memeBtn) return;
      result.dataset.memeBtn = 'true';

      // Find image in this result
      const img = result.querySelector('img');
      const titleLink = result.querySelector('a[data-ctorig]') || result.querySelector('a.gs-title') || result.querySelector('a');

      if (!img && !titleLink) return;

      const btn = document.createElement('button');
      btn.textContent = 'Use as Template';
      btn.style.cssText = `
        display: block; margin: 4px 0;
        background: #e94560; color: #fff; border: none;
        padding: 6px 12px; border-radius: 4px; font-size: 12px;
        font-weight: bold; cursor: pointer; width: 100%;
      `;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        let imgUrl = '';

        // Strategy 1: Get original image URL from data attributes
        if (titleLink) {
          imgUrl = titleLink.getAttribute('data-ctorig') || titleLink.href || '';
        }

        // Strategy 2: Use img src
        if (!imgUrl && img) {
          imgUrl = img.getAttribute('data-src') || img.src;
        }

        // Strategy 3: Find any image URL in the result
        if (!imgUrl) {
          const allAnchors = result.querySelectorAll('a[href]');
          for (const a of allAnchors) {
            if (/\.(jpg|jpeg|png|gif|webp)/i.test(a.href)) {
              imgUrl = a.href;
              break;
            }
          }
        }

        if (imgUrl) {
          closeSearchModal();
          loadImage(imgUrl);
        }
      });

      // Insert button after the result content
      result.appendChild(btn);
    });
  }

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
