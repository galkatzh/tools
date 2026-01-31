/**
 * solver.js - Built-in QP solver using Active Set method
 *
 * Solves: minimize ½x'Qx + c'x
 *         subject to: A_eq x = b_eq
 *                    A_ineq x <= b_ineq
 */

const Solver = (function() {
    'use strict';

    const MAX_ITERATIONS = 1000;
    const TOLERANCE = 1e-10;

    /**
     * Solve the QP problem using Active Set method
     */
    function solve(problem) {
        try {
            const { n, Q, c, inequalities, equalities } = problem;

            // Handle unconstrained case
            if (inequalities.length === 0 && equalities.length === 0) {
                return solveUnconstrained(problem);
            }

            // Find initial feasible point
            const x0 = findFeasiblePoint(problem);
            if (x0 === null) {
                return {
                    status: 'infeasible',
                    message: 'Problem is infeasible - no solution satisfies all constraints'
                };
            }

            // Run active set method
            const result = activeSetMethod(problem, x0);
            return result;

        } catch (e) {
            return {
                status: 'error',
                message: `Solver error: ${e.message}`
            };
        }
    }

    /**
     * Solve unconstrained QP: minimize ½x'Qx + c'x
     * Solution: Qx = -c
     */
    function solveUnconstrained(problem) {
        const { Q, c, n } = problem;

        // Add small regularization for numerical stability
        const Qreg = Q.map((row, i) => row.map((v, j) => i === j ? v + 1e-12 : v));

        const x = Utils.solveLinearSystem(Qreg, Utils.negate(c));

        if (x === null) {
            // Singular Q - check if problem is unbounded
            // For PSD Q, if Qx = -c has no solution, problem may be unbounded
            // Try to find minimum norm solution
            const xZero = Utils.zeros(n);
            return {
                status: 'optimal',
                x: xZero,
                objectiveValue: computeObjective(problem, xZero),
                dualVariables: { inequalities: [], equalities: [] },
                activeConstraints: []
            };
        }

        const obj = computeObjective(problem, x);
        return {
            status: 'optimal',
            x,
            objectiveValue: obj,
            dualVariables: { inequalities: [], equalities: [] },
            activeConstraints: []
        };
    }

    /**
     * Find an initial feasible point using Phase 1 simplex-like approach
     */
    function findFeasiblePoint(problem) {
        const { n, inequalities, equalities } = problem;

        // Start with origin
        let x = Utils.zeros(n);

        // Check if origin is feasible
        if (isFeasible(problem, x)) {
            return x;
        }

        // Try to find feasible point by minimizing constraint violations
        // Use gradient descent on sum of squared violations
        for (let iter = 0; iter < 100; iter++) {
            let gradient = Utils.zeros(n);
            let totalViolation = 0;

            // Equality violations
            for (const eq of equalities) {
                const violation = Utils.dot(eq.a, x) - eq.b;
                totalViolation += violation * violation;
                for (let i = 0; i < n; i++) {
                    gradient[i] += 2 * violation * eq.a[i];
                }
            }

            // Inequality violations
            for (const ineq of inequalities) {
                const slack = Utils.dot(ineq.a, x) - ineq.b;
                if (slack > 0) {
                    totalViolation += slack * slack;
                    for (let i = 0; i < n; i++) {
                        gradient[i] += 2 * slack * ineq.a[i];
                    }
                }
            }

            if (totalViolation < TOLERANCE) {
                return x;
            }

            // Line search
            const gradNorm = Utils.norm(gradient);
            if (gradNorm < TOLERANCE) break;

            const direction = Utils.scale(gradient, -1 / gradNorm);
            let step = 1.0;

            for (let ls = 0; ls < 20; ls++) {
                const xNew = Utils.add(x, Utils.scale(direction, step));
                let newViolation = 0;

                for (const eq of equalities) {
                    const v = Utils.dot(eq.a, xNew) - eq.b;
                    newViolation += v * v;
                }
                for (const ineq of inequalities) {
                    const s = Utils.dot(ineq.a, xNew) - ineq.b;
                    if (s > 0) newViolation += s * s;
                }

                if (newViolation < totalViolation) {
                    x = xNew;
                    break;
                }
                step *= 0.5;
            }
        }

        // Final check
        if (isFeasible(problem, x, 1e-6)) {
            return x;
        }

        // Try random starting points
        for (let trial = 0; trial < 10; trial++) {
            x = Utils.zeros(n).map(() => Utils.randomInRange(-10, 10));
            if (isFeasible(problem, x, 1e-6)) {
                return x;
            }
        }

        return null;
    }

    /**
     * Active Set Method for QP
     */
    function activeSetMethod(problem, x0) {
        const { n, Q, c, inequalities, equalities } = problem;

        let x = [...x0];
        let activeSet = new Set(); // Indices of active inequality constraints

        // Initialize active set with binding inequalities
        for (let i = 0; i < inequalities.length; i++) {
            const slack = inequalities[i].b - Utils.dot(inequalities[i].a, x);
            if (Math.abs(slack) < TOLERANCE) {
                activeSet.add(i);
            }
        }

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            // Solve equality-constrained QP with current active set
            const eqpResult = solveEqualityConstrainedQP(problem, x, activeSet);

            if (eqpResult.step === null) {
                // Current point is optimal for equality-constrained problem
                // Check if all Lagrange multipliers are non-negative
                const minLambdaIdx = findMostNegativeLambda(eqpResult.lambdas, activeSet);

                if (minLambdaIdx === -1) {
                    // All multipliers non-negative - we're done!
                    const obj = computeObjective(problem, x);
                    const activeConstraints = findActiveConstraints(problem, x);

                    return {
                        status: 'optimal',
                        x,
                        objectiveValue: obj,
                        dualVariables: extractDualVariables(problem, eqpResult.lambdas, activeSet),
                        activeConstraints
                    };
                } else {
                    // Remove constraint with most negative multiplier
                    activeSet.delete(minLambdaIdx);
                }
            } else {
                // Take step towards equality-constrained solution
                const p = eqpResult.step;

                // Find step length (stay feasible)
                let alpha = 1.0;
                let blockingConstraint = -1;

                for (let i = 0; i < inequalities.length; i++) {
                    if (activeSet.has(i)) continue;

                    const ai = inequalities[i].a;
                    const bi = inequalities[i].b;
                    const ap = Utils.dot(ai, p);

                    if (ap > TOLERANCE) {
                        const slack = bi - Utils.dot(ai, x);
                        const maxStep = slack / ap;
                        if (maxStep < alpha) {
                            alpha = maxStep;
                            blockingConstraint = i;
                        }
                    }
                }

                // Update x
                x = Utils.add(x, Utils.scale(p, alpha));

                // Add blocking constraint to active set
                if (blockingConstraint >= 0 && alpha < 1.0 - TOLERANCE) {
                    activeSet.add(blockingConstraint);
                }
            }
        }

        // Max iterations reached - return current best
        const obj = computeObjective(problem, x);
        return {
            status: 'optimal',
            x,
            objectiveValue: obj,
            dualVariables: {
                inequalities: inequalities.map(() => 0),
                equalities: equalities.map(() => 0)
            },
            activeConstraints: findActiveConstraints(problem, x)
        };
    }

    /**
     * Solve QP with equality constraints (including active inequalities)
     * Returns step direction or null if at optimum
     */
    function solveEqualityConstrainedQP(problem, x, activeSet) {
        const { n, Q, c, equalities, inequalities } = problem;

        // Build constraint matrix for active constraints
        const constraints = [];

        // Add equality constraints
        for (const eq of equalities) {
            constraints.push({ a: eq.a, b: eq.b });
        }

        // Add active inequality constraints (as equalities)
        for (const idx of activeSet) {
            constraints.push({ a: inequalities[idx].a, b: inequalities[idx].b });
        }

        const m = constraints.length;

        if (m === 0) {
            // No active constraints - solve unconstrained
            // Step: p = -Q^(-1)(Qx + c) = -Q^(-1)g where g is gradient
            const g = Utils.add(Utils.matVec(Q, x), c);
            const Qreg = Q.map((row, i) => row.map((v, j) => i === j ? v + 1e-12 : v));
            const p = Utils.solveLinearSystem(Qreg, Utils.negate(g));

            if (p === null || Utils.norm(p) < TOLERANCE) {
                return { step: null, lambdas: [] };
            }
            return { step: p, lambdas: [] };
        }

        // Build KKT system:
        // [Q  A'][p     ]   [-g]
        // [A  0 ][lambda] = [0 ]
        // where g = Qx + c, A is constraint matrix

        const g = Utils.add(Utils.matVec(Q, x), c);
        const kktSize = n + m;
        const KKT = Utils.matrixCreate(kktSize, kktSize);
        const rhs = Utils.zeros(kktSize);

        // Fill Q block (with regularization)
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                KKT[i][j] = Q[i][j] + (i === j ? 1e-12 : 0);
            }
            rhs[i] = -g[i];
        }

        // Fill A and A' blocks
        for (let i = 0; i < m; i++) {
            const ai = constraints[i].a;
            for (let j = 0; j < n; j++) {
                KKT[n + i][j] = ai[j];     // A block
                KKT[j][n + i] = ai[j];     // A' block
            }
            // rhs[n + i] = 0 (already zero) - constraints are satisfied at x
            // Actually, compute residual
            rhs[n + i] = constraints[i].b - Utils.dot(ai, x);
        }

        const solution = Utils.solveLinearSystem(KKT, rhs);

        if (solution === null) {
            // Singular KKT - at a vertex
            return { step: null, lambdas: Utils.zeros(m) };
        }

        const p = solution.slice(0, n);
        const lambdas = solution.slice(n);

        if (Utils.norm(p) < TOLERANCE) {
            return { step: null, lambdas };
        }

        return { step: p, lambdas };
    }

    /**
     * Find index of most negative Lagrange multiplier for inequalities
     */
    function findMostNegativeLambda(lambdas, activeSet) {
        // Lambdas are ordered: [equalities..., active inequalities...]
        // We only check the inequality part

        let minVal = -TOLERANCE;
        let minIdx = -1;

        const activeArray = Array.from(activeSet);
        const numEq = lambdas.length - activeArray.length;

        for (let i = 0; i < activeArray.length; i++) {
            const lambda = lambdas[numEq + i];
            if (lambda < minVal) {
                minVal = lambda;
                minIdx = activeArray[i];
            }
        }

        return minIdx;
    }

    /**
     * Extract dual variables from KKT solution
     */
    function extractDualVariables(problem, lambdas, activeSet) {
        const { equalities, inequalities } = problem;

        const dualEq = lambdas.slice(0, equalities.length);
        const dualIneq = inequalities.map(() => 0);

        const activeArray = Array.from(activeSet);
        for (let i = 0; i < activeArray.length; i++) {
            const lambda = lambdas[equalities.length + i];
            dualIneq[activeArray[i]] = Math.max(0, lambda);
        }

        return {
            equalities: dualEq,
            inequalities: dualIneq
        };
    }

    /**
     * Compute objective value: ½x'Qx + c'x
     */
    function computeObjective(problem, x) {
        const { Q, c } = problem;
        let quadTerm = 0;
        for (let i = 0; i < x.length; i++) {
            for (let j = 0; j < x.length; j++) {
                quadTerm += Q[i][j] * x[i] * x[j];
            }
        }
        const linearTerm = Utils.dot(c, x);
        return 0.5 * quadTerm + linearTerm;
    }

    /**
     * Find active constraints at a point
     */
    function findActiveConstraints(problem, x, tol = 1e-6) {
        const active = [];
        let idx = 0;

        // Check equalities (always active)
        for (let i = 0; i < problem.equalities.length; i++) {
            active.push(idx);
            idx++;
        }

        // Check inequalities
        for (let i = 0; i < problem.inequalities.length; i++) {
            const ineq = problem.inequalities[i];
            const lhs = Utils.dot(ineq.a, x);
            if (Math.abs(lhs - ineq.b) < tol) {
                active.push(idx);
            }
            idx++;
        }

        return active;
    }

    /**
     * Check if a point is feasible
     */
    function isFeasible(problem, x, tol = 1e-6) {
        // Check equalities
        for (const eq of problem.equalities) {
            const lhs = Utils.dot(eq.a, x);
            if (Math.abs(lhs - eq.b) > tol) {
                return false;
            }
        }

        // Check inequalities
        for (const ineq of problem.inequalities) {
            const lhs = Utils.dot(ineq.a, x);
            if (lhs > ineq.b + tol) {
                return false;
            }
        }

        // Check bounds
        if (problem.bounds) {
            for (let i = 0; i < x.length; i++) {
                if (x[i] < problem.bounds.lower[i] - tol ||
                    x[i] > problem.bounds.upper[i] + tol) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Get constraint gradient (for linear constraints, this is just 'a')
     */
    function getConstraintGradient(problem, constraintIdx) {
        if (constraintIdx < problem.equalities.length) {
            return problem.equalities[constraintIdx].a;
        } else {
            return problem.inequalities[constraintIdx - problem.equalities.length].a;
        }
    }

    /**
     * Compute dual variables at a given primal point using KKT conditions
     */
    function computeDualAtPoint(problem, x, activeMask) {
        const { Q, c, equalities, inequalities } = problem;
        const n = problem.n;

        // Gradient of objective at x
        const gradObj = Utils.add(Utils.matVec(Q, x), c);

        // Collect active constraint gradients
        const activeGradients = [];

        for (let i = 0; i < equalities.length; i++) {
            activeGradients.push(equalities[i].a);
        }

        for (let i = 0; i < inequalities.length; i++) {
            if (!activeMask || activeMask[i]) {
                const lhs = Utils.dot(inequalities[i].a, x);
                if (Math.abs(lhs - inequalities[i].b) < 1e-6) {
                    activeGradients.push(inequalities[i].a);
                }
            }
        }

        if (activeGradients.length === 0) {
            return {
                equalities: [],
                inequalities: inequalities.map(() => 0)
            };
        }

        // Solve least squares: find lambdas such that sum(lambda_i * a_i) = gradObj
        const A = activeGradients;
        const k = A.length;

        const ATA = Utils.matrixCreate(k, k);
        const ATb = [];

        for (let i = 0; i < k; i++) {
            ATb.push(Utils.dot(A[i], gradObj));
            for (let j = 0; j < k; j++) {
                ATA[i][j] = Utils.dot(A[i], A[j]);
            }
        }

        const lambdas = Utils.solveLinearSystem(ATA, ATb);

        // Distribute lambdas back to constraints
        const dualEq = [];
        const dualIneq = inequalities.map(() => 0);

        let lambdaIdx = 0;
        for (let i = 0; i < equalities.length; i++) {
            dualEq.push(lambdas ? lambdas[lambdaIdx++] : 0);
        }

        for (let i = 0; i < inequalities.length; i++) {
            const lhs = Utils.dot(inequalities[i].a, x);
            if (Math.abs(lhs - inequalities[i].b) < 1e-6) {
                dualIneq[i] = lambdas ? Math.max(0, lambdas[lambdaIdx++]) : 0;
            }
        }

        return {
            equalities: dualEq,
            inequalities: dualIneq
        };
    }

    // Export public API
    return {
        solve,
        computeObjective,
        findActiveConstraints,
        isFeasible,
        getConstraintGradient,
        computeDualAtPoint
    };
})();

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Solver;
}
