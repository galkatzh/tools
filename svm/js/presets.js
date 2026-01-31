/**
 * presets.js - Built-in example problems
 *
 * Contains preset QP problems including linear SVM
 */

const Presets = (function() {
    'use strict';

    /**
     * Linear SVM with 2D sample data
     *
     * Data points:
     *   Class +1: (2,2), (3,3)
     *   Class -1: (0,0), (1,1)
     *
     * SVM formulation:
     *   minimize: ½(w1² + w2²)
     *   subject to: y_i(w·x_i + b) >= 1 for all i
     *
     * Variables: x = [w1, w2, b]
     */
    const linearSVM = {
        name: 'Linear SVM (2D)',
        description: '2D linear SVM with 4 sample points. Finds maximum margin hyperplane.',
        n: 3,
        Q: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 0]
        ],
        c: [0, 0, 0],
        inequalities: [
            // y_i(w·x_i + b) >= 1  =>  -y_i(w·x_i + b) <= -1
            // Point (2,2), y=+1:  -(2*w1 + 2*w2 + b) <= -1
            { a: [-2, -2, -1], b: -1 },
            // Point (3,3), y=+1:  -(3*w1 + 3*w2 + b) <= -1
            { a: [-3, -3, -1], b: -1 },
            // Point (0,0), y=-1:  -(-1)(0 + 0 + b) <= -1  =>  b <= -1
            { a: [0, 0, 1], b: -1 },
            // Point (1,1), y=-1:  -(-1)(w1 + w2 + b) <= -1  =>  w1 + w2 + b <= -1
            { a: [1, 1, 1], b: -1 }
        ],
        equalities: []
    };

    /**
     * Simple 2D QP with unique solution
     *
     * minimize: x² + y²
     * subject to: x + y >= 2
     *
     * Optimal: x = y = 1, objective = 2
     */
    const simple2D = {
        name: 'Simple 2D QP',
        description: 'Minimize quadratic with one linear constraint. Unique optimal solution.',
        n: 2,
        Q: [
            [2, 0],
            [0, 2]
        ],
        c: [0, 0],
        inequalities: [
            { a: [-1, -1], b: -2 }  // x + y >= 2 => -x - y <= -2
        ],
        equalities: []
    };

    /**
     * Linear program with multiple optimal solutions
     *
     * minimize: x + y
     * subject to: x >= 0, y >= 0, x + y <= 2
     *
     * Optimal set: all points on line x + y = 0 with x,y >= 0
     * (the entire edge from (0,0) along the boundary)
     * Actually: min is at x=y=0
     */
    const linearProgram = {
        name: 'Linear Program',
        description: 'LP with multiple optimal solutions forming a line segment.',
        n: 2,
        Q: [
            [0, 0],
            [0, 0]
        ],
        c: [1, 1],
        inequalities: [
            { a: [-1, 0], b: 0 },   // x >= 0
            { a: [0, -1], b: 0 },   // y >= 0
            { a: [1, 1], b: 2 }     // x + y <= 2
        ],
        equalities: []
    };

    /**
     * QP with equality constraint
     *
     * minimize: (x-1)² + (y-1)²
     * subject to: x + y = 1
     *
     * Optimal: x = y = 0.5
     */
    const equalityConstrained = {
        name: 'Equality Constrained QP',
        description: 'QP with equality constraint. Solution lies on the constraint line.',
        n: 2,
        Q: [
            [2, 0],
            [0, 2]
        ],
        c: [-2, -2],
        inequalities: [],
        equalities: [
            { a: [1, 1], b: 1 }
        ]
    };

    /**
     * 3D QP problem
     *
     * minimize: x² + y² + z²
     * subject to: x + y + z >= 3
     *
     * Optimal: x = y = z = 1
     */
    const simple3D = {
        name: 'Simple 3D QP',
        description: '3D quadratic with one constraint. Shows 3D visualization.',
        n: 3,
        Q: [
            [2, 0, 0],
            [0, 2, 0],
            [0, 0, 2]
        ],
        c: [0, 0, 0],
        inequalities: [
            { a: [-1, -1, -1], b: -3 }  // x + y + z >= 3
        ],
        equalities: []
    };

    /**
     * QP with degenerate solution (line of optima)
     *
     * minimize: x²
     * subject to: y >= 0, y <= 1, x >= 1
     *
     * Optimal: x = 1, any y in [0, 1]
     */
    const lineOfOptima = {
        name: 'Line of Optimal Solutions',
        description: 'QP where optimal solutions form a line segment (degenerate).',
        n: 2,
        Q: [
            [2, 0],
            [0, 0]
        ],
        c: [0, 0],
        inequalities: [
            { a: [-1, 0], b: -1 },  // x >= 1
            { a: [0, -1], b: 0 },   // y >= 0
            { a: [0, 1], b: 1 }     // y <= 1
        ],
        equalities: []
    };

    /**
     * Portfolio optimization example
     *
     * 2 assets with expected returns r1=0.1, r2=0.05
     * Covariance matrix: [[0.04, 0.01], [0.01, 0.02]]
     *
     * minimize: risk = w'Σw
     * subject to: w1 + w2 = 1 (fully invested)
     *            expected return >= 0.07
     *            w1, w2 >= 0 (no short selling)
     */
    const portfolio = {
        name: 'Portfolio Optimization',
        description: 'Markowitz portfolio with 2 assets. Minimize risk for target return.',
        n: 2,
        Q: [
            [0.08, 0.02],  // 2 * covariance matrix
            [0.02, 0.04]
        ],
        c: [0, 0],
        inequalities: [
            { a: [-0.1, -0.05], b: -0.07 },  // 0.1*w1 + 0.05*w2 >= 0.07
            { a: [-1, 0], b: 0 },             // w1 >= 0
            { a: [0, -1], b: 0 }              // w2 >= 0
        ],
        equalities: [
            { a: [1, 1], b: 1 }  // w1 + w2 = 1
        ]
    };

    /**
     * Infeasible problem example
     */
    const infeasible = {
        name: 'Infeasible Problem',
        description: 'Example of an infeasible QP (no solution satisfies all constraints).',
        n: 2,
        Q: [
            [2, 0],
            [0, 2]
        ],
        c: [0, 0],
        inequalities: [
            { a: [1, 0], b: -1 },   // x <= -1
            { a: [-1, 0], b: -1 }   // x >= 1
        ],
        equalities: []
    };

    /**
     * Least squares with bounds
     *
     * minimize: (x - 3)² + (y - 3)²
     * subject to: 0 <= x <= 2, 0 <= y <= 2
     *
     * Optimal: x = y = 2 (projected onto feasible region)
     */
    const boundedLeastSquares = {
        name: 'Bounded Least Squares',
        description: 'Project a point onto a box constraint.',
        n: 2,
        Q: [
            [2, 0],
            [0, 2]
        ],
        c: [-6, -6],  // -2 * target
        inequalities: [
            { a: [-1, 0], b: 0 },  // x >= 0
            { a: [1, 0], b: 2 },   // x <= 2
            { a: [0, -1], b: 0 },  // y >= 0
            { a: [0, 1], b: 2 }    // y <= 2
        ],
        equalities: []
    };

    // Collection of all presets
    const allPresets = {
        linearSVM,
        simple2D,
        linearProgram,
        equalityConstrained,
        simple3D,
        lineOfOptima,
        portfolio,
        infeasible,
        boundedLeastSquares
    };

    /**
     * Get a preset by key
     */
    function getPreset(key) {
        return allPresets[key] || null;
    }

    /**
     * Get list of all preset keys and names
     */
    function listPresets() {
        return Object.entries(allPresets).map(([key, preset]) => ({
            key,
            name: preset.name,
            description: preset.description
        }));
    }

    /**
     * Format a preset for display in the UI
     * Matrices: one row per line
     * Constraints: one constraint per line
     */
    function formatPresetForUI(preset) {
        // Format matrix: one row per line
        const formatMatrix = (matrix) => {
            const rows = matrix.map(row => '  ' + JSON.stringify(row));
            return '[\n' + rows.join(',\n') + '\n]';
        };

        // Format constraints: one per line
        const formatConstraints = (constraints) => {
            if (constraints.length === 0) return '[]';
            const items = constraints.map(c => '  ' + JSON.stringify(c));
            return '[\n' + items.join(',\n') + '\n]';
        };

        return {
            n: preset.n.toString(),
            Q: formatMatrix(preset.Q),
            c: JSON.stringify(preset.c),
            inequalities: formatConstraints(preset.inequalities),
            equalities: formatConstraints(preset.equalities)
        };
    }

    // Export public API
    return {
        getPreset,
        listPresets,
        formatPresetForUI,
        // Direct access to presets
        linearSVM,
        simple2D,
        linearProgram,
        equalityConstrained,
        simple3D,
        lineOfOptima,
        portfolio,
        infeasible,
        boundedLeastSquares
    };
})();

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Presets;
}
