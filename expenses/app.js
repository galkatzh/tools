// Expense Report Manager - PWA Application
// Expenses (including their receipt files, as data URLs) live in IndexedDB.

const DB_NAME = 'ExpenseReportDB';
const DB_VERSION = 2;
const STORE_NAME = 'expenses';
const SETTINGS_STORE = 'settings';    // key/value; holds the auto-backup folder handle
const SHARE_CACHE = 'expense-share';   // filled by sw.js when files are shared into the app — keep in sync
const BACKUP_KEY = 'expenses-backup';  // localStorage: { at: ISO date of last backup | null, changes: n since }
const CURRENCY_KEY = 'expenses-currency';
const AUTO_BACKUP_KEEP = 14;           // daily ZIPs kept in the auto-backup folder
const AUTO_BACKUP_NAME = /^expenses-backup-\d{4}-\d{2}-\d{2}\.zip$/;

const $ = (id) => document.getElementById(id);

const ICONS = {
    pdf: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>`,
    trash: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`,
    grip: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`,
    receipt: `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .7V2l-1 .7-3-2-3 2-3-2-3 2-3-2zM8 8h8M8 12h8M8 16h5"/></svg>`
};

/** Show a transient message at the bottom of the screen, optionally with an action button ({ label, run }). */
function toast(message, type = '', action = null) {
    const el = $('toast');
    el.className = `toast ${type}`;
    el.replaceChildren(message);
    if (action) {
        const button = Object.assign(document.createElement('button'), { className: 'toast-action', textContent: action.label });
        button.onclick = () => { el.hidden = true; action.run(); };
        el.append(button);
    }
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, action ? 8000 : type === 'error' ? 6000 : 3000);
}

addEventListener('error', (e) => { console.error(e.error || e.message); toast(`Error: ${e.message}`, 'error'); });
addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(`Error: ${e.reason?.message ?? e.reason}`, 'error'); });

