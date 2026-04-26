/* PDF Form Filler — uses pdf-lib for form I/O, PDF.js for preview */

const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

// ── State ──────────────────────────────────────────────────────────────────
let pdfDoc = null;      // pdf-lib PDFDocument

// ── DOM refs ───────────────────────────────────────────────────────────────
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const app          = document.getElementById('app');
const fieldsList   = document.getElementById('fields-list');
const previewPanel = document.getElementById('preview-panel');
const previewLoad  = document.getElementById('preview-loading');
const btnLoadNew   = document.getElementById('btn-load-new');
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

// ── Load PDF ───────────────────────────────────────────────────────────────
async function openFile(file) {
  try {
    const bytes = await file.arrayBuffer();
    pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    dropZone.style.display = 'none';
    app.classList.add('visible');
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
      // Unknown field type — skip silently but note in console
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
  // Clear previous canvases but keep the loading indicator
  for (const node of [...previewPanel.children]) {
    if (node !== previewLoad) node.remove();
  }
  previewLoad.textContent = 'Rendering preview…';
  previewLoad.style.display = '';

  try {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    previewLoad.style.display = 'none';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page     = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });

      const canvas  = document.createElement('canvas');
      const ctx     = canvas.getContext('2d');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport }).promise;
      previewPanel.appendChild(canvas);
    }
  } catch (err) {
    console.error('Preview render failed:', err);
    previewLoad.textContent = 'Preview unavailable.';
  }
}

// ── Collect field values and return a filled pdf-lib document ──────────────
async function buildFilledDoc(flatten = false) {
  // Reload a fresh copy so we don't accumulate mutations on repeated saves
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
        const selected = [...input.selectedOptions].map(o => o.value);
        if (selected.length) form.getOptionList(name).select(selected[0]);
      }
    } catch (err) {
      console.error(`Could not set field "${name}":`, err);
    }
  }

  if (flatten) form.flatten();
  return freshDoc;
}

// ── Download ───────────────────────────────────────────────────────────────
async function downloadPDF(flatten) {
  try {
    const doc   = await buildFilledDoc(flatten);
    const bytes = await doc.save();
    const blob  = new Blob([bytes], { type: 'application/pdf' });
    const url   = URL.createObjectURL(blob);

    const a      = document.createElement('a');
    a.href       = url;
    a.download   = flatten ? 'filled-flattened.pdf' : 'filled-form.pdf';
    a.click();

    // Refresh preview with the filled bytes
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
