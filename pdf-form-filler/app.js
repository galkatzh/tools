/* PDF Form Filler — uses pdf-lib for form I/O, PDF.js for preview */

const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
        StandardFonts, rgb } = PDFLib;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

// ── State ──────────────────────────────────────────────────────────────────
let pdfDoc       = null;  // pdf-lib PDFDocument
let textMode     = false;
let annotations  = [];    // { id, pageIndex, pdfX, pdfY, text, fontSize, color }
let nextAnnotId  = 0;
let pageViewports = [];   // { scale, pdfHeight } indexed by 0-based page

// ── DOM refs ───────────────────────────────────────────────────────────────
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const app          = document.getElementById('app');
const fieldsList   = document.getElementById('fields-list');
const previewPanel = document.getElementById('preview-panel');
const previewLoad  = document.getElementById('preview-loading');
const btnLoadNew   = document.getElementById('btn-load-new');
const btnAddText   = document.getElementById('btn-add-text');
const btnDownload  = document.getElementById('btn-download');
const btnFlatten   = document.getElementById('btn-flatten');
const errorToast   = document.getElementById('error-toast');

// ── Drop zone ──────────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file?.type === 'application/pdf') openFile(file);
  else showError('Please drop a PDF file.');
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) openFile(e.target.files[0]); });

btnLoadNew.addEventListener('click', () => fileInput.click());

btnAddText.addEventListener('click', () => {
  textMode = !textMode;
  btnAddText.classList.toggle('active', textMode);
  previewPanel.classList.toggle('text-mode', textMode);
});

// ── Load PDF ───────────────────────────────────────────────────────────────
async function openFile(file) {
  try {
    const bytes = await file.arrayBuffer();
    pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    // Reset annotation state for the new document
    annotations = [];
    nextAnnotId = 0;
    pageViewports = [];

    dropZone.style.display = 'none';
    app.classList.add('visible');
    btnAddText.style.display  = 'inline-block';
    btnDownload.style.display = 'inline-block';
    btnFlatten.style.display  = 'inline-block';

    renderFields();
    renderPreview(bytes);
  } catch (err) {
    console.error('Failed to load PDF:', err);
    showError('Could not open PDF. It may be encrypted or corrupted.');
  }
}

// ── Render form fields ─────────────────────────────────────────────────────
function renderFields() {
  fieldsList.innerHTML = '';
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  if (fields.length === 0) {
    fieldsList.innerHTML = '<p class="no-fields">No interactive form fields found in this PDF.</p>';
    return;
  }

  for (const field of fields) {
    const group = document.createElement('div');
    group.className = 'field-group';

    const label = document.createElement('label');
    const name  = field.getName();
    label.title = name;

    const badge = document.createElement('span');
    badge.className = 'field-type-badge';

    let input = null;

    if (field instanceof PDFTextField) {
      badge.textContent = field.isMultiline() ? 'multiline' : 'text';
      label.textContent = name + ' ';
      label.appendChild(badge);

      if (field.isMultiline()) {
        input = document.createElement('textarea');
        input.value = field.getText() ?? '';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = field.getText() ?? '';
      }
      input.dataset.fieldName = name;
      input.dataset.fieldType = 'text';

    } else if (field instanceof PDFCheckBox) {
      badge.textContent = 'checkbox';
      label.textContent = name + ' ';
      label.appendChild(badge);

      const row = document.createElement('div');
      row.className = 'checkbox-row';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = field.isChecked();
      input.dataset.fieldName = name;
      input.dataset.fieldType = 'checkbox';
      row.appendChild(input);
      group.appendChild(label);
      group.appendChild(row);
      fieldsList.appendChild(group);
      continue;

    } else if (field instanceof PDFRadioGroup) {
      badge.textContent = 'radio';
      label.textContent = name + ' ';
      label.appendChild(badge);

      const options  = field.getOptions();
      const selected = field.getSelected();
      const container = document.createElement('div');
      container.className = 'radio-group';

      for (const opt of options) {
        const optLabel = document.createElement('label');
        optLabel.className = 'radio-option';
        const radio = document.createElement('input');
        radio.type  = 'radio';
        radio.name  = name;
        radio.value = opt;
        radio.checked = opt === selected;
        radio.dataset.fieldName = name;
        radio.dataset.fieldType = 'radio';
        optLabel.appendChild(radio);
        optLabel.appendChild(document.createTextNode(opt));
        container.appendChild(optLabel);
      }

      group.appendChild(label);
      group.appendChild(container);
      fieldsList.appendChild(group);
      continue;

    } else if (field instanceof PDFDropdown) {
      badge.textContent = 'dropdown';
      label.textContent = name + ' ';
      label.appendChild(badge);

      input = document.createElement('select');
      input.dataset.fieldName = name;
      input.dataset.fieldType = 'dropdown';
      const selected = field.getSelected();

      for (const opt of field.getOptions()) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        o.selected = selected.includes(opt);
        input.appendChild(o);
      }

    } else if (field instanceof PDFOptionList) {
      badge.textContent = 'list';
      label.textContent = name + ' ';
      label.appendChild(badge);

      input = document.createElement('select');
      input.multiple = true;
      input.dataset.fieldName = name;
      input.dataset.fieldType = 'optionlist';
      const selected = field.getSelected();

      for (const opt of field.getOptions()) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        o.selected = selected.includes(opt);
        input.appendChild(o);
      }

    } else {
      console.info('Unsupported field type:', field.constructor.name, name);
      continue;
    }

    group.appendChild(label);
    if (input) group.appendChild(input);
    fieldsList.appendChild(group);
  }
}

