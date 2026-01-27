/**
 * utils.js - Matrix helpers and input parsing utilities
 */

const Utils = (function() {
    'use strict';

    // ==================== Vector Operations ====================

    function add(a, b) {
        return a.map((v, i) => v + b[i]);
    }

    function subtract(a, b) {
        return a.map((v, i) => v - b[i]);
    }

    function scale(v, s) {
        return v.map(x => x * s);
    }

    function dot(a, b) {
        return a.reduce((sum, v, i) => sum + v * b[i], 0);
    }

    function norm(v) {
        return Math.sqrt(dot(v, v));
    }

    function normalize(v) {
        const n = norm(v);
        return n > 1e-12 ? scale(v, 1 / n) : v.map(() => 0);
    }

    function negate(v) {
        return v.map(x => -x);
    }

    function zeros(n) {
        return new Array(n).fill(0);
    }

    function ones(n) {
        return new Array(n).fill(1);
    }

    // ==================== Matrix Operations ====================

    function matrixCreate(rows, cols, fill = 0) {
        return Array.from({ length: rows }, () => new Array(cols).fill(fill));
    }

    function matrixIdentity(n) {
        const I = matrixCreate(n, n);
        for (let i = 0; i < n; i++) I[i][i] = 1;
        return I;
    }

    function matrixTranspose(M) {
        if (M.length === 0) return [];
        const rows = M.length;
        const cols = M[0].length;
        const T = matrixCreate(cols, rows);
        for (let i = 0; i < rows; i++) {
            for (let j = 0; j < cols; j++) {
                T[j][i] = M[i][j];
            }
        }
        return T;
    }

    function matrixMultiply(A, B) {
        const rowsA = A.length;
        const colsA = A[0].length;
        const colsB = B[0].length;
        const C = matrixCreate(rowsA, colsB);
        for (let i = 0; i < rowsA; i++) {
            for (let j = 0; j < colsB; j++) {
                let sum = 0;
                for (let k = 0; k < colsA; k++) {
                    sum += A[i][k] * B[k][j];
                }
                C[i][j] = sum;
            }
        }
        return C;
    }

    function matVec(M, v) {
        return M.map(row => dot(row, v));
    }

    function vecMat(v, M) {
        const n = M[0].length;
        const result = zeros(n);
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < v.length; i++) {
                result[j] += v[i] * M[i][j];
            }
        }
        return result;
    }

    function matrixCopy(M) {
        return M.map(row => [...row]);
    }

    function matrixAdd(A, B) {
        return A.map((row, i) => row.map((v, j) => v + B[i][j]));
    }

    function matrixScale(M, s) {
        return M.map(row => row.map(v => v * s));
    }

    // ==================== Matrix Decompositions ====================

    /**
     * Compute eigenvalues and eigenvectors of a symmetric matrix
     * using Jacobi iteration
     */
    function eigenDecomposition(A, maxIter = 100, tol = 1e-10) {
        const n = A.length;
        let V = matrixIdentity(n);
        let D = matrixCopy(A);

        for (let iter = 0; iter < maxIter; iter++) {
            // Find largest off-diagonal element
            let maxVal = 0;
            let p = 0, q = 1;
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    if (Math.abs(D[i][j]) > maxVal) {
                        maxVal = Math.abs(D[i][j]);
                        p = i;
                        q = j;
                    }
                }
            }

            if (maxVal < tol) break;

            // Compute rotation angle
            const theta = (D[q][q] - D[p][p]) / (2 * D[p][q]);
            const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(1 + t * t);
            const s = t * c;

            // Apply rotation to D
            const newD = matrixCopy(D);
            newD[p][p] = D[p][p] - t * D[p][q];
            newD[q][q] = D[q][q] + t * D[p][q];
            newD[p][q] = 0;
            newD[q][p] = 0;

            for (let i = 0; i < n; i++) {
                if (i !== p && i !== q) {
                    newD[i][p] = c * D[i][p] - s * D[i][q];
                    newD[p][i] = newD[i][p];
                    newD[i][q] = s * D[i][p] + c * D[i][q];
                    newD[q][i] = newD[i][q];
                }
            }
            D = newD;

            // Apply rotation to V
            for (let i = 0; i < n; i++) {
                const vip = V[i][p];
                const viq = V[i][q];
                V[i][p] = c * vip - s * viq;
                V[i][q] = s * vip + c * viq;
            }
        }

        // Extract eigenvalues (diagonal of D)
        const eigenvalues = [];
        for (let i = 0; i < n; i++) {
            eigenvalues.push(D[i][i]);
        }

        // V columns are eigenvectors
        return { eigenvalues, eigenvectors: V };
    }

    /**
     * Check if matrix is positive semi-definite
     */
    function isPSD(Q, tolerance = -1e-10) {
        const { eigenvalues } = eigenDecomposition(Q);
        return eigenvalues.every(lambda => lambda >= tolerance);
    }

    /**
     * Compute null space of a matrix using SVD-like approach
     * Returns array of basis vectors for null space
     */
    function computeNullSpace(A, tol = 1e-10) {
        if (A.length === 0) return [];

        const m = A.length;      // rows
        const n = A[0].length;   // cols

        // Use QR decomposition approach via Gram-Schmidt
        // First, transpose A to work with columns
        const AT = matrixTranspose(A);

        // Orthonormalize the rows of A (columns of AT)
        const ortho = gramSchmidt(A);
        const rank = ortho.filter(v => norm(v) > tol).length;

        if (rank >= n) return []; // Full rank, no null space

        // Build orthonormal complement
        // Start with standard basis, remove components in row space
        const nullBasis = [];
        const rowSpace = ortho.filter(v => norm(v) > tol).map(normalize);

        for (let i = 0; i < n; i++) {
            let ei = zeros(n);
            ei[i] = 1;

            // Remove row space components
            for (const r of rowSpace) {
                const proj = dot(ei, r);
                ei = subtract(ei, scale(r, proj));
            }

            // Remove existing null space components
            for (const ns of nullBasis) {
                const proj = dot(ei, ns);
                ei = subtract(ei, scale(ns, proj));
            }

            const eiNorm = norm(ei);
            if (eiNorm > tol) {
                nullBasis.push(scale(ei, 1 / eiNorm));
            }
        }

        return nullBasis;
    }

    /**
     * Gram-Schmidt orthogonalization
     */
    function gramSchmidt(rows) {
        const result = [];
        for (let i = 0; i < rows.length; i++) {
            let v = [...rows[i]];
            for (let j = 0; j < result.length; j++) {
                const proj = dot(v, result[j]) / dot(result[j], result[j]);
                v = subtract(v, scale(result[j], proj));
            }
            result.push(v);
        }
        return result;
    }

    /**
     * Solve linear system Ax = b using Gaussian elimination with partial pivoting
     */
    function solveLinearSystem(A, b) {
        const n = A.length;
        const aug = A.map((row, i) => [...row, b[i]]);

        // Forward elimination
        for (let col = 0; col < n; col++) {
            // Find pivot
            let maxRow = col;
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
                    maxRow = row;
                }
            }
            [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

            if (Math.abs(aug[col][col]) < 1e-12) {
                return null; // Singular matrix
            }

            // Eliminate column
            for (let row = col + 1; row < n; row++) {
                const factor = aug[row][col] / aug[col][col];
                for (let j = col; j <= n; j++) {
                    aug[row][j] -= factor * aug[col][j];
                }
            }
        }

        // Back substitution
        const x = zeros(n);
        for (let i = n - 1; i >= 0; i--) {
            x[i] = aug[i][n];
            for (let j = i + 1; j < n; j++) {
                x[i] -= aug[i][j] * x[j];
            }
            x[i] /= aug[i][i];
        }

        return x;
    }

    /**
     * Compute covariance matrix of a set of points
     */
    function computeCovariance(points) {
        if (points.length === 0) return [];
        const n = points[0].length;
        const m = points.length;

        // Compute mean
        const mean = zeros(n);
        for (const p of points) {
            for (let i = 0; i < n; i++) {
                mean[i] += p[i] / m;
            }
        }

        // Compute covariance
        const cov = matrixCreate(n, n);
        for (const p of points) {
            const centered = subtract(p, mean);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    cov[i][j] += centered[i] * centered[j] / (m - 1 || 1);
                }
            }
        }

        return cov;
    }

    /**
     * Compute mean of points
     */
    function computeMean(points) {
        if (points.length === 0) return [];
        const n = points[0].length;
        const mean = zeros(n);
        for (const p of points) {
            for (let i = 0; i < n; i++) {
                mean[i] += p[i] / points.length;
            }
        }
        return mean;
    }

    // ==================== Input Parsing ====================

    /**
     * Parse a JSON-like array string
     */
    function parseArray(str) {
        try {
            // Clean up the string
            str = str.trim();
            if (!str) return null;

            // Try to parse as JSON
            const result = JSON.parse(str);
            return result;
        } catch (e) {
            throw new Error(`Invalid array format: ${e.message}`);
        }
    }

    /**
     * Parse problem definition from UI inputs
     */
    function parseProblem(nStr, QStr, cStr, ineqStr, eqStr) {
        const errors = [];

        // Parse n
        const n = parseInt(nStr, 10);
        if (isNaN(n) || n < 1) {
            errors.push('Number of variables (n) must be a positive integer');
        }

        // Parse Q matrix
        let Q;
        try {
            Q = parseArray(QStr);
            if (!Array.isArray(Q) || !Q.every(row => Array.isArray(row))) {
                errors.push('Q must be a 2D array (matrix)');
            }
        } catch (e) {
            errors.push(`Q matrix: ${e.message}`);
        }

        // Parse c vector
        let c;
        try {
            c = parseArray(cStr);
            if (!Array.isArray(c) || c.some(v => typeof v !== 'number')) {
                errors.push('c must be an array of numbers');
            }
        } catch (e) {
            errors.push(`c vector: ${e.message}`);
        }

        // Parse inequalities
        let inequalities = [];
        try {
            if (ineqStr.trim()) {
                inequalities = parseArray(ineqStr);
                if (!Array.isArray(inequalities)) {
                    errors.push('Inequalities must be an array');
                }
            }
        } catch (e) {
            errors.push(`Inequalities: ${e.message}`);
        }

        // Parse equalities
        let equalities = [];
        try {
            if (eqStr.trim()) {
                equalities = parseArray(eqStr);
                if (!Array.isArray(equalities)) {
                    errors.push('Equalities must be an array');
                }
            }
        } catch (e) {
            errors.push(`Equalities: ${e.message}`);
        }

        if (errors.length > 0) {
            return { valid: false, errors };
        }

        // Validate dimensions
        if (Q.length !== n || Q.some(row => row.length !== n)) {
            errors.push(`Q must be ${n}x${n} matrix`);
        }

        if (c.length !== n) {
            errors.push(`c must have length ${n}`);
        }

        for (let i = 0; i < inequalities.length; i++) {
            const ineq = inequalities[i];
            if (!ineq.a || !Array.isArray(ineq.a) || ineq.a.length !== n) {
                errors.push(`Inequality ${i + 1}: 'a' must be array of length ${n}`);
            }
            if (typeof ineq.b !== 'number') {
                errors.push(`Inequality ${i + 1}: 'b' must be a number`);
            }
        }

        for (let i = 0; i < equalities.length; i++) {
            const eq = equalities[i];
            if (!eq.a || !Array.isArray(eq.a) || eq.a.length !== n) {
                errors.push(`Equality ${i + 1}: 'a' must be array of length ${n}`);
            }
            if (typeof eq.b !== 'number') {
                errors.push(`Equality ${i + 1}: 'b' must be a number`);
            }
        }

        // Check Q is symmetric
        for (let i = 0; i < n && Q; i++) {
            for (let j = i + 1; j < n; j++) {
                if (Math.abs(Q[i][j] - Q[j][i]) > 1e-10) {
                    errors.push('Q matrix must be symmetric');
                    break;
                }
            }
        }

        // Check Q is PSD
        if (Q && errors.length === 0 && !isPSD(Q)) {
            errors.push('Q matrix must be positive semi-definite');
        }

        if (errors.length > 0) {
            return { valid: false, errors };
        }

        return {
            valid: true,
            problem: {
                n,
                Q,
                c,
                inequalities,
                equalities,
                bounds: {
                    lower: new Array(n).fill(-1e6),
                    upper: new Array(n).fill(1e6)
                }
            }
        };
    }

    // ==================== Utility Functions ====================

    /**
     * Format number for display
     */
    function formatNumber(x, decimals = 4) {
        if (Math.abs(x) < 1e-10) return '0';
        if (Math.abs(x) > 1e6 || Math.abs(x) < 1e-4) {
            return x.toExponential(decimals);
        }
        return x.toFixed(decimals);
    }

    /**
     * Generate random number in range
     */
    function randomInRange(min, max) {
        return min + Math.random() * (max - min);
    }

    /**
     * Generate random unit vector
     */
    function randomUnitVector(n) {
        const v = [];
        for (let i = 0; i < n; i++) {
            v.push(randomInRange(-1, 1));
        }
        return normalize(v);
    }

    /**
     * Clamp value to range
     */
    function clamp(x, min, max) {
        return Math.max(min, Math.min(max, x));
    }

    /**
     * Check if two arrays are approximately equal
     */
    function arraysApproxEqual(a, b, tol = 1e-8) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => Math.abs(v - b[i]) < tol);
    }

    /**
     * Remove duplicate points (approximately)
     */
    function uniquePoints(points, tol = 1e-6) {
        const unique = [];
        for (const p of points) {
            let isDuplicate = false;
            for (const u of unique) {
                if (arraysApproxEqual(p, u, tol)) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                unique.push(p);
            }
        }
        return unique;
    }

    // Export public API
    return {
        // Vector operations
        add,
        subtract,
        scale,
        dot,
        norm,
        normalize,
        negate,
        zeros,
        ones,

        // Matrix operations
        matrixCreate,
        matrixIdentity,
        matrixTranspose,
        matrixMultiply,
        matVec,
        vecMat,
        matrixCopy,
        matrixAdd,
        matrixScale,

        // Decompositions
        eigenDecomposition,
        isPSD,
        computeNullSpace,
        gramSchmidt,
        solveLinearSystem,
        computeCovariance,
        computeMean,

        // Input parsing
        parseArray,
        parseProblem,

        // Utilities
        formatNumber,
        randomInRange,
        randomUnitVector,
        clamp,
        arraysApproxEqual,
        uniquePoints
    };
})();

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
}
