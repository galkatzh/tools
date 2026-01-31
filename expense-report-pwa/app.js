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

    // Export to PDF
    async exportToPDF() {
        if (this.expenses.length === 0) return;

        const loadingOverlay = document.getElementById('loadingOverlay');
        loadingOverlay.classList.remove('hidden');

        try {
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const margin = 20;
            const contentWidth = pageWidth - (margin * 2);

            // Sort expenses by date
            const sortedExpenses = [...this.expenses].sort((a, b) =>
                new Date(a.date) - new Date(b.date)
            );

            // Title page
            pdf.setFontSize(24);
            pdf.setFont(undefined, 'bold');
            pdf.text('Expense Report', pageWidth / 2, 40, { align: 'center' });

            pdf.setFontSize(12);
            pdf.setFont(undefined, 'normal');
            const generatedDate = new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
            pdf.text(`Generated: ${generatedDate}`, pageWidth / 2, 52, { align: 'center' });
            pdf.text(`Total Expenses: ${sortedExpenses.length}`, pageWidth / 2, 60, { align: 'center' });

            // Table of Contents
            let yPos = 85;
            pdf.setFontSize(16);
            pdf.setFont(undefined, 'bold');
            pdf.text('Table of Contents', margin, yPos);
            yPos += 10;

            pdf.setFontSize(10);
            pdf.setFont(undefined, 'normal');

            // Track page numbers for each expense (starting after TOC)
            const expensePages = [];
            let currentPage = 2; // Page 2 is first expense page

            sortedExpenses.forEach((expense, index) => {
                const formattedDate = new Date(expense.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                });
                const title = expense.title || 'Untitled';
                const tocEntry = `${index + 1}. ${title} (${formattedDate})`;

                // Check if we need a new page for TOC
                if (yPos > pageHeight - 30) {
                    pdf.addPage();
                    yPos = margin;
                }

                // Add TOC entry with page number
                pdf.text(tocEntry, margin, yPos);
                const pageNumText = `Page ${currentPage}`;
                pdf.text(pageNumText, pageWidth - margin, yPos, { align: 'right' });

                expensePages.push(currentPage);
                currentPage++;
                yPos += 7;
            });

            // Add expenses
            for (let i = 0; i < sortedExpenses.length; i++) {
                const expense = sortedExpenses[i];
                pdf.addPage();

                // Header
                pdf.setFontSize(16);
                pdf.setFont(undefined, 'bold');
                const title = expense.title || 'Untitled';
                pdf.text(title, margin, margin + 5);

                pdf.setFontSize(11);
                pdf.setFont(undefined, 'normal');
                const formattedDate = new Date(expense.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
                pdf.text(`Date: ${formattedDate}`, margin, margin + 14);
                pdf.text(`File: ${expense.fileName}`, margin, margin + 21);

                // Separator line
                pdf.setDrawColor(200);
                pdf.line(margin, margin + 27, pageWidth - margin, margin + 27);

                // Add image or PDF indicator
                const contentStartY = margin + 35;
                const maxImageHeight = pageHeight - contentStartY - margin;

                if (expense.fileType.startsWith('image/')) {
                    try {
                        // Get image dimensions
                        const imgDimensions = await this.getImageDimensions(expense.fileData);

                        // Calculate scaled dimensions to fit page
                        let imgWidth = contentWidth;
                        let imgHeight = (imgDimensions.height / imgDimensions.width) * imgWidth;

                        if (imgHeight > maxImageHeight) {
                            imgHeight = maxImageHeight;
                            imgWidth = (imgDimensions.width / imgDimensions.height) * imgHeight;
                        }

                        // Center the image horizontally
                        const imgX = margin + (contentWidth - imgWidth) / 2;

                        pdf.addImage(expense.fileData, 'JPEG', imgX, contentStartY, imgWidth, imgHeight);
                    } catch (error) {
                        console.error('Error adding image to PDF:', error);
                        pdf.setFontSize(12);
                        pdf.text('Error loading image', margin, contentStartY + 10);
                    }
                } else {
                    // PDF file indicator
                    pdf.setFontSize(12);
                    pdf.setTextColor(100);
                    pdf.text('PDF Attachment:', margin, contentStartY);
                    pdf.text(expense.fileName, margin, contentStartY + 8);
                    pdf.setTextColor(0);

                    // Note about attached PDF
                    pdf.setFontSize(10);
                    pdf.setTextColor(128);
                    pdf.text('(PDF files are referenced but not embedded in this report)', margin, contentStartY + 20);
                    pdf.setTextColor(0);
                }

                // Page number footer
                pdf.setFontSize(9);
                pdf.setTextColor(128);
                pdf.text(
                    `Page ${pdf.internal.getNumberOfPages()}`,
                    pageWidth / 2,
                    pageHeight - 10,
                    { align: 'center' }
                );
                pdf.setTextColor(0);
            }

            // Add page numbers to TOC pages
            const totalPages = pdf.internal.getNumberOfPages();
            for (let i = 1; i <= totalPages; i++) {
                pdf.setPage(i);
                if (i === 1) {
                    pdf.setFontSize(9);
                    pdf.setTextColor(128);
                    pdf.text(`Page 1 of ${totalPages}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
                    pdf.setTextColor(0);
                }
            }

            // Save PDF
            const fileName = `expense-report-${new Date().toISOString().split('T')[0]}.pdf`;
            pdf.save(fileName);

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