// ── Render PDF preview via PDF.js ──────────────────────────────────────────
async function renderPreview(arrayBuffer) {
  // Detach existing annotation elements so we can re-attach after re-render
  const existingAnnotEls = [...previewPanel.querySelectorAll('.text-annotation')];

  for (const node of [...previewPanel.children]) {
    if (node !== previewLoad) node.remove();
  }
  previewLoad.textContent = 'Rendering preview…';
  previewLoad.style.display = '';

  try {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    previewLoad.style.display = 'none';
    pageViewports = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const pageIndex = i - 1;
      const page      = await pdf.getPage(i);
      const scale     = 1.5;
      const viewport  = page.getViewport({ scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrapper';
      wrapper.dataset.pageIndex = pageIndex;
      wrapper.style.width = viewport.width + 'px';

      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

      wrapper.appendChild(canvas);
      wrapper.addEventListener('click', handlePreviewClick);
      previewPanel.appendChild(wrapper);

      pageViewports[pageIndex] = { scale, pdfHeight: page.getViewport({ scale: 1 }).height };

      // Re-attach any annotations that belong to this page
      for (const el of existingAnnotEls) {
        if (parseInt(el.dataset.pageIndex) === pageIndex) wrapper.appendChild(el);
      }
    }
  } catch (err) {
    console.error('Preview render failed:', err);
    previewLoad.textContent = 'Preview unavailable.';
  }
}

// ── Text annotation placement ──────────────────────────────────────────────
function handlePreviewClick(e) {
  if (!textMode) return;
  if (e.target.closest('.text-annotation')) return;

  const wrapper   = e.currentTarget;
  const pageIndex = parseInt(wrapper.dataset.pageIndex);
  const rect      = wrapper.getBoundingClientRect();
  const canvasX   = e.clientX - rect.left;
  const canvasY   = e.clientY - rect.top;

  const { scale, pdfHeight } = pageViewports[pageIndex];
  const pdfX = canvasX / scale;
  const pdfY = pdfHeight - canvasY / scale; // PDF y-axis is flipped

  const annot = { id: nextAnnotId++, pageIndex, pdfX, pdfY, text: '', fontSize: 12, color: '#000000' };
  annotations.push(annot);

  const el = createAnnotationEl(annot);
  el.style.left = canvasX + 'px';
  el.style.top  = canvasY + 'px';
  wrapper.appendChild(el);
  el.querySelector('textarea').focus();
}

function createAnnotationEl(annot) {
  const el = document.createElement('div');
  el.className = 'text-annotation';
  el.dataset.annotId   = annot.id;
  el.dataset.pageIndex = annot.pageIndex;

  // ── Header: grip + controls ──
  const header = document.createElement('div');
  header.className = 'annot-header';

  const grip = document.createElement('span');
  grip.className = 'annot-grip';
  grip.textContent = '⠿';
  grip.title = 'Drag to move';

  const sizeSelect = document.createElement('select');
  sizeSelect.className = 'annot-size';
  for (const s of [8, 10, 12, 14, 16, 20, 24, 32, 48]) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s; opt.selected = s === annot.fontSize;
    sizeSelect.appendChild(opt);
  }

  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.className = 'annot-color';
  colorPicker.value = annot.color;

  const delBtn = document.createElement('button');
  delBtn.className = 'annot-delete';
  delBtn.textContent = '×';
  delBtn.title = 'Delete annotation';
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    annotations = annotations.filter(a => a.id !== annot.id);
    el.remove();
  });

  header.append(grip, sizeSelect, colorPicker, delBtn);

  // ── Textarea ──
  const ta = document.createElement('textarea');
  ta.className = 'annot-textarea';
  ta.placeholder = 'Type here…';
  ta.rows = 1;
  ta.style.fontSize = annot.fontSize + 'px';
  ta.style.color    = annot.color;

  sizeSelect.addEventListener('change', () => {
    annot.fontSize = parseInt(sizeSelect.value);
    ta.style.fontSize = annot.fontSize + 'px';
  });
  colorPicker.addEventListener('input', () => {
    annot.color = colorPicker.value;
    ta.style.color = annot.color;
  });
  ta.addEventListener('input', () => {
    annot.text = ta.value;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  });

  el.append(header, ta);
  makeDraggable(el, grip, annot);
  return el;
}

