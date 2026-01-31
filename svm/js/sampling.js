/**
 * sampling.js - Optimal manifold sampling algorithms
 *
 * Handles finding multiple optimal points when the QP has non-unique solutions
 */

const Sampling = (function() {
    'use strict';

    /**
     * Sample the optimal manifold of a QP problem
     *
     * @param {Object} problem - The QP problem definition
     * @param {Object} initialSolution - Initial optimal solution from solver
     * @param {number} sampleCount - Number of samples to generate
     * @returns {Object} Manifold data with sampled points
     */
    function sampleOptimalManifold(problem, initialSolution, sampleCount) {
        const { x: x0, objectiveValue: z0 } = initialSolution;

        // Start with the initial solution
        const samples = [{
            x: x0.slice(),
            dual: initialSolution.dualVariables
        }];

        // Try multiple sampling strategies
        const nullSpaceSamples = sampleNullSpace(problem, x0, z0, Math.floor(sampleCount * 0.6));
        const perturbationSamples = sampleByPerturbation(problem, z0, Math.floor(sampleCount * 0.4));

        // Combine and deduplicate samples
        const allSamples = [...samples, ...nullSpaceSamples, ...perturbationSamples];
        const uniqueSamples = deduplicateSamples(allSamples);

        // Estimate manifold dimension
        const dimension = estimateManifoldDimension(problem, x0);

        return {
            points: uniqueSamples,
            dimension,
            optimalValue: z0
        };
    }

    /**
     * Sample using null space of active constraints
     */
    function sampleNullSpace(problem, x0, z0, sampleCount) {
        const samples = [];
        const n = problem.n;

        // Find active constraint gradients
        const activeGradients = getActiveConstraintGradients(problem, x0);

        // Add gradient of objective at x0: Qx0 + c
        const objGradient = Utils.add(Utils.matVec(problem.Q, x0), problem.c);

        // Check if objective gradient is non-zero (strict optimality)
        const objGradNorm = Utils.norm(objGradient);
        if (objGradNorm > 1e-8) {
            activeGradients.push(objGradient);
        }

        // Compute null space
        const nullSpace = Utils.computeNullSpace(activeGradients);

        if (nullSpace.length === 0) {
            // Unique solution
            return samples;
        }

        // Sample directions in null space
        for (let i = 0; i < sampleCount; i++) {
            // Random combination of null space vectors
            const direction = randomNullSpaceDirection(nullSpace);

            // Find extent in this direction while staying feasible and optimal
            const { minStep, maxStep } = findStepBounds(problem, x0, direction, z0);

            if (maxStep - minStep < 1e-10) continue;

            // Sample uniformly along this line segment
            const t = minStep + Math.random() * (maxStep - minStep);
            const newX = Utils.add(x0, Utils.scale(direction, t));

            // Verify feasibility and optimality
            if (Solver.isFeasible(problem, newX) &&
                Math.abs(Solver.computeObjective(problem, newX) - z0) < 1e-6) {

                const dual = Solver.computeDualAtPoint(problem, newX);
                samples.push({ x: newX, dual });
            }
        }

        return samples;
    }

    /**
     * Sample by perturbing the linear term and re-solving
     */
    function sampleByPerturbation(problem, z0, sampleCount) {
        const samples = [];
        const n = problem.n;

        for (let i = 0; i < sampleCount; i++) {
            // Small random perturbation to c
            const perturbation = Utils.scale(Utils.randomUnitVector(n), 1e-4);
            const perturbedC = Utils.add(problem.c, perturbation);

            const perturbedProblem = {
                ...problem,
                c: perturbedC
            };

            try {
                const result = Solver.solve(perturbedProblem);
                if (result.status === 'optimal') {
                    // Check if this is still optimal for original problem
                    const origObj = Solver.computeObjective(problem, result.x);
                    if (Math.abs(origObj - z0) < 1e-5 && Solver.isFeasible(problem, result.x)) {
                        const dual = Solver.computeDualAtPoint(problem, result.x);
                        samples.push({ x: result.x, dual });
                    }
                }
            } catch (e) {
                // Perturbation made problem infeasible, skip
            }
        }

        return samples;
    }

    /**
     * Get gradients of active constraints
     */
    function getActiveConstraintGradients(problem, x, tol = 1e-6) {
        const gradients = [];

        // Equality constraints are always active
        for (const eq of problem.equalities) {
            gradients.push(eq.a.slice());
        }

        // Check inequality constraints
        for (const ineq of problem.inequalities) {
            const lhs = Utils.dot(ineq.a, x);
            if (Math.abs(lhs - ineq.b) < tol) {
                gradients.push(ineq.a.slice());
            }
        }

        return gradients;
    }

    /**
     * Generate random direction in null space
     */
    function randomNullSpaceDirection(nullSpace) {
        const n = nullSpace[0].length;
        let direction = Utils.zeros(n);

        for (const basis of nullSpace) {
            const coeff = Utils.randomInRange(-1, 1);
            direction = Utils.add(direction, Utils.scale(basis, coeff));
        }

        const norm = Utils.norm(direction);
        return norm > 1e-10 ? Utils.scale(direction, 1 / norm) : direction;
    }

    /**
     * Find step bounds for moving in a direction while staying feasible and optimal
     */
    function findStepBounds(problem, x0, direction, z0) {
        let minStep = -Infinity;
        let maxStep = Infinity;

        // Check inequality constraints: a'(x0 + t*d) <= b
        // => t * a'd <= b - a'x0
        for (const ineq of problem.inequalities) {
            const ad = Utils.dot(ineq.a, direction);
            const ax0 = Utils.dot(ineq.a, x0);
            const slack = ineq.b - ax0;

            if (ad > 1e-10) {
                maxStep = Math.min(maxStep, slack / ad);
            } else if (ad < -1e-10) {
                minStep = Math.max(minStep, slack / ad);
            }
        }

        // Check bounds
        if (problem.bounds) {
            for (let i = 0; i < problem.n; i++) {
                if (Math.abs(direction[i]) < 1e-10) continue;

                if (direction[i] > 0) {
                    const maxT = (problem.bounds.upper[i] - x0[i]) / direction[i];
                    const minT = (problem.bounds.lower[i] - x0[i]) / direction[i];
                    maxStep = Math.min(maxStep, maxT);
                    minStep = Math.max(minStep, minT);
                } else {
                    const maxT = (problem.bounds.lower[i] - x0[i]) / direction[i];
                    const minT = (problem.bounds.upper[i] - x0[i]) / direction[i];
                    maxStep = Math.min(maxStep, maxT);
                    minStep = Math.max(minStep, minT);
                }
            }
        }

        // Also check that we stay optimal
        // For QP: objective = ½(x0+td)'Q(x0+td) + c'(x0+td)
        // = z0 + t*(Qx0+c)'d + ½t²*d'Qd
        // For this to equal z0, we need (Qx0+c)'d = 0 and d'Qd = 0
        // (which should be true in the null space)

        // Clamp to reasonable bounds
        minStep = Math.max(minStep, -1e6);
        maxStep = Math.min(maxStep, 1e6);

        return { minStep, maxStep };
    }

    /**
     * Estimate the dimension of the optimal manifold
     */
    function estimateManifoldDimension(problem, x0) {
        const activeGradients = getActiveConstraintGradients(problem, x0);

        // Add objective gradient if non-zero
        const objGradient = Utils.add(Utils.matVec(problem.Q, x0), problem.c);
        if (Utils.norm(objGradient) > 1e-8) {
            activeGradients.push(objGradient);
        }

        // Null space dimension = n - rank(active gradients)
        const nullSpace = Utils.computeNullSpace(activeGradients);
        return nullSpace.length;
    }

    /**
     * Remove duplicate samples
     */
    function deduplicateSamples(samples, tol = 1e-6) {
        const unique = [];

        for (const sample of samples) {
            let isDuplicate = false;
            for (const existing of unique) {
                if (Utils.arraysApproxEqual(sample.x, existing.x, tol)) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                unique.push(sample);
            }
        }

        return unique;
    }

    /**
     * Sample extreme points of the optimal face by solving LPs
     */
    function sampleExtremePoints(problem, z0, numDirections) {
        const samples = [];
        const n = problem.n;

        for (let i = 0; i < numDirections; i++) {
            // Random objective direction
            const randomDir = Utils.randomUnitVector(n);

            // Create LP: minimize randomDir'x subject to original constraints + optimality
            const lpProblem = {
                n,
                Q: Utils.matrixCreate(n, n), // Zero matrix (LP)
                c: randomDir,
                inequalities: [
                    ...problem.inequalities
                ],
                equalities: [...problem.equalities],
                bounds: problem.bounds
            };

            // Add constraint that objective must equal optimal
            // ½x'Qx + c'x = z0
            // This is tricky for quadratic - we'll approximate by checking after

            try {
                const result = Solver.solve(lpProblem);
                if (result.status === 'optimal') {
                    // Check if this is optimal for original
                    const origObj = Solver.computeObjective(problem, result.x);
                    if (Math.abs(origObj - z0) < 1e-4 && Solver.isFeasible(problem, result.x)) {
                        const dual = Solver.computeDualAtPoint(problem, result.x);
                        samples.push({ x: result.x, dual });
                    }
                }
            } catch (e) {
                // Skip this direction
            }
        }

        return samples;
    }

    /**
     * Main entry point: sample the optimal set comprehensively
     */
    function sampleOptimalSet(problem, initialSolution, options = {}) {
        const {
            sampleCount = 100,
            includeExtremePoints = true
        } = options;

        const { x: x0, objectiveValue: z0 } = initialSolution;

        // Estimate manifold dimension first
        const dimension = estimateManifoldDimension(problem, x0);

        if (dimension === 0) {
            // Unique optimal solution
            return {
                points: [{
                    x: x0.slice(),
                    dual: initialSolution.dualVariables
                }],
                dimension: 0,
                optimalValue: z0
            };
        }

        // Sample using multiple strategies
        let allSamples = [{
            x: x0.slice(),
            dual: initialSolution.dualVariables
        }];

        // Null space sampling
        const nullSamples = sampleNullSpace(problem, x0, z0, Math.floor(sampleCount * 0.5));
        allSamples = allSamples.concat(nullSamples);

        // Perturbation sampling
        const perturbSamples = sampleByPerturbation(problem, z0, Math.floor(sampleCount * 0.3));
        allSamples = allSamples.concat(perturbSamples);

        // Extreme point sampling
        if (includeExtremePoints) {
            const extremeSamples = sampleExtremePoints(problem, z0, Math.floor(sampleCount * 0.2));
            allSamples = allSamples.concat(extremeSamples);
        }

        // Deduplicate
        const uniqueSamples = deduplicateSamples(allSamples);

        return {
            points: uniqueSamples,
            dimension,
            optimalValue: z0
        };
    }

    // Export public API
    return {
        sampleOptimalManifold,
        sampleOptimalSet,
        sampleNullSpace,
        sampleByPerturbation,
        sampleExtremePoints,
        estimateManifoldDimension,
        getActiveConstraintGradients
    };
})();

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Sampling;
}
