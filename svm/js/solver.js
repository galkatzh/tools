/**
 * solver.js - QP solver interface using quadprog
 *
 * Converts problem format and interfaces with the quadprog library
 */

const Solver = (function() {
    'use strict';

    /**
     * Convert our problem format to quadprog format
     *
     * Our format:
     *   minimize: ½x'Qx + c'x
     *   subject to: a'x ≤ b (inequalities)
     *              a'x = b (equalities)
     *
     * quadprog format:
     *   minimize: ½x'Dmat x - dvec'x
     *   subject to: Amat' x >= bvec
     *   (first meq constraints are equalities)
     */
    function convertToQuadprog(problem) {
        const { n, Q, c, inequalities, equalities } = problem;

        // Dmat = Q (symmetric positive semi-definite)
        // Note: quadprog requires strictly positive definite, so we add small regularization
        const Dmat = Q.map((row, i) => row.map((v, j) => i === j ? v + 1e-10 : v));

        // dvec = -c (quadprog minimizes ½x'Dx - d'x, we minimize ½x'Qx + c'x)
        const dvec = c.map(v => -v);

        // Build constraint matrix
        // quadprog wants: Amat' x >= bvec
        //
        // For equalities a'x = b:   add as a'x >= b (will be marked as equality)
        // For inequalities a'x <= b: convert to -a'x >= -b

        const numConstraints = equalities.length + inequalities.length;

        if (numConstraints === 0) {
            // No constraints - solve unconstrained QP
            return {
                Dmat,
                dvec,
                Amat: null,
                bvec: null,
                meq: 0
            };
        }

        // Amat is n x m where m is number of constraints
        // Amat[i][j] = coefficient of x_i in constraint j
        const Amat = Utils.matrixCreate(n, numConstraints);
        const bvec = [];

        // First add equalities (these come first in quadprog)
        let constraintIdx = 0;
        for (const eq of equalities) {
            for (let i = 0; i < n; i++) {
                Amat[i][constraintIdx] = eq.a[i];
            }
            bvec.push(eq.b);
            constraintIdx++;
        }

        // Then add inequalities (converted to >= form)
        for (const ineq of inequalities) {
            for (let i = 0; i < n; i++) {
                Amat[i][constraintIdx] = -ineq.a[i];
            }
            bvec.push(-ineq.b);
            constraintIdx++;
        }

        return {
            Dmat,
            dvec,
            Amat,
            bvec,
            meq: equalities.length
        };
    }

    /**
     * Solve the QP problem
     * Returns solution object with status, primal solution, objective value, and dual variables
     */
    function solve(problem) {
        // Check if quadprog is available
        if (typeof solveQP === 'undefined') {
            return {
                status: 'error',
                message: 'quadprog library not loaded'
            };
        }

        try {
            const { Dmat, dvec, Amat, bvec, meq } = convertToQuadprog(problem);

            let result;
            if (Amat === null) {
                // Unconstrained - solve Qx = -c
                const x = Utils.solveLinearSystem(problem.Q, Utils.negate(problem.c));
                if (x === null) {
                    // Singular Q, check if c is in range
                    return {
                        status: 'unbounded',
                        message: 'Unconstrained problem with singular Q matrix'
                    };
                }
                const obj = computeObjective(problem, x);
                return {
                    status: 'optimal',
                    x,
                    objectiveValue: obj,
                    dualVariables: {
                        inequalities: [],
                        equalities: []
                    },
                    activeConstraints: []
                };
            }

            // Call quadprog solver
            result = solveQP(Dmat, dvec, Amat, bvec, meq);

            if (result.message && result.message.includes('infeasible')) {
                return {
                    status: 'infeasible',
                    message: 'Problem is infeasible - no solution satisfies all constraints'
                };
            }

            if (!result.solution || result.solution.some(isNaN)) {
                return {
                    status: 'error',
                    message: result.message || 'Solver failed to find a solution'
                };
            }

            // Extract solution
            const x = result.solution;

            // Compute objective value: ½x'Qx + c'x
            const obj = computeObjective(problem, x);

            // Extract dual variables (Lagrange multipliers)
            const lagrangian = result.Lagrangian || [];
            const dualVariables = {
                equalities: lagrangian.slice(0, problem.equalities.length),
                inequalities: lagrangian.slice(problem.equalities.length).map(v => Math.abs(v))
            };

            // Find active constraints
            const activeConstraints = findActiveConstraints(problem, x);

            return {
                status: 'optimal',
                x,
                objectiveValue: obj,
                dualVariables,
                activeConstraints
            };

        } catch (e) {
            // quadprog throws on infeasibility
            if (e.message && e.message.includes('infeasible')) {
                return {
                    status: 'infeasible',
                    message: 'Problem is infeasible - no solution satisfies all constraints'
                };
            }
            return {
                status: 'error',
                message: `Solver error: ${e.message}`
            };
        }
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
     * Solve for optimal x in a direction within the optimal manifold
     * This is used to explore the set of optimal solutions
     */
    function solveInDirection(problem, optimalValue, direction) {
        // Minimize direction'x subject to original constraints + objective constraint
        const modifiedProblem = {
            n: problem.n,
            Q: Utils.matrixCreate(problem.n, problem.n), // zero matrix
            c: direction,
            inequalities: [...problem.inequalities],
            equalities: [...problem.equalities]
        };

        // Add objective constraint: ½x'Qx + c'x <= optimalValue + epsilon
        // For convex QP, optimal set is convex and can be characterized by
        // fixing objective at optimal value

        // Actually, for exploration we'll use a different approach
        // in sampling.js that doesn't require this

        return solve(modifiedProblem);
    }

    /**
     * Compute dual variables at a given primal point using KKT conditions
     */
    function computeDualAtPoint(problem, x, activeMask) {
        // For linear constraints, the KKT conditions give us:
        // Qx + c = sum(lambda_i * a_i) for active constraints
        //
        // This is a linear system we can solve for the multipliers

        const { Q, c, equalities, inequalities } = problem;
        const n = problem.n;

        // Gradient of objective at x
        const gradObj = Utils.add(Utils.matVec(Q, x), c);

        // Collect active constraint gradients
        const activeGradients = [];
        const activeTypes = []; // 'eq' or 'ineq'

        for (let i = 0; i < equalities.length; i++) {
            activeGradients.push(equalities[i].a);
            activeTypes.push('eq');
        }

        for (let i = 0; i < inequalities.length; i++) {
            if (!activeMask || activeMask[i]) {
                const lhs = Utils.dot(inequalities[i].a, x);
                if (Math.abs(lhs - inequalities[i].b) < 1e-6) {
                    activeGradients.push(inequalities[i].a);
                    activeTypes.push('ineq');
                }
            }
        }

        if (activeGradients.length === 0) {
            return {
                equalities: [],
                inequalities: inequalities.map(() => 0)
            };
        }

        // Solve: A * lambda = gradObj (least squares if overdetermined)
        // where A = [a_1, a_2, ..., a_k]' and we want to find lambda such that
        // sum(lambda_i * a_i) = gradObj

        // Build A matrix (k x n) where k is number of active constraints
        const A = activeGradients;
        const k = A.length;

        // Solve A' * A * lambda = A' * gradObj
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

        let ineqIdx = 0;
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