/** Show (text) or hide (false) the full-screen busy overlay. */
function busy(text) {
    $('loadingOverlay').hidden = !text;
    if (text) $('loadingText').textContent = text;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Parse a YYYY-MM-DD string as a *local* date (new Date('2024-01-02') would be UTC midnight). */
const localDate = (date) => new Date(`${date}T00:00`);

const formatDate = (date, month = 'long') =>
    localDate(date).toLocaleDateString('en-US', { year: 'numeric', month, day: 'numeric' });

function formatTime(time) {
    if (!time) return null;
    const [hours, minutes] = time.split(':');
    const hour = parseInt(hours);
    return `${hour % 12 || 12}:${minutes} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Format a monetary amount using the browser's Intl API (for UI display). */
function formatAmount(amount, currency) {
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch (e) {
        console.error(`Cannot format currency ${currency}:`, e);
        return `${currency} ${amount.toFixed(2)}`;
    }
}

/**
 * Format a monetary amount for PDF embedding.
 * pdf-lib standard fonts only support WinAnsi (Latin-1), so we use the
 * currency code instead of a locale symbol to avoid encoding errors (e.g. ₪).
 */
const formatAmountForPDF = (amount, currency) => `${currency} ${amount.toFixed(2)}`;

const hasAmount = (e) => e.amount !== null && e.amount !== undefined && e.currency;

/** Sum amounts per currency: { USD: 12.5, ILS: 40 }. */
function currencyTotals(expenses) {
    const totals = {};
    for (const e of expenses.filter(hasAmount)) totals[e.currency] = (totals[e.currency] || 0) + e.amount;
    return totals;
}

/** "3 days ago", "yesterday", "just now". */
function timeAgo(iso) {
    const seconds = (Date.now() - new Date(iso)) / 1000;
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
        if (seconds >= n) return rtf.format(-Math.floor(seconds / n), unit);
    }
    return 'just now';
}

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function dataUrlToUint8Array(dataUrl) {
    const binary = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function getImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.width, height: img.height });
        img.onerror = () => reject(new Error('Could not decode image'));
        img.src = dataUrl;
    });
}

/**
 * Clipboard images arrive nameless and as (often huge) PNGs — an iPhone photo copied from
 * Photos is ~15 MB as PNG. Re-encode as a named JPEG capped at 2400px to keep storage and PDFs small.
 */
async function pastedImageToFile(blob) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const canvas = Object.assign(document.createElement('canvas'), {
        width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale)
    });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNG areas would otherwise turn black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', 0.85));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    return new File([jpeg], `pasted-${stamp}.jpg`, { type: 'image/jpeg' });
}

class ExpenseManager {
    constructor() {
        this.db = null;
        this.expenses = [];
        this.queue = [];          // files waiting to become expenses; the form edits queue[0]
        this.previewUrl = null;   // object URL for the queued file's thumbnail
        this.backupFile = null;   // prepared backup ZIP (see openBackup)
        this.persisted = null;    // whether the browser promised not to evict our storage
        this.backupDir = null;    // FileSystemDirectoryHandle for auto-backups (desktop Chrome/Edge)
        this.autoBackupStatus = 'off'; // 'off' | 'on' | 'paused' (folder chosen, but permission must be re-granted)
        this.autoBackupRun = Promise.resolve(); // serializes folder writes
        this.init();
    }

    async init() {
        this.setupEventListeners();
        this.resetForm();
        await this.initDB();
        await this.loadExpenses();
        this.renderBackupStatus();
        await this.initAutoBackup();
        await this.receiveShared();
        this.registerServiceWorker();
        // Ask the browser not to evict IndexedDB under storage pressure (Safari otherwise may after 7 days of no use).
        this.persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
    }

    // ---------- IndexedDB ----------

    initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => { this.db = request.result; resolve(); };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('date', 'date', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE);
            };
        });
    }

    /** Run fn(store) in one transaction; resolves with fn's request result once the transaction commits. */
    idb(mode, fn, storeName = STORE_NAME) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeName, mode);
            const request = fn(tx.objectStore(storeName));
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = tx.onabort = () => reject(tx.error);
        });
    }

    async loadExpenses() {
        const all = await this.idb('readonly', (s) => s.getAll());
        // Sort by order field if present, otherwise newest first
        this.expenses = all.sort((a, b) =>
            a.order !== undefined && b.order !== undefined ? a.order - b.order : new Date(b.createdAt) - new Date(a.createdAt));
        this.renderExpenses();
    }

    /** Persist the current array order into each expense's `order` field. */
    saveOrder() {
        return this.idb('readwrite', (s) => { this.expenses.forEach((e, i) => { e.order = i; s.put(e); }); });
    }

    // ---------- Event wiring ----------

    setupEventListeners() {
        $('expenseForm').addEventListener('submit', (e) => this.handleFormSubmit(e));
        $('expenseFile').addEventListener('change', (e) => {
            this.enqueue([...e.target.files]);
            e.target.value = '';
        });
        $('skipBtn').addEventListener('click', () => { this.queue.shift(); this.renderQueue(); });

        // Drop files anywhere on the page
        addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            $('dropzone').classList.add('dragover');
        });
        addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('dropzone').classList.remove('dragover'); });
        addEventListener('drop', (e) => {
            $('dropzone').classList.remove('dragover');
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            this.enqueue([...e.dataTransfer.files]);
        });

        // Paste (⌘V / long-press → Paste) images or files anywhere on the page
        addEventListener('paste', async (e) => {
            const files = [...e.clipboardData.files];
            if (!files.length) return; // plain text paste into an input — leave it alone
            e.preventDefault();
            this.enqueue(await Promise.all(files.map((f) => (f.type.startsWith('image/') ? pastedImageToFile(f) : f))));
        });
        if (navigator.clipboard?.read) {
            $('pasteBtn').hidden = false;
            $('pasteBtn').addEventListener('click', () => this.pasteFromClipboard());
        }

        $('expensesList').addEventListener('click', (e) => {
            const card = e.target.closest('.expense');
            if (!card) return;
            const expense = this.expenses[card.dataset.index];
            if (e.target.closest('.delete-btn')) this.deleteExpense(expense);
            else if (e.target.closest('.thumb')) this.view(expense);
        });
        this.setupDragAndDrop($('expensesList'));
        $('viewer').addEventListener('click', () => $('viewer').close());

        $('exportBtn').addEventListener('click', () => this.exportToPDF());
        $('backupBtn').addEventListener('click', () => this.openBackup());
        $('downloadBackupBtn').addEventListener('click', () => this.downloadBackup());
        $('shareBackupBtn').addEventListener('click', () => this.shareBackup());
        $('restoreBtn').addEventListener('click', () => { $('menu').hidePopover(); $('importZipInput').click(); });
        $('importZipInput').addEventListener('change', (e) => {
            if (e.target.files.length) this.importFromZip(e.target.files[0]);
            e.target.value = ''; // allow re-importing the same file
        });
        $('clearAllBtn').addEventListener('click', () => { $('menu').hidePopover(); this.confirmClearAll(); });
        $('expenseCurrency').addEventListener('change', (e) => this.store(CURRENCY_KEY, e.target.value));
        $('chooseFolderBtn').addEventListener('click', () => this.chooseBackupFolder());
        $('resumeBackupBtn').addEventListener('click', () => this.resumeAutoBackup());
        $('stopBackupBtn').addEventListener('click', () => this.stopAutoBackup());
    }

    // ---------- Adding expenses ----------

    /** Queue files (from picker, drop, paste or share sheet) to be filled in one by one via the form. */
    enqueue(files, title = '') {
        const ok = files.filter((f) => f.type.startsWith('image/') || isPdf(f));
        if (ok.length < files.length) toast(`Skipped ${files.length - ok.length} file(s): only images and PDFs are supported`, 'error');
        if (!ok.length) return;
        this.queue.push(...ok);
        if (title && !$('expenseTitle').value) $('expenseTitle').value = title;
        this.renderQueue();
        $('addSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    renderQueue() {
        const file = this.queue[0];
        $('dropzone').hidden = !!file;
        $('pasteBtn').hidden = !!file || !navigator.clipboard?.read;
        $('staged').hidden = !file;
        URL.revokeObjectURL(this.previewUrl);
        if (!file) return;
        this.previewUrl = URL.createObjectURL(file);
        $('stagedThumb').className = `thumb ${isPdf(file) ? 'pdf' : ''}`;
        $('stagedThumb').innerHTML = isPdf(file) ? ICONS.pdf : `<img src="${this.previewUrl}" alt="">`;
        $('stagedName').textContent = file.name;
        $('stagedMeta').textContent = formatFileSize(file.size) + (this.queue.length > 1 ? ` · 1 of ${this.queue.length} to add` : '');
        $('skipBtn').textContent = this.queue.length > 1 ? 'Skip' : 'Remove';
    }

    async pasteFromClipboard() {
        try {
            const files = [];
            for (const item of await navigator.clipboard.read()) {
                const type = item.types.find((t) => t.startsWith('image/') || t === 'application/pdf');
                if (!type) continue;
                const blob = await item.getType(type);
                files.push(type === 'application/pdf' ? new File([blob], 'pasted.pdf', { type }) : await pastedImageToFile(blob));
            }
            if (!files.length) return toast('No image or PDF on the clipboard. Copy one first (Share → Copy).', 'error');
            this.enqueue(files);
        } catch (e) {
            console.error('Clipboard read failed:', e);
            toast(`Could not read clipboard: ${e.message}`, 'error');
        }
    }

    /** Pick up files the service worker stashed after a Web Share Target POST (Android / Chrome). */
    async receiveShared() {
        const params = new URLSearchParams(location.search);
        if (params.has('share-error')) toast(`Sharing failed: ${params.get('share-error')}`, 'error');
        if (params.has('shared') || params.has('share-error')) history.replaceState(null, '', location.pathname);
        if (!('caches' in window) || !(await caches.has(SHARE_CACHE))) return;

        const cache = await caches.open(SHARE_CACHE);
        const files = [];
        for (const request of await cache.keys()) {
            const response = await cache.match(request);
            const name = decodeURIComponent(response.headers.get('X-File-Name') || 'shared-file');
            files.push(new File([await response.blob()], name, { type: response.headers.get('Content-Type') || '' }));
        }
        await caches.delete(SHARE_CACHE);
        if (files.length) {
            this.enqueue(files, params.get('title') || '');
            toast(`Received ${files.length} shared file(s)`, 'success');
        } else {
            toast('The share contained no files', 'error');
        }
    }

    resetForm() {
        const form = $('expenseForm');
        form.reset();
        form.date.value = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
        form.currency.value = this.load(CURRENCY_KEY) || 'USD';
    }

    async handleFormSubmit(event) {
        event.preventDefault();
        const form = event.target;
        const file = this.queue[0];
        if (!file) return toast('Add a receipt (photo or PDF) first', 'error');

        const amount = form.amount.value !== '' ? parseFloat(form.amount.value) : null;
        try {
            const expense = {
                id: Date.now().toString(),
                title: form.title.value.trim(),
                date: form.date.value,
                time: form.time.value || null,
                amount,
                currency: amount !== null ? form.currency.value : null,
                fileName: file.name,
                fileType: isPdf(file) ? 'application/pdf' : file.type,
                fileSize: file.size,
                fileData: await readFileAsDataURL(file),
                order: this.expenses.length,
                createdAt: new Date().toISOString()
            };
            await this.idb('readwrite', (s) => s.add(expense));
            this.expenses.push(expense);
            this.changed();
            this.renderExpenses();
            this.queue.shift();
            this.renderQueue();
            this.resetForm();
            toast(this.queue.length ? `Added — ${this.queue.length} more to go` : 'Expense added', 'success');
        } catch (error) {
            console.error('Error adding expense:', error);
            toast(`Failed to add expense: ${error.message}`, 'error');
        }
    }

    // ---------- List ----------

    renderExpenses() {
        const list = $('expensesList');
        $('expenseCount').textContent = this.expenses.length;
        $('exportBtn').disabled = this.expenses.length === 0;

        const totals = currencyTotals(this.expenses);
        $('currencyTotals').innerHTML = Object.keys(totals).length
            ? Object.entries(totals).map(([c, t]) => `<span class="total">${formatAmount(t, c)}</span>`).join('')
            : '<span class="muted">No amounts yet</span>';

        list.innerHTML = this.expenses.length
            ? this.expenses.map((e, i) => this.createExpenseCard(e, i)).join('')
            : `<li class="empty-state">${ICONS.receipt}<p>No expenses yet.<br>Add a receipt, or share one to this app.</p></li>`;
    }

    createExpenseCard(expense, index) {
        const pdf = expense.fileType === 'application/pdf';
        const meta = [formatDate(expense.date, 'short'), formatTime(expense.time), expense.fileName].filter(Boolean);
        return `
            <li class="expense" draggable="true" data-index="${index}">
                <span class="grip" title="Drag to reorder">${ICONS.grip}</span>
                <button class="thumb ${pdf ? 'pdf' : ''}" title="View receipt">
                    ${pdf ? ICONS.pdf : `<img src="${expense.fileData}" alt="" loading="lazy">`}
                </button>
                <div class="expense-info">
                    <div class="expense-title ellipsis ${expense.title ? '' : 'untitled'}">${esc(expense.title || 'Untitled')}</div>
                    <div class="muted small ellipsis">${meta.map(esc).join(' · ')}</div>
                </div>
                ${hasAmount(expense) ? `<div class="expense-amount">${formatAmount(expense.amount, expense.currency)}</div>` : ''}
                <button class="icon-btn delete-btn" title="Delete expense" aria-label="Delete">${ICONS.trash}</button>
            </li>`;
    }

    /** Images open in an in-page viewer; PDFs in the browser's own PDF viewer. */
    view(expense) {
        if (expense.fileType === 'application/pdf') {
            const blob = new Blob([dataUrlToUint8Array(expense.fileData)], { type: 'application/pdf' });
            if (!window.open(URL.createObjectURL(blob), '_blank')) toast('Popup blocked — allow popups to view PDFs', 'error');
            return;
        }
        $('viewerImg').src = expense.fileData;
        $('viewer').showModal();
    }

    async deleteExpense(expense) {
        const before = [...this.expenses];
        await this.idb('readwrite', (s) => s.delete(expense.id));
        this.expenses = this.expenses.filter((e) => e !== expense);
        this.changed();
        this.renderExpenses();
        this.offerUndo(`Deleted “${expense.title || 'Untitled'}”`, before);
    }

    /**
     * Toast with an Undo button that brings back the expenses of `before` that are gone now, at their old
     * positions; anything added in the meantime stays, after them. Only the latest toast can be undone.
     */
    offerUndo(message, before) {
        toast(message, '', {
            label: 'Undo',
            run: async () => {
                const ids = new Set(before.map((e) => e.id));
                this.expenses = [...before, ...this.expenses.filter((e) => !ids.has(e.id))];
                await this.saveOrder(); // put() re-inserts the deleted records
                this.changed();
                this.renderExpenses();
                toast('Restored', 'success');
            }
        });
    }

    async confirmClearAll() {
        const { changes } = this.backupState();
        const warning = changes ? ` ${changes} change(s) haven't been backed up yet.` : '';
        const ok = await this.ask('Clear all expenses', `Delete all ${this.expenses.length} expenses?${warning}`, [['yes', 'Delete all', 'btn-danger']]);
        if (!ok) return;
        const before = this.expenses;
        await this.idb('readwrite', (s) => s.clear());
        this.expenses = [];
        this.changed();
        this.renderExpenses();
        this.offerUndo('All expenses cleared', before);
    }

    /** HTML5 drag & drop reordering (pointer devices). The drop indicator is drawn above/below the hovered card. */
    setupDragAndDrop(list) {
        let from = null;
        const cardAt = (e) => e.target.closest?.('.expense');
        const clear = () => list.querySelectorAll('.drag-over-top, .drag-over-bottom')
            .forEach((c) => c.classList.remove('drag-over-top', 'drag-over-bottom'));
        const below = (card, e) => { const r = card.getBoundingClientRect(); return e.clientY >= r.top + r.height / 2; };

        list.addEventListener('dragstart', (e) => {
            const card = cardAt(e);
            if (!card) return;
            from = +card.dataset.index;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', ''); // Firefox requires data to start a drag
        });
        list.addEventListener('dragend', (e) => { cardAt(e)?.classList.remove('dragging'); clear(); from = null; });
        list.addEventListener('dragover', (e) => {
            const card = cardAt(e);
            if (from === null || !card) return;
            e.preventDefault();
            e.stopPropagation(); // not a file drop
            clear();
            if (+card.dataset.index !== from) card.classList.add(below(card, e) ? 'drag-over-bottom' : 'drag-over-top');
        });
        list.addEventListener('drop', async (e) => {
            const card = cardAt(e);
            if (from === null || !card) return;
            e.preventDefault();
            e.stopPropagation();
            clear();
            const to = +card.dataset.index;
            if (to === from) return;
            const [item] = this.expenses.splice(from, 1);
            // Index of the target after removal, then insert before or after it
            const target = to - (from < to ? 1 : 0);
            this.expenses.splice(target + (below(card, e) ? 1 : 0), 0, item);
            await this.saveOrder();
            this.changed();
            this.renderExpenses();
        });
    }

    // ---------- Dialogs ----------

    /** Show the confirm dialog; resolves with the clicked button's value ('' for Cancel / Escape). */
    ask(title, message, buttons) {
        const dialog = $('confirmDialog');
        $('confirmTitle').textContent = title;
        $('confirmMessage').textContent = message;
        $('confirmActions').innerHTML = [['', 'Cancel', 'btn-ghost'], ...buttons]
            .map(([value, label, cls]) => `<button value="${value}" class="btn ${cls}">${label}</button>`).join('');
        dialog.returnValue = '';
        dialog.showModal();
        return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    }

    // ---------- Backups ----------

    load(key) {
        try { return localStorage.getItem(key); } catch (e) { console.error('localStorage read failed:', e); return null; }
    }

    store(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { console.error('localStorage write failed:', e); }
    }

    backupState() {
        return { at: null, changes: 0, ...JSON.parse(this.load(BACKUP_KEY) || '{}') };
    }

    /** Record a data change (for the "N changes not backed up" reminder). */
    changed() {
        const state = this.backupState();
        this.store(BACKUP_KEY, JSON.stringify({ ...state, changes: state.changes + 1 }));
        this.backupFile = null;
        this.renderBackupStatus();
        this.scheduleAutoBackup();
    }

    markBackedUp() {
        this.store(BACKUP_KEY, JSON.stringify({ at: new Date().toISOString(), changes: 0 }));
        this.renderBackupStatus();
    }

    renderBackupStatus() {
        const { at, changes } = this.backupState();
        const pending = changes > 0 && this.expenses.length > 0;
        $('backupBtn').classList.toggle('warn', pending);
        $('backupBtn').classList.toggle('ok', !pending && !!at);
        $('backupStatus').textContent = pending
            ? (this.autoBackupStatus === 'paused' ? 'Auto-backup paused' : `${changes} not backed up`)
            : at ? `Backed up ${timeAgo(at)}` : 'Backup';
    }

    /** Open the backup sheet and build the ZIP right away, so Share runs within the tap's user gesture (iOS requires it). */
    async openBackup() {
        const { at, changes } = this.backupState();
        $('backupLast').textContent = at ? `${timeAgo(at)} (${new Date(at).toLocaleString()})` : 'Never';
        $('backupChanges').textContent = String(changes);
        const estimate = await navigator.storage?.estimate?.();
        $('storageInfo').textContent = `${this.expenses.length} expenses` +
            (estimate ? `, ${formatFileSize(estimate.usage)} used` : '') +
            (this.persisted ? ' · protected from automatic cleanup' : ' · ⚠ browser may clear this data when space is low');
        $('backupDialog').showModal();

        const share = $('shareBackupBtn'), download = $('downloadBackupBtn');
        share.disabled = download.disabled = true;
        if (!this.expenses.length) return;
        download.textContent = 'Preparing…';
        try {
            this.backupFile ??= await this.buildZip();
            share.hidden = !navigator.canShare?.({ files: [this.backupFile] });
            share.disabled = download.disabled = false;
            download.textContent = `Download ZIP (${formatFileSize(this.backupFile.size)})`;
        } catch (error) {
            console.error('Error building backup:', error);
            download.textContent = 'Download ZIP';
            toast(`Failed to build backup: ${error.message}`, 'error');
        }
    }

    downloadBackup() {
        const url = URL.createObjectURL(this.backupFile);
        Object.assign(document.createElement('a'), { href: url, download: this.backupFile.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        this.markBackedUp();
        $('backupDialog').close();
        toast('Backup downloaded', 'success');
    }

    async shareBackup() {
        try {
            await navigator.share({ files: [this.backupFile], title: 'Expenses backup' });
            this.markBackedUp();
            $('backupDialog').close();
            toast('Backup shared', 'success');
        } catch (error) {
            if (error.name === 'AbortError') return toast('Share cancelled — not backed up');
            console.error('Share failed:', error);
            toast(`Share failed: ${error.message}`, 'error');
        }
    }

    // ---------- Auto-backup to a folder (File System Access API: desktop Chrome / Edge only) ----------

    async initAutoBackup() {
        if (!('showDirectoryPicker' in window)) return;
        $('autoBackup').hidden = false;
        this.backupDir = (await this.idb('readonly', (s) => s.get('backupDir'), SETTINGS_STORE)) || null;
        await this.renderAutoBackup();
        if (this.backupState().changes) this.scheduleAutoBackup();
    }

    async renderAutoBackup() {
        const permission = await this.backupDir?.queryPermission({ mode: 'readwrite' });
        this.autoBackupStatus = !this.backupDir ? 'off' : permission === 'granted' ? 'on' : 'paused';
        const folder = this.backupDir?.name;
        $('autoBackupInfo').textContent = {
            off: 'Off',
            on: `On · saving to “${folder}”`,
            paused: `Paused · allow access to “${folder}” again`
        }[this.autoBackupStatus];
        $('chooseFolderBtn').textContent = this.backupDir ? 'Change folder…' : 'Choose folder…';
        $('resumeBackupBtn').hidden = this.autoBackupStatus !== 'paused';
        $('stopBackupBtn').hidden = !this.backupDir;
        this.renderBackupStatus();
    }

    async chooseBackupFolder() {
        try {
            this.backupDir = await showDirectoryPicker({ id: 'expenses-backup', mode: 'readwrite' });
        } catch (error) {
            if (error.name === 'AbortError') return; // user closed the picker
            console.error('Folder picker failed:', error);
            return toast(`Could not open folder: ${error.message}`, 'error');
        }
        await this.idb('readwrite', (s) => s.put(this.backupDir, 'backupDir'), SETTINGS_STORE);
        await this.writeAutoBackup();
        if (this.expenses.length) toast(`Backed up to “${this.backupDir.name}”`, 'success');
    }

    /** Browsers forget folder permission between sessions; re-granting needs a click (and may offer "allow on every visit"). */
    async resumeAutoBackup() {
        if ((await this.backupDir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
            await this.renderAutoBackup();
            return toast('Folder access not granted, so auto-backup stays paused', 'error');
        }
        await this.writeAutoBackup();
    }

    async stopAutoBackup() {
        await this.idb('readwrite', (s) => s.delete('backupDir'), SETTINGS_STORE);
        this.backupDir = null;
        await this.renderAutoBackup();
    }

    scheduleAutoBackup() {
        clearTimeout(this.autoBackupTimer);
        if (this.backupDir) this.autoBackupTimer = setTimeout(() => this.writeAutoBackup(), 1500); // coalesce bursts of changes
    }

    /**
     * Write today's ZIP into the backup folder (replacing earlier ones from today), then prune all but the
     * newest AUTO_BACKUP_KEEP days. Daily files mean a bad state (e.g. after mass deletes) can't overwrite
     * every good backup. Never writes an empty backup.
     */
    writeAutoBackup() {
        this.autoBackupRun = this.autoBackupRun.then(async () => {
            try {
                if ((await this.backupDir?.queryPermission({ mode: 'readwrite' })) !== 'granted' || !this.expenses.length) return;
                this.backupFile ??= await this.buildZip();
                const name = `expenses-backup-${new Date().toLocaleDateString('en-CA')}.zip`;
                const writable = await (await this.backupDir.getFileHandle(name, { create: true })).createWritable();
                await writable.write(this.backupFile);
                await writable.close();

                const daily = [];
                for await (const entry of this.backupDir.keys()) if (AUTO_BACKUP_NAME.test(entry)) daily.push(entry);
                for (const old of daily.sort().slice(0, -AUTO_BACKUP_KEEP)) await this.backupDir.removeEntry(old);
                this.markBackedUp();
            } catch (error) {
                console.error('Auto-backup failed:', error);
                toast(`Auto-backup failed: ${error.message}`, 'error');
            } finally {
                await this.renderAutoBackup();
            }
        });
        return this.autoBackupRun;
    }

    /** Build a ZIP with expenses.json (metadata) and files/<id>.<ext> (receipts). */
    async buildZip() {
        const zip = new JSZip();
        zip.file('expenses.json', JSON.stringify({
            version: 1,
            exportedAt: new Date().toISOString(),
            expenses: this.expenses.map((e, index) => ({
                id: e.id, title: e.title, date: e.date, time: e.time || null,
                amount: e.amount ?? null, currency: e.currency ?? null, order: index,
                fileName: e.fileName, fileType: e.fileType, fileSize: e.fileSize, createdAt: e.createdAt
            }))
        }, null, 2));
        for (const e of this.expenses) {
            zip.file(`files/${e.id}.${e.fileName.split('.').pop()}`, e.fileData.split(',')[1], { base64: true });
        }
        // Receipts are already compressed (JPEG/PDF); STORE is much faster and barely larger.
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
        return new File([blob], `expenses-backup-${stamp}.zip`, { type: 'application/zip' });
    }

    /** Restore from a backup ZIP, either replacing everything or merging (skipping expenses already present). */
    async importFromZip(file) {
        try {
            busy('Reading backup…');
            const zip = await JSZip.loadAsync(file);
            const metadataFile = zip.file('expenses.json');
            if (!metadataFile) throw new Error('Invalid ZIP: expenses.json not found');
            const metadata = JSON.parse(await metadataFile.async('string'));
            if (!Array.isArray(metadata.expenses)) throw new Error('Invalid ZIP: expenses data is missing or invalid');
            busy(false);

            let replace = true;
            if (this.expenses.length) {
                const choice = await this.ask('Restore backup',
                    `The backup has ${metadata.expenses.length} expense(s); you have ${this.expenses.length}. Merge them, or replace yours?`,
                    [['merge', 'Merge', 'btn-secondary'], ['replace', 'Replace all', 'btn-danger']]);
                if (!choice) return;
                replace = choice === 'replace';
            }

            busy('Restoring…');
            const existing = new Set(replace ? [] : this.expenses.map((e) => e.id));
            const incoming = [];
            const missing = [];
            for (const meta of metadata.expenses) {
                if (existing.has(meta.id)) continue;
                const entry = zip.file(`files/${meta.id}.${meta.fileName.split('.').pop()}`);
                if (!entry) { missing.push(meta.fileName); continue; }
                incoming.push({
                    id: meta.id,
                    title: meta.title || '',
                    date: meta.date,
                    time: meta.time || null,
                    amount: meta.amount ?? null,
                    currency: meta.currency ?? null,
                    fileName: meta.fileName,
                    fileType: meta.fileType,
                    fileSize: meta.fileSize,
                    fileData: `data:${meta.fileType};base64,${await entry.async('base64')}`,
                    createdAt: meta.createdAt || new Date().toISOString()
                });
            }
            const base = replace ? 0 : this.expenses.length;
            await this.idb('readwrite', (s) => {
                if (replace) s.clear();
                incoming.forEach((e, i) => s.put({ ...e, order: base + i }));
            });
            await this.loadExpenses();
            if (replace || incoming.length) this.changed();

            const skipped = metadata.expenses.length - incoming.length - missing.length;
            toast(`Restored ${incoming.length} expense(s)` + (skipped ? `, skipped ${skipped} already here` : ''), 'success');
            if (missing.length) {
                console.error('Files missing from backup ZIP:', missing);
                toast(`${missing.length} receipt file(s) were missing from the ZIP: ${missing.join(', ')}`, 'error');
            }
        } catch (error) {
            console.error('Error importing from ZIP:', error);
            toast(`Restore failed: ${error.message}`, 'error');
        } finally {
            busy(false);
        }
    }

    // ---------- PDF export ----------

    async getPdfPageCount(dataUrl) {
        const pdfDoc = await PDFLib.PDFDocument.load(dataUrlToUint8Array(dataUrl));
        return pdfDoc.getPageCount();
    }

    async exportToPDF() {
        if (this.expenses.length === 0) return;
        busy('Generating PDF…');
        const reportTitle = $('reportTitle').value.trim() || 'Expense Report';

        try {
            const { jsPDF } = window.jspdf;
            const { PDFDocument, rgb } = PDFLib;

            const sortedExpenses = [...this.expenses].sort((a, b) => localDate(a.date) - localDate(b.date));

            // First pass: page counts, so the table of contents can reference page numbers.
            // Page 1 = Title/TOC, expenses start at page 2.
            const expensePageCounts = [];
            for (const expense of sortedExpenses) {
                expensePageCounts.push(expense.fileType === 'application/pdf' ? await this.getPdfPageCount(expense.fileData) : 1);
            }
            const expenseStartPages = [];
            let currentPage = 2;
            for (const pageCount of expensePageCounts) {
                expenseStartPages.push(currentPage);
                currentPage += pageCount;
            }
            const totalPages = currentPage - 1;

            const finalPdf = await PDFDocument.create();
            const pageWidth = 595.28;  // A4 width in points
            const pageHeight = 841.89; // A4 height in points
            const margin = 56.69;      // 20mm in points
            const helveticaBold = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
            const helvetica = await finalPdf.embedFont(PDFLib.StandardFonts.Helvetica);
            const black = rgb(0, 0, 0);

            const titlePage = finalPdf.addPage([pageWidth, pageHeight]);
            /** Draw text horizontally centred on the title page; `top` is measured from the top edge. */
            const centered = (text, top, size, font, color = black) => titlePage.drawText(text, {
                x: (pageWidth - font.widthOfTextAtSize(text, size)) / 2, y: pageHeight - top, size, font, color
            });

            centered(reportTitle, 113, 24, helveticaBold);
            centered(`Generated: ${formatDate(new Date().toLocaleDateString('en-CA'))}`, 147, 12, helvetica);
            centered(`Total Expenses: ${sortedExpenses.length}`, 170, 12, helvetica);

            titlePage.drawText('Table of Contents', { x: margin, y: pageHeight - 241, size: 16, font: helveticaBold, color: black });

            let yPos = 269;
            sortedExpenses.forEach((expense, i) => {
                const formattedTime = formatTime(expense.time);
                const dateTimeStr = [formatDate(expense.date, 'short'), formattedTime].filter(Boolean).join(' ');
                const pageCount = expensePageCounts[i];
                const pageInfo = pageCount > 1
                    ? `Pages ${expenseStartPages[i]}-${expenseStartPages[i] + pageCount - 1}`
                    : `Page ${expenseStartPages[i]}`;
                const amountStr = hasAmount(expense) ? `  ${formatAmountForPDF(expense.amount, expense.currency)}` : '';

                titlePage.drawText(`${i + 1}. ${expense.title || 'Untitled'} (${dateTimeStr})${amountStr}`, {
                    x: margin, y: pageHeight - yPos, size: 10, font: helvetica, color: black
                });
                titlePage.drawText(pageInfo, {
                    x: pageWidth - margin - 60, y: pageHeight - yPos, size: 10, font: helvetica, color: rgb(0.4, 0.4, 0.4)
                });
                yPos += 20;
            });

            const totals = currencyTotals(sortedExpenses);
            if (Object.keys(totals).length) {
                titlePage.drawText('Totals', { x: margin, y: pageHeight - yPos - 10, size: 13, font: helveticaBold, color: black });
                yPos += 30;
                for (const [c, total] of Object.entries(totals)) {
                    titlePage.drawText(`${c}: ${formatAmountForPDF(total, c)}`, {
                        x: margin + 12, y: pageHeight - yPos, size: 11, font: helvetica, color: black
                    });
                    yPos += 18;
                }
            }

            centered(`Page 1 of ${totalPages}`, pageHeight - 28, 9, helvetica, rgb(0.5, 0.5, 0.5));

            let currentPageNum = 2;
            for (const expense of sortedExpenses) {
                const formattedTime = formatTime(expense.time);
                const dateTimeForPage = formattedTime ? `${formatDate(expense.date)} at ${formattedTime}` : formatDate(expense.date);
                const title = expense.title || 'Untitled';
                const amountLine = hasAmount(expense) ? `  |  Amount: ${formatAmountForPDF(expense.amount, expense.currency)}` : '';

                if (expense.fileType === 'application/pdf') {
                    const sourcePdf = await PDFDocument.load(dataUrlToUint8Array(expense.fileData));
                    const sourcePages = await finalPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());

                    sourcePages.forEach((page, j) => {
                        const addedPage = finalPdf.addPage(page);
                        const { width, height } = addedPage.getSize();

                        // Header on the first page of this expense, over a translucent white band
                        if (j === 0) {
                            addedPage.drawRectangle({ x: 0, y: height - 85, width, height: 85, color: rgb(1, 1, 1), opacity: 0.9 });
                            addedPage.drawText(title, { x: 40, y: height - 35, size: 14, font: helveticaBold, color: black });
                            addedPage.drawText(`Date: ${dateTimeForPage}${amountLine}  |  File: ${expense.fileName}  |  Page ${j + 1} of ${sourcePages.length}`, {
                                x: 40, y: height - 55, size: 9, font: helvetica, color: rgb(0.3, 0.3, 0.3)
                            });
                            addedPage.drawLine({
                                start: { x: 40, y: height - 70 }, end: { x: width - 40, y: height - 70 },
                                thickness: 0.5, color: rgb(0.8, 0.8, 0.8)
                            });
                        }
                        addedPage.drawText(`Page ${currentPageNum} of ${totalPages}`, {
                            x: width / 2 - 30, y: 20, size: 9, font: helvetica, color: rgb(0.5, 0.5, 0.5)
                        });
                        currentPageNum++;
                    });
                } else {
                    // Image expense: lay the page out with jsPDF (handles image scaling), then import it
                    const tempPdf = new jsPDF('p', 'mm', 'a4');
                    const pdfPageWidth = tempPdf.internal.pageSize.getWidth();
                    const pdfPageHeight = tempPdf.internal.pageSize.getHeight();
                    const pdfMargin = 20;
                    const contentWidth = pdfPageWidth - pdfMargin * 2;

                    tempPdf.setFontSize(16);
                    tempPdf.setFont(undefined, 'bold');
                    tempPdf.text(title, pdfMargin, pdfMargin + 5);
                    tempPdf.setFontSize(11);
                    tempPdf.setFont(undefined, 'normal');
                    tempPdf.text(`Date: ${dateTimeForPage}${amountLine}`, pdfMargin, pdfMargin + 14);
                    tempPdf.text(`File: ${expense.fileName}`, pdfMargin, pdfMargin + 21);
                    tempPdf.setDrawColor(200);
                    tempPdf.line(pdfMargin, pdfMargin + 27, pdfPageWidth - pdfMargin, pdfMargin + 27);

                    const contentStartY = pdfMargin + 35;
                    const maxImageHeight = pdfPageHeight - contentStartY - pdfMargin - 15;
                    const dims = await getImageDimensions(expense.fileData);
                    let imgWidth = contentWidth;
                    let imgHeight = (dims.height / dims.width) * imgWidth;
                    if (imgHeight > maxImageHeight) {
                        imgHeight = maxImageHeight;
                        imgWidth = (dims.width / dims.height) * imgHeight;
                    }
                    const format = expense.fileType === 'image/png' ? 'PNG' : 'JPEG';
                    tempPdf.addImage(expense.fileData, format, pdfMargin + (contentWidth - imgWidth) / 2, contentStartY, imgWidth, imgHeight);

                    tempPdf.setFontSize(9);
                    tempPdf.setTextColor(128);
                    tempPdf.text(`Page ${currentPageNum} of ${totalPages}`, pdfPageWidth / 2, pdfPageHeight - 10, { align: 'center' });

                    const tempPdfDoc = await PDFDocument.load(tempPdf.output('arraybuffer'));
                    const [importedPage] = await finalPdf.copyPages(tempPdfDoc, [0]);
                    finalPdf.addPage(importedPage);
                    currentPageNum++;
                }
            }

            const blob = new Blob([await finalPdf.save()], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const safeTitle = reportTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'expense-report';
            Object.assign(document.createElement('a'), {
                href: url, download: `${safeTitle}-${new Date().toLocaleDateString('en-CA')}.pdf`
            }).click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            toast('PDF exported', 'success');
        } catch (error) {
            console.error('Error generating PDF:', error);
            toast(`Failed to generate PDF: ${error.message}`, 'error');
        } finally {
            busy(false);
        }
    }

    async registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        try {
            await navigator.serviceWorker.register('/expenses/sw.js');
        } catch (error) {
            console.error('Service Worker registration failed:', error);
            toast('Offline mode unavailable: service worker failed to register', 'error');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new ExpenseManager(); });