/** Drag annotation by its grip handle; updates annot.pdfX/pdfY on release. */
function makeDraggable(el, grip, annot) {
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startX    = e.clientX;
    const startY    = e.clientY;
    const startLeft = parseFloat(el.style.left) || 0;
    const startTop  = parseFloat(el.style.top)  || 0;
    grip.setPointerCapture(e.pointerId);
    grip.style.cursor = 'grabbing';

    function onMove(e) {
      el.style.left = (startLeft + e.clientX - startX) + 'px';
      el.style.top  = (startTop  + e.clientY - startY) + 'px';
    }
    function onUp() {
      grip.style.cursor = 'grab';
      const { scale, pdfHeight } = pageViewports[annot.pageIndex];
      annot.pdfX = parseFloat(el.style.left) / scale;
      annot.pdfY = pdfHeight - parseFloat(el.style.top) / scale;
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup',   onUp);
    }
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup',   onUp);
  });
}

// ── Collect field values + annotations → filled pdf-lib document ───────────
async function buildFilledDoc(flatten = false) {
  const origBytes = await pdfDoc.save();
  const freshDoc  = await PDFDocument.load(origBytes);
  const form      = freshDoc.getForm();

  for (const input of fieldsList.querySelectorAll('[data-field-name]')) {
    const name = input.dataset.fieldName;
    const type = input.dataset.fieldType;
    try {
      if (type === 'text') {
        form.getTextField(name).setText(input.value || '');
      } else if (type === 'checkbox') {
        const cb = form.getCheckBox(name);
        input.checked ? cb.check() : cb.uncheck();
      } else if (type === 'radio' && input.checked) {
        form.getRadioGroup(name).select(input.value);
      } else if (type === 'dropdown') {
        form.getDropdown(name).select(input.value);
      } else if (type === 'optionlist') {
        const sel = [...input.selectedOptions].map(o => o.value);
        if (sel.length) form.getOptionList(name).select(sel[0]);
      }
    } catch (err) {
      console.error(`Could not set field "${name}":`, err);
    }
  }

  if (flatten) form.flatten();

  // Draw free-text annotations onto the page content
  const activeAnnots = annotations.filter(a => a.text.trim());
  if (activeAnnots.length > 0) {
    const helvetica = await freshDoc.embedFont(StandardFonts.Helvetica);

    for (const annot of activeAnnots) {
      const page       = freshDoc.getPage(annot.pageIndex);
      const lineHeight = annot.fontSize * 1.2;
      const r = parseInt(annot.color.slice(1, 3), 16) / 255;
      const g = parseInt(annot.color.slice(3, 5), 16) / 255;
      const b = parseInt(annot.color.slice(5, 7), 16) / 255;
      const color = rgb(r, g, b);

      annot.text.split('\n').forEach((line, i) => {
        page.drawText(line || ' ', {
          x: annot.pdfX,
          y: annot.pdfY - i * lineHeight,
          font: helvetica,
          size: annot.fontSize,
          color,
        });
      });
    }
  }

  return freshDoc;
}

// ── Download ───────────────────────────────────────────────────────────────
async function downloadPDF(flatten) {
  try {
    const doc   = await buildFilledDoc(flatten);
    const bytes = await doc.save();
    const blob  = new Blob([bytes], { type: 'application/pdf' });
    const url   = URL.createObjectURL(blob);

    const a  = document.createElement('a');
    a.href   = url;
    a.download = flatten ? 'filled-flattened.pdf' : 'filled-form.pdf';
    a.click();

    renderPreview(bytes);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Download failed:', err);
    showError('Failed to generate PDF. Check the console for details.');
  }
}

btnDownload.addEventListener('click', () => downloadPDF(false));
btnFlatten.addEventListener('click',  () => downloadPDF(true));

// ── Error toast ────────────────────────────────────────────────────────────
function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.add('show');
  setTimeout(() => errorToast.classList.remove('show'), 4000);
}
