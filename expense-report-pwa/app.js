// Expense Report Manager - PWA Application
// Uses IndexedDB for storage to handle large files (images/PDFs)

const DB_NAME = 'ExpenseReportDB';
const DB_VERSION = 1;
const STORE_NAME = 'expenses';

class ExpenseManager {
    constructor() {
        this.db = null;
        this.expenses = [];
        this.init();
    }

    async init() {
        await this.initDB();
        await this.loadExpenses();
        this.setupEventListeners();
        this.setDefaultDate();
        this.registerServiceWorker();
    }

    // IndexedDB Initialization
    initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                console.error('Failed to open database');
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('date', 'date', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
        });
    }

    // Load all expenses from IndexedDB
    async loadExpenses() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                this.expenses = request.result.sort((a, b) =>
                    new Date(b.createdAt) - new Date(a.createdAt)
                );
                this.renderExpenses();
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    // Add expense to IndexedDB
    async addExpense(expense) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.add(expense);

            request.onsuccess = () => {
                this.expenses.unshift(expense);
                this.renderExpenses();
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    // Delete expense from IndexedDB
    async deleteExpense(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(id);

            request.onsuccess = () => {
                this.expenses = this.expenses.filter(e => e.id !== id);
                this.renderExpenses();
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    // Clear all expenses from IndexedDB
    async clearAllExpenses() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onsuccess = () => {
                this.expenses = [];
                this.renderExpenses();
                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    // Setup event listeners
    setupEventListeners() {
        // Form submission
        const form = document.getElementById('expenseForm');
        form.addEventListener('submit', (e) => this.handleFormSubmit(e));

        // File input change
        const fileInput = document.getElementById('expenseFile');
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // Drag and drop
        const fileDisplay = document.querySelector('.file-input-display');
        fileDisplay.addEventListener('dragover', (e) => {
            e.preventDefault();
            fileDisplay.classList.add('dragover');
        });
        fileDisplay.addEventListener('dragleave', () => {
            fileDisplay.classList.remove('dragover');
        });
        fileDisplay.addEventListener('drop', (e) => {
            e.preventDefault();
            fileDisplay.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                fileInput.files = e.dataTransfer.files;
                this.handleFileSelect({ target: fileInput });
            }
        });

        // Clear all button
        document.getElementById('clearAllBtn').addEventListener('click', () => {
            this.showModal(
                'Clear All Expenses',
                'Are you sure you want to delete all expenses? This action cannot be undone.',
                async () => {
                    await this.clearAllExpenses();
                    this.showToast('All expenses cleared', 'success');
                }
            );
        });

        // Export button
        document.getElementById('exportBtn').addEventListener('click', () => {
            this.exportToPDF();
        });

        // Modal buttons
        document.getElementById('modalCancel').addEventListener('click', () => {
            this.hideModal();
        });
    }

    // Set default date to today
    setDefaultDate() {
        const dateInput = document.getElementById('expenseDate');
        const today = new Date().toISOString().split('T')[0];
        dateInput.value = today;
    }

    // Handle file selection
    handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const fileLabel = document.getElementById('fileLabel');
        const preview = document.getElementById('filePreview');

        fileLabel.textContent = file.name;

        // Show preview
        preview.innerHTML = '';
        preview.classList.remove('hidden');

        if (file.type.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.alt = 'Preview';
            preview.appendChild(img);
        } else if (file.type === 'application/pdf') {
            preview.innerHTML = `
                <div class="pdf-preview">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                        <path d="M14 2v6h6"/>
                    </svg>
                    <span>${file.name}</span>
                </div>
            `;
        }
    }

    // Handle form submission
    async handleFormSubmit(event) {
        event.preventDefault();

        const form = event.target;
        const title = form.title.value.trim();
        const date = form.date.value;
        const file = form.file.files[0];

        if (!file) {
            this.showToast('Please select a file', 'error');
            return;
        }

        try {
            // Read file as base64
            const fileData = await this.readFileAsBase64(file);

            const expense = {
                id: Date.now().toString(),
                title: title || '',
                date: date,
                fileName: file.name,
                fileType: file.type,
                fileSize: file.size,
                fileData: fileData,
                createdAt: new Date().toISOString()
            };

            await this.addExpense(expense);
            this.showToast('Expense added successfully', 'success');

            // Reset form
            form.reset();
            this.setDefaultDate();
            document.getElementById('fileLabel').textContent = 'Choose a file or drag it here';
            document.getElementById('filePreview').classList.add('hidden');
        } catch (error) {
            console.error('Error adding expense:', error);
            this.showToast('Failed to add expense', 'error');
        }
    }

    // Read file as base64
    readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    // Render expenses list
    renderExpenses() {
        const list = document.getElementById('expensesList');
        const count = document.getElementById('expenseCount');
        const exportBtn = document.getElementById('exportBtn');

        count.textContent = this.expenses.length;
        exportBtn.disabled = this.expenses.length === 0;

        if (this.expenses.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M9 17h6M9 13h6M9 9h6M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z"/>
                    </svg>
                    <p>No expenses yet. Add your first expense above.</p>
                </div>
            `;
            return;
        }

        list.innerHTML = this.expenses.map(expense => this.createExpenseCard(expense)).join('');

        // Add delete event listeners
        list.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const expense = this.expenses.find(e => e.id === id);
                this.showModal(
                    'Delete Expense',
                    `Are you sure you want to delete "${expense.title || 'Untitled'}"?`,
                    async () => {
                        await this.deleteExpense(id);
                        this.showToast('Expense deleted', 'success');
                    }
                );
            });
        });
    }

    // Create expense card HTML
    createExpenseCard(expense) {
        const isImage = expense.fileType.startsWith('image/');
        const formattedDate = new Date(expense.date).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        const fileSize = this.formatFileSize(expense.fileSize);

        return `
            <div class="expense-card">
                <div class="expense-thumbnail ${isImage ? '' : 'pdf'}">
                    ${isImage
                        ? `<img src="${expense.fileData}" alt="${expense.title || 'Expense'}">`
                        : `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <path d="M14 2v6h6"/>
                           </svg>`
                    }
                </div>
                <div class="expense-details">
                    <div class="expense-title ${expense.title ? '' : 'untitled'}">
                        ${expense.title || 'Untitled'}
                    </div>
                    <div class="expense-date">${formattedDate}</div>
                    <div class="expense-file-info">${expense.fileName} (${fileSize})</div>
                </div>
                <div class="expense-actions">
                    <button class="btn-icon delete-btn" data-id="${expense.id}" title="Delete expense">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }

    // Format file size
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // Convert base64 data URL to Uint8Array
    dataUrlToUint8Array(dataUrl) {
        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    // Get page count for a PDF
    async getPdfPageCount(dataUrl) {
        try {
            const pdfBytes = this.dataUrlToUint8Array(dataUrl);
            const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
            return pdfDoc.getPageCount();
        } catch (error) {
            console.error('Error getting PDF page count:', error);
            return 1;
        }
    }

    // Export to PDF
    async exportToPDF() {
        if (this.expenses.length === 0) return;

        const loadingOverlay = document.getElementById('loadingOverlay');
        loadingOverlay.classList.remove('hidden');

        try {
            const { jsPDF } = window.jspdf;
            const { PDFDocument, rgb } = PDFLib;

            // Sort expenses by date
            const sortedExpenses = [...this.expenses].sort((a, b) =>
                new Date(a.date) - new Date(b.date)
            );

            // First pass: Calculate page counts for each expense
            const expensePageCounts = [];
            for (const expense of sortedExpenses) {
                if (expense.fileType === 'application/pdf') {
                    const pageCount = await this.getPdfPageCount(expense.fileData);
                    expensePageCounts.push(pageCount);
                } else {
                    expensePageCounts.push(1); // Images take 1 page
                }
            }

            // Calculate starting page for each expense
            // Page 1 = Title/TOC, expenses start at page 2
            const expenseStartPages = [];
            let currentPage = 2;
            for (const pageCount of expensePageCounts) {
                expenseStartPages.push(currentPage);
                currentPage += pageCount;
            }
            const totalPages = currentPage - 1;

            // Create the final PDF document using pdf-lib
            const finalPdf = await PDFDocument.create();
            const pageWidth = 595.28; // A4 width in points
            const pageHeight = 841.89; // A4 height in points
            const margin = 56.69; // 20mm in points

            // Helper to add text to a page
            const addText = async (page, text, x, y, size = 12, bold = false) => {
                const font = bold
                    ? await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold)
                    : await finalPdf.embedFont(PDFLib.StandardFonts.Helvetica);
                page.drawText(text, {
                    x,
                    y: pageHeight - y,
                    size,
                    font,
                    color: rgb(0, 0, 0)
                });
            };

            // Create title page with TOC
            const titlePage = finalPdf.addPage([pageWidth, pageHeight]);
            const helveticaBold = await finalPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
            const helvetica = await finalPdf.embedFont(PDFLib.StandardFonts.Helvetica);

            // Title
            titlePage.drawText('Expense Report', {
                x: pageWidth / 2 - 80,
                y: pageHeight - 113, // ~40mm from top
                size: 24,
                font: helveticaBold,
                color: rgb(0, 0, 0)
            });

            // Generated date
            const generatedDate = new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
            titlePage.drawText(`Generated: ${generatedDate}`, {
                x: pageWidth / 2 - 60,
                y: pageHeight - 147, // ~52mm
                size: 12,
                font: helvetica,
                color: rgb(0, 0, 0)
            });

            titlePage.drawText(`Total Expenses: ${sortedExpenses.length}`, {
                x: pageWidth / 2 - 45,
                y: pageHeight - 170, // ~60mm
                size: 12,
                font: helvetica,
                color: rgb(0, 0, 0)
            });

            // Table of Contents header
            titlePage.drawText('Table of Contents', {
                x: margin,
                y: pageHeight - 241, // ~85mm
                size: 16,
                font: helveticaBold,
                color: rgb(0, 0, 0)
            });

            // TOC entries
            let yPos = 269; // Starting Y position for TOC entries (~95mm)
            for (let i = 0; i < sortedExpenses.length; i++) {
                const expense = sortedExpenses[i];
                const formattedDate = new Date(expense.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                });
                const title = expense.title || 'Untitled';
                const pageCount = expensePageCounts[i];
                const pageInfo = pageCount > 1
                    ? `Pages ${expenseStartPages[i]}-${expenseStartPages[i] + pageCount - 1}`
                    : `Page ${expenseStartPages[i]}`;

                const tocEntry = `${i + 1}. ${title} (${formattedDate})`;

                titlePage.drawText(tocEntry, {
                    x: margin,
                    y: pageHeight - yPos,
                    size: 10,
                    font: helvetica,
                    color: rgb(0, 0, 0)
                });

                titlePage.drawText(pageInfo, {
                    x: pageWidth - margin - 60,
                    y: pageHeight - yPos,
                    size: 10,
                    font: helvetica,
                    color: rgb(0.4, 0.4, 0.4)
                });

                yPos += 20;
            }

            // Page number on title page
            titlePage.drawText(`Page 1 of ${totalPages}`, {
                x: pageWidth / 2 - 30,
                y: 28,
                size: 9,
                font: helvetica,
                color: rgb(0.5, 0.5, 0.5)
            });

            // Add expense pages
            let currentPageNum = 2;
            for (let i = 0; i < sortedExpenses.length; i++) {
                const expense = sortedExpenses[i];
                const formattedDate = new Date(expense.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
                const title = expense.title || 'Untitled';

                if (expense.fileType === 'application/pdf') {
                    // Load the source PDF
                    const pdfBytes = this.dataUrlToUint8Array(expense.fileData);
                    const sourcePdf = await PDFDocument.load(pdfBytes);
                    const sourcePages = await finalPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());

                    // Add each page from the source PDF
                    for (let j = 0; j < sourcePages.length; j++) {
                        const page = sourcePages[j];
                        finalPdf.addPage(page);

                        // Get the page we just added to add header/footer
                        const addedPage = finalPdf.getPage(finalPdf.getPageCount() - 1);
                        const { width, height } = addedPage.getSize();

                        // Add header on first page of this expense
                        if (j === 0) {
                            // Draw a white rectangle for header background
                            addedPage.drawRectangle({
                                x: 0,
                                y: height - 85,
                                width: width,
                                height: 85,
                                color: rgb(1, 1, 1),
                                opacity: 0.9
                            });

                            addedPage.drawText(title, {
                                x: 40,
                                y: height - 35,
                                size: 14,
                                font: helveticaBold,
                                color: rgb(0, 0, 0)
                            });

                            addedPage.drawText(`Date: ${formattedDate}  |  File: ${expense.fileName}  |  Page ${j + 1} of ${sourcePages.length}`, {
                                x: 40,
                                y: height - 55,
                                size: 9,
                                font: helvetica,
                                color: rgb(0.3, 0.3, 0.3)
                            });

                            // Draw separator line
                            addedPage.drawLine({
                                start: { x: 40, y: height - 70 },
                                end: { x: width - 40, y: height - 70 },
                                thickness: 0.5,
                                color: rgb(0.8, 0.8, 0.8)
                            });
                        }

                        // Add page number footer
                        addedPage.drawText(`Page ${currentPageNum} of ${totalPages}`, {
                            x: width / 2 - 30,
                            y: 20,
                            size: 9,
                            font: helvetica,
                            color: rgb(0.5, 0.5, 0.5)
                        });

                        currentPageNum++;
                    }
                } else {
                    // Image expense - create page using jsPDF then import
                    const tempPdf = new jsPDF('p', 'mm', 'a4');
                    const pdfPageWidth = tempPdf.internal.pageSize.getWidth();
                    const pdfPageHeight = tempPdf.internal.pageSize.getHeight();
                    const pdfMargin = 20;
                    const contentWidth = pdfPageWidth - (pdfMargin * 2);

                    // Header
                    tempPdf.setFontSize(16);
                    tempPdf.setFont(undefined, 'bold');
                    tempPdf.text(title, pdfMargin, pdfMargin + 5);

                    tempPdf.setFontSize(11);
                    tempPdf.setFont(undefined, 'normal');
                    tempPdf.text(`Date: ${formattedDate}`, pdfMargin, pdfMargin + 14);
                    tempPdf.text(`File: ${expense.fileName}`, pdfMargin, pdfMargin + 21);

                    // Separator line
                    tempPdf.setDrawColor(200);
                    tempPdf.line(pdfMargin, pdfMargin + 27, pdfPageWidth - pdfMargin, pdfMargin + 27);

                    // Add image
                    const contentStartY = pdfMargin + 35;
                    const maxImageHeight = pdfPageHeight - contentStartY - pdfMargin - 15;

                    try {
                        const imgDimensions = await this.getImageDimensions(expense.fileData);
                        let imgWidth = contentWidth;
                        let imgHeight = (imgDimensions.height / imgDimensions.width) * imgWidth;

                        if (imgHeight > maxImageHeight) {
                            imgHeight = maxImageHeight;
                            imgWidth = (imgDimensions.width / imgDimensions.height) * imgHeight;
                        }

                        const imgX = pdfMargin + (contentWidth - imgWidth) / 2;
                        tempPdf.addImage(expense.fileData, 'JPEG', imgX, contentStartY, imgWidth, imgHeight);
                    } catch (error) {
                        console.error('Error adding image to PDF:', error);
                        tempPdf.setFontSize(12);
                        tempPdf.text('Error loading image', pdfMargin, contentStartY + 10);
                    }

                    // Page number footer
                    tempPdf.setFontSize(9);
                    tempPdf.setTextColor(128);
                    tempPdf.text(`Page ${currentPageNum} of ${totalPages}`, pdfPageWidth / 2, pdfPageHeight - 10, { align: 'center' });

                    // Convert jsPDF to bytes and import into final PDF
                    const tempPdfBytes = tempPdf.output('arraybuffer');
                    const tempPdfDoc = await PDFDocument.load(tempPdfBytes);
                    const [importedPage] = await finalPdf.copyPages(tempPdfDoc, [0]);
                    finalPdf.addPage(importedPage);

                    currentPageNum++;
                }
            }

            // Save the final PDF
            const pdfBytes = await finalPdf.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            const link = document.createElement('a');
            link.href = url;
            link.download = `expense-report-${new Date().toISOString().split('T')[0]}.pdf`;
            link.click();

            URL.revokeObjectURL(url);

            this.showToast('PDF exported successfully', 'success');
        } catch (error) {
            console.error('Error generating PDF:', error);
            this.showToast('Failed to generate PDF', 'error');
        } finally {
            loadingOverlay.classList.add('hidden');
        }
    }

    // Get image dimensions
    getImageDimensions(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                resolve({ width: img.width, height: img.height });
            };
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    // Show modal
    showModal(title, message, onConfirm) {
        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modalTitle');
        const modalMessage = document.getElementById('modalMessage');
        const confirmBtn = document.getElementById('modalConfirm');

        modalTitle.textContent = title;
        modalMessage.textContent = message;

        // Remove old listener and add new one
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

        newConfirmBtn.addEventListener('click', async () => {
            await onConfirm();
            this.hideModal();
        });

        modal.classList.remove('hidden');
    }

    // Hide modal
    hideModal() {
        document.getElementById('modal').classList.add('hidden');
    }

    // Show toast notification
    showToast(message, type = '') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = 'toast';
        if (type) {
            toast.classList.add(type);
        }

        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }

    // Register service worker
    async registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('sw.js');
                console.log('Service Worker registered:', registration.scope);
            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new ExpenseManager();
});
