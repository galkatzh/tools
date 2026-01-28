/**
 * main.js - Entry point and UI event wiring
 *
 * Connects all modules and handles user interactions
 */

(function() {
    'use strict';

    // ==================== State ====================

    let currentProblem = null;
    let currentSolution = null;
    let currentManifold = null;

    // ==================== DOM Elements ====================

    const elements = {
        // Inputs
        nInput: null,
        qInput: null,
        cInput: null,
        ineqInput: null,
        eqInput: null,

        // Controls
        projectionRadios: null,
        axisXSelect: null,
        axisYSelect: null,
        axisZSelect: null,
        sampleSlider: null,
        sampleValue: null,
        showHullCheckbox: null,
        showPolytopeCheckbox: null,

        // Buttons
        solveButton: null,
        presetSelect: null,

        // Output
        statusArea: null,
        plotContainer: null
    };

    // ==================== Initialization ====================

    function init() {
        // Get DOM elements
        elements.nInput = document.getElementById('n-input');
        elements.qInput = document.getElementById('q-input');
        elements.cInput = document.getElementById('c-input');
        elements.ineqInput = document.getElementById('ineq-input');
        elements.eqInput = document.getElementById('eq-input');

        elements.projectionRadios = document.querySelectorAll('input[name="projection"]');
        elements.axisXSelect = document.getElementById('axis-x');
        elements.axisYSelect = document.getElementById('axis-y');
        elements.axisZSelect = document.getElementById('axis-z');
        elements.sampleSlider = document.getElementById('sample-slider');
        elements.sampleValue = document.getElementById('sample-value');
        elements.showHullCheckbox = document.getElementById('show-hull');
        elements.showPolytopeCheckbox = document.getElementById('show-polytope');

        elements.solveButton = document.getElementById('solve-button');
        elements.presetSelect = document.getElementById('preset-select');

        elements.statusArea = document.getElementById('status-area');
        elements.plotContainer = document.getElementById('plot-container');

        // Set up event listeners
        setupEventListeners();

        // Populate preset dropdown
        populatePresets();

        // Load default preset
        loadPreset('linearSVM');

        // Show initial empty state
        Visualization.renderEmpty('plot-container', 'Click "Solve & Visualize" to see results');
    }

    function setupEventListeners() {
        // Solve button
        elements.solveButton.addEventListener('click', handleSolve);

        // Preset selection
        elements.presetSelect.addEventListener('change', (e) => {
            if (e.target.value) {
                loadPreset(e.target.value);
            }
        });

        // Sample count slider
        elements.sampleSlider.addEventListener('input', (e) => {
            elements.sampleValue.textContent = e.target.value;
        });

        // Re-render on visualization option changes
        elements.showHullCheckbox.addEventListener('change', rerender);
        elements.showPolytopeCheckbox.addEventListener('change', rerender);

        elements.projectionRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                updateAxisSelects();
                rerender();
            });
        });

        [elements.axisXSelect, elements.axisYSelect, elements.axisZSelect].forEach(select => {
            if (select) {
                select.addEventListener('change', rerender);
            }
        });

        // n input change updates axis selects
        elements.nInput.addEventListener('change', updateAxisSelects);
    }

    function populatePresets() {
        const presets = Presets.listPresets();
        elements.presetSelect.innerHTML = '<option value="">-- Select Preset --</option>';

        for (const preset of presets) {
            const option = document.createElement('option');
            option.value = preset.key;
            option.textContent = preset.name;
            option.title = preset.description;
            elements.presetSelect.appendChild(option);
        }
    }

    // ==================== Preset Loading ====================

    function loadPreset(key) {
        const preset = Presets.getPreset(key);
        if (!preset) return;

        const formatted = Presets.formatPresetForUI(preset);

        elements.nInput.value = formatted.n;
        elements.qInput.value = formatted.Q;
        elements.cInput.value = formatted.c;
        elements.ineqInput.value = formatted.inequalities;
        elements.eqInput.value = formatted.equalities;

        elements.presetSelect.value = key;

        updateAxisSelects();
        showStatus(`Loaded preset: ${preset.name}`, 'info');
    }

    // ==================== Axis Select Updates ====================

    function updateAxisSelects() {
        const n = parseInt(elements.nInput.value) || 2;

        // Update options for each axis select
        [elements.axisXSelect, elements.axisYSelect, elements.axisZSelect].forEach((select, idx) => {
            if (!select) return;

            const currentValue = select.value;
            select.innerHTML = '';

            for (let i = 0; i < n; i++) {
                const option = document.createElement('option');
                option.value = i.toString();
                option.textContent = `x${i + 1}`;
                select.appendChild(option);
            }

            // Restore or set default value
            if (currentValue && parseInt(currentValue) < n) {
                select.value = currentValue;
            } else {
                select.value = Math.min(idx, n - 1).toString();
            }
        });

        // Show/hide Z axis based on n
        const zContainer = elements.axisZSelect?.parentElement;
        if (zContainer) {
            zContainer.style.display = n >= 3 ? 'inline-block' : 'none';
        }
    }

    // ==================== Main Solve Function ====================

    function handleSolve() {
        // Show loading state
        Visualization.renderLoading('plot-container');
        showStatus('Solving...', 'info');

        // Use setTimeout to allow UI to update
        setTimeout(() => {
            try {
                // Parse problem
                const parseResult = Utils.parseProblem(
                    elements.nInput.value,
                    elements.qInput.value,
                    elements.cInput.value,
                    elements.ineqInput.value,
                    elements.eqInput.value
                );

                if (!parseResult.valid) {
                    showStatus('Input errors:\n' + parseResult.errors.join('\n'), 'error');
                    Visualization.renderError('plot-container', 'Invalid input. Check errors above.');
                    return;
                }

                currentProblem = parseResult.problem;

                // Solve the QP
                currentSolution = Solver.solve(currentProblem);

                if (currentSolution.status === 'infeasible') {
                    showStatus('Problem is infeasible - no solution exists.', 'error');
                    Visualization.renderError('plot-container', 'Infeasible problem');
                    return;
                }

                if (currentSolution.status === 'error') {
                    showStatus('Solver error: ' + currentSolution.message, 'error');
                    Visualization.renderError('plot-container', 'Solver failed');
                    return;
                }

                // Sample optimal manifold
                const sampleCount = parseInt(elements.sampleSlider.value) || 100;
                currentManifold = Sampling.sampleOptimalSet(
                    currentProblem,
                    currentSolution,
                    { sampleCount }
                );

                // Update status
                const dimText = getDimensionText(currentManifold.dimension);
                showStatus(
                    `Optimal solution found.\n` +
                    `Objective value: ${Utils.formatNumber(currentSolution.objectiveValue)}\n` +
                    `Manifold dimension: ${currentManifold.dimension} (${dimText})\n` +
                    `Sampled ${currentManifold.points.length} point(s)`,
                    'success'
                );

                // Render visualization
                renderVisualization();

            } catch (e) {
                console.error('Solve error:', e);
                showStatus('Error: ' + e.message, 'error');
                Visualization.renderError('plot-container', 'An error occurred');
            }
        }, 50);
    }

    function getDimensionText(dim) {
        if (dim === 0) return 'unique point';
        if (dim === 1) return 'line segment';
        if (dim === 2) return '2D face';
        return `${dim}D manifold`;
    }

    // ==================== Visualization ====================

    function renderVisualization() {
        if (!currentProblem || !currentManifold) {
            Visualization.renderEmpty('plot-container');
            return;
        }

        const n = currentProblem.n;

        // Determine projection
        const projectionType = document.querySelector('input[name="projection"]:checked')?.value || 'manual';

        // Get projection settings
        let projectedPoints, labels, pcaResult;

        if (projectionType === 'pca') {
            // PCA projection
            const points = currentManifold.points.map(p => p.x);
            const dims = n <= 3 ? n : (n >= 3 ? 3 : 2);
            pcaResult = Projection.pcaProject(points, Math.min(dims, 3));
            projectedPoints = pcaResult.projectedPoints;

            labels = [];
            for (let i = 0; i < projectedPoints[0]?.length || 0; i++) {
                const variance = pcaResult.explainedVariance[i];
                labels.push(`PC${i + 1} (${(variance * 100).toFixed(1)}%)`);
            }
        } else {
            // Manual projection
            const axes = [
                parseInt(elements.axisXSelect.value) || 0,
                parseInt(elements.axisYSelect.value) || 1
            ];

            if (n >= 3) {
                axes.push(parseInt(elements.axisZSelect.value) || 2);
            }

            const points = currentManifold.points.map(p => p.x);
            projectedPoints = Projection.manualProject(points, axes);
            labels = axes.map(i => `x${i + 1}`);
        }

        // Compute polytope if n <= 3
        let polytopeVertices = [];
        let polytopeFaces = [];

        if (n <= 3 && elements.showPolytopeCheckbox.checked) {
            const polytopeResult = Polytope.computePolytope(currentProblem);
            if (polytopeResult.feasible) {
                if (projectionType === 'pca' && pcaResult) {
                    polytopeVertices = Projection.projectPolytope(
                        polytopeResult.vertices,
                        'pca',
                        { pcaResult, dimensions: projectedPoints[0]?.length || 2 }
                    );
                } else {
                    polytopeVertices = polytopeResult.vertices;
                }
                polytopeFaces = polytopeResult.faces || [];
            }
        }

        // Compute convex hull indices
        let hullIndices = [];
        if (elements.showHullCheckbox.checked && projectedPoints.length >= 3) {
            const dims = projectedPoints[0]?.length || 2;
            if (dims === 2) {
                hullIndices = Polytope.computeConvexHull2D(projectedPoints);
            }
            // 3D hull is computed in visualization.js
        }

        // Prepare visualization data
        const vizData = {
            projectedPoints,
            fullPointsData: currentManifold.points,
            polytopeVertices,
            polytopeFaces,
            hullIndices,
            dimensions: projectedPoints[0]?.length || 2,
            labels
        };

        const vizOptions = {
            showPolytope: elements.showPolytopeCheckbox.checked && n <= 3,
            showHull: elements.showHullCheckbox.checked,
            showPoints: true
        };

        // Render
        if (n === 1) {
            Visualization.render1D('plot-container', vizData, vizOptions);
        } else {
            Visualization.render('plot-container', vizData, vizOptions);
        }
    }

    function rerender() {
        if (currentProblem && currentManifold) {
            renderVisualization();
        }
    }

    // ==================== Status Display ====================

    function showStatus(message, type = 'info') {
        elements.statusArea.textContent = message;
        elements.statusArea.className = 'status-area status-' + type;
    }

    // ==================== Start ====================

    // Wait for DOM and libraries to load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
