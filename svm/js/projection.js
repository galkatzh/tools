/**
 * projection.js - PCA and manual axis projection
 *
 * Handles projecting high-dimensional points to 2D or 3D for visualization
 */

const Projection = (function() {
    'use strict';

    /**
     * Project points using manual axis selection
     *
     * @param {Array<Array<number>>} points - Array of n-dimensional points
     * @param {Array<number>} axes - Indices of axes to project onto (e.g., [0, 1] for x1, x2)
     * @returns {Array<Array<number>>} Projected points
     */
    function manualProject(points, axes) {
        if (points.length === 0) return [];

        return points.map(point => axes.map(axis => point[axis]));
    }

    /**
     * Project points using PCA (Principal Component Analysis)
     *
     * @param {Array<Array<number>>} points - Array of n-dimensional points
     * @param {number} dimensions - Number of dimensions to project to (2 or 3)
     * @returns {Object} Object with projected points and PCA info
     */
    function pcaProject(points, dimensions = 2) {
        if (points.length === 0) {
            return {
                projectedPoints: [],
                principalComponents: [],
                eigenvalues: [],
                mean: [],
                explainedVariance: []
            };
        }

        const n = points[0].length;
        const m = points.length;

        // Center the data
        const mean = Utils.computeMean(points);
        const centered = points.map(p => Utils.subtract(p, mean));

        // Handle single point case
        if (m === 1 || allPointsSame(centered)) {
            return {
                projectedPoints: points.map(() => Utils.zeros(dimensions)),
                principalComponents: Utils.matrixIdentity(n).slice(0, dimensions),
                eigenvalues: Utils.zeros(dimensions),
                mean,
                explainedVariance: Utils.zeros(dimensions)
            };
        }

        // Compute covariance matrix
        const cov = Utils.computeCovariance(points);

        // Eigendecomposition
        const { eigenvalues, eigenvectors } = Utils.eigenDecomposition(cov);

        // Sort by eigenvalue descending
        const indexed = eigenvalues.map((val, idx) => ({ val, idx }));
        indexed.sort((a, b) => b.val - a.val);

        // Extract top principal components
        const topIndices = indexed.slice(0, dimensions).map(item => item.idx);
        const topEigenvalues = topIndices.map(i => Math.max(0, eigenvalues[i]));

        // Principal components (columns of eigenvectors matrix)
        const principalComponents = topIndices.map(i => {
            const pc = [];
            for (let j = 0; j < n; j++) {
                pc.push(eigenvectors[j][i]);
            }
            return pc;
        });

        // Project centered points onto principal components
        const projectedPoints = centered.map(p => {
            return principalComponents.map(pc => Utils.dot(p, pc));
        });

        // Compute explained variance
        const totalVariance = eigenvalues.reduce((sum, v) => sum + Math.max(0, v), 0);
        const explainedVariance = topEigenvalues.map(v =>
            totalVariance > 0 ? v / totalVariance : 0
        );

        return {
            projectedPoints,
            principalComponents,
            eigenvalues: topEigenvalues,
            mean,
            explainedVariance
        };
    }

    /**
     * Check if all points are the same
     */
    function allPointsSame(points, tol = 1e-10) {
        if (points.length <= 1) return true;
        const first = points[0];
        return points.every(p =>
            p.every((v, i) => Math.abs(v - first[i]) < tol)
        );
    }

    /**
     * Project a single point using the same projection as was computed for a set
     *
     * @param {Array<number>} point - Point to project
     * @param {Object} pcaResult - Result from pcaProject
     * @returns {Array<number>} Projected point
     */
    function projectPointWithPCA(point, pcaResult) {
        const centered = Utils.subtract(point, pcaResult.mean);
        return pcaResult.principalComponents.map(pc => Utils.dot(centered, pc));
    }

    /**
     * Get dimension labels for visualization
     */
    function getDimensionLabels(n, projectionType, axes) {
        if (projectionType === 'manual') {
            return axes.map(i => `x${i + 1}`);
        } else {
            return axes.map((_, i) => `PC${i + 1}`);
        }
    }

    /**
     * Determine the best projection dimensions based on data
     *
     * @param {number} n - Original dimension
     * @param {number} numPoints - Number of points
     * @returns {number} Suggested number of visualization dimensions (2 or 3)
     */
    function suggestVisualizationDimensions(n, numPoints) {
        // Use 3D if we have 3+ original dimensions and enough points
        if (n >= 3 && numPoints >= 4) {
            return 3;
        }
        return 2;
    }

    /**
     * Compute bounding box of projected points
     */
    function computeBoundingBox(projectedPoints) {
        if (projectedPoints.length === 0) return null;

        const dims = projectedPoints[0].length;
        const min = [...projectedPoints[0]];
        const max = [...projectedPoints[0]];

        for (const p of projectedPoints) {
            for (let i = 0; i < dims; i++) {
                min[i] = Math.min(min[i], p[i]);
                max[i] = Math.max(max[i], p[i]);
            }
        }

        return { min, max };
    }

    /**
     * Expand bounding box by a factor
     */
    function expandBoundingBox(bbox, factor = 0.1) {
        if (!bbox) return null;

        const dims = bbox.min.length;
        const newMin = [];
        const newMax = [];

        for (let i = 0; i < dims; i++) {
            const range = bbox.max[i] - bbox.min[i];
            const padding = Math.max(range * factor, 0.1);
            newMin.push(bbox.min[i] - padding);
            newMax.push(bbox.max[i] + padding);
        }

        return { min: newMin, max: newMax };
    }

    /**
     * Project polytope vertices using the same projection
     */
    function projectPolytope(vertices, projectionType, options) {
        if (vertices.length === 0) return [];

        if (projectionType === 'manual') {
            return manualProject(vertices, options.axes);
        } else {
            // Use existing PCA projection if available
            if (options.pcaResult) {
                return vertices.map(v => projectPointWithPCA(v, options.pcaResult));
            }
            // Otherwise compute new PCA (should rarely happen)
            const result = pcaProject(vertices, options.dimensions || 2);
            return result.projectedPoints;
        }
    }

    /**
     * Create projection function based on settings
     */
    function createProjectionFunction(projectionType, options) {
        if (projectionType === 'manual') {
            const axes = options.axes || [0, 1];
            return (point) => axes.map(i => point[i]);
        } else {
            // PCA projection needs to be pre-computed
            if (!options.pcaResult) {
                throw new Error('PCA projection requires pre-computed PCA result');
            }
            return (point) => projectPointWithPCA(point, options.pcaResult);
        }
    }

    /**
     * Reconstruct a point from its projection (approximate for PCA)
     */
    function reconstructFromProjection(projected, projectionType, options) {
        if (projectionType === 'manual') {
            // Can't fully reconstruct from manual projection
            const n = options.originalDimension || projected.length;
            const reconstructed = Utils.zeros(n);
            const axes = options.axes || [0, 1];
            for (let i = 0; i < projected.length; i++) {
                reconstructed[axes[i]] = projected[i];
            }
            return reconstructed;
        } else {
            // Reconstruct from PCA
            if (!options.pcaResult) {
                throw new Error('PCA reconstruction requires PCA result');
            }
            const { principalComponents, mean } = options.pcaResult;
            let reconstructed = [...mean];
            for (let i = 0; i < projected.length; i++) {
                const pc = principalComponents[i];
                for (let j = 0; j < pc.length; j++) {
                    reconstructed[j] += projected[i] * pc[j];
                }
            }
            return reconstructed;
        }
    }

    // Export public API
    return {
        manualProject,
        pcaProject,
        projectPointWithPCA,
        getDimensionLabels,
        suggestVisualizationDimensions,
        computeBoundingBox,
        expandBoundingBox,
        projectPolytope,
        createProjectionFunction,
        reconstructFromProjection
    };
})();

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Projection;
}
