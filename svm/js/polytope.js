/**
 * polytope.js - Feasible region vertex enumeration
 *
 * Computes vertices and faces of the feasible polytope for n <= 3
 */

const Polytope = (function() {
    'use strict';

    const BOUND_SIZE = 10; // Default bound for unbounded problems

    /**
     * Compute 2D polytope (polygon) from linear constraints
     * Uses Sutherland-Hodgman algorithm for half-plane clipping
     *
     * @param {Object} problem - QP problem
     * @param {Object} options - Computation options
     * @returns {Object} Polygon vertices in order
     */
    function computePolytope2D(problem, options = {}) {
        const { bounds = { lower: [-BOUND_SIZE, -BOUND_SIZE], upper: [BOUND_SIZE, BOUND_SIZE] } } = problem;
        const maxBound = options.maxBound || BOUND_SIZE;

        // Clamp bounds
        const lower = [
            Math.max(bounds.lower[0], -maxBound),
            Math.max(bounds.lower[1], -maxBound)
        ];
        const upper = [
            Math.min(bounds.upper[0], maxBound),
            Math.min(bounds.upper[1], maxBound)
        ];

        // Start with bounding box
        let vertices = [
            [lower[0], lower[1]],
            [upper[0], lower[1]],
            [upper[0], upper[1]],
            [lower[0], upper[1]]
        ];

        // Clip by each inequality constraint: a'x <= b
        for (const ineq of problem.inequalities) {
            vertices = clipPolygonByHalfPlane(vertices, ineq.a, ineq.b);
            if (vertices.length < 3) {
                return { vertices: [], feasible: false };
            }
        }

        // Clip by each equality constraint (two half-planes)
        for (const eq of problem.equalities) {
            // a'x = b is equivalent to a'x <= b AND -a'x <= -b
            vertices = clipPolygonByHalfPlane(vertices, eq.a, eq.b + 1e-8);
            vertices = clipPolygonByHalfPlane(vertices,
                eq.a.map(v => -v), -eq.b + 1e-8);
            if (vertices.length < 2) {
                return { vertices: [], feasible: false };
            }
        }

        return { vertices, feasible: vertices.length >= 3 };
    }

    /**
     * Sutherland-Hodgman polygon clipping by a half-plane
     * Keeps the region where a'x <= b
     */
    function clipPolygonByHalfPlane(vertices, a, b) {
        if (vertices.length === 0) return [];

        const output = [];
        const n = vertices.length;

        for (let i = 0; i < n; i++) {
            const current = vertices[i];
            const next = vertices[(i + 1) % n];

            const currentInside = Utils.dot(a, current) <= b + 1e-10;
            const nextInside = Utils.dot(a, next) <= b + 1e-10;

            if (currentInside) {
                output.push(current);
                if (!nextInside) {
                    // Add intersection point
                    const intersection = lineHalfPlaneIntersection(current, next, a, b);
                    if (intersection) output.push(intersection);
                }
            } else if (nextInside) {
                // Add intersection point
                const intersection = lineHalfPlaneIntersection(current, next, a, b);
                if (intersection) output.push(intersection);
            }
        }

        return output;
    }

    /**
     * Find intersection of line segment with half-plane boundary
     */
    function lineHalfPlaneIntersection(p1, p2, a, b) {
        const d1 = Utils.dot(a, p1) - b;
        const d2 = Utils.dot(a, p2) - b;

        if (Math.abs(d1 - d2) < 1e-12) return null;

        const t = d1 / (d1 - d2);
        return [
            p1[0] + t * (p2[0] - p1[0]),
            p1[1] + t * (p2[1] - p1[1])
        ];
    }

    /**
     * Compute 3D polytope from linear constraints
     * Uses vertex enumeration via constraint intersection
     *
     * @param {Object} problem - QP problem
     * @param {Object} options - Computation options
     * @returns {Object} Vertices and faces of the polytope
     */
    function computePolytope3D(problem, options = {}) {
        const maxBound = options.maxBound || BOUND_SIZE;

        // Collect all constraints including bounds
        const constraints = [];

        // Bound constraints
        for (let i = 0; i < 3; i++) {
            const lower = problem.bounds?.lower[i] ?? -maxBound;
            const upper = problem.bounds?.upper[i] ?? maxBound;

            // x_i >= lower  =>  -x_i <= -lower
            const aLower = [0, 0, 0];
            aLower[i] = -1;
            constraints.push({ a: aLower, b: -Math.max(lower, -maxBound) });

            // x_i <= upper
            const aUpper = [0, 0, 0];
            aUpper[i] = 1;
            constraints.push({ a: aUpper, b: Math.min(upper, maxBound) });
        }

        // Problem constraints
        for (const ineq of problem.inequalities) {
            constraints.push({ a: ineq.a.slice(), b: ineq.b });
        }

        // Equality constraints (as two inequalities with small tolerance)
        for (const eq of problem.equalities) {
            constraints.push({ a: eq.a.slice(), b: eq.b + 1e-6 });
            constraints.push({ a: eq.a.map(v => -v), b: -eq.b + 1e-6 });
        }

        // Enumerate vertices by finding intersections of constraint triples
        const vertices = [];
        const m = constraints.length;

        for (let i = 0; i < m - 2; i++) {
            for (let j = i + 1; j < m - 1; j++) {
                for (let k = j + 1; k < m; k++) {
                    const vertex = intersectThreePlanes(
                        constraints[i], constraints[j], constraints[k]
                    );

                    if (vertex && isFeasibleVertex(vertex, constraints)) {
                        // Check for duplicates
                        let isDuplicate = false;
                        for (const v of vertices) {
                            if (Utils.arraysApproxEqual(vertex, v, 1e-6)) {
                                isDuplicate = true;
                                break;
                            }
                        }
                        if (!isDuplicate) {
                            vertices.push(vertex);
                        }
                    }
                }
            }
        }

        if (vertices.length < 4) {
            return { vertices: [], faces: [], feasible: false };
        }

        // Compute convex hull faces
        const faces = computeConvexHull3D(vertices);

        return { vertices, faces, feasible: true };
    }

    /**
     * Find intersection point of three planes
     */
    function intersectThreePlanes(c1, c2, c3) {
        const A = [c1.a, c2.a, c3.a];
        const b = [c1.b, c2.b, c3.b];

        return Utils.solveLinearSystem(A, b);
    }

    /**
     * Check if a vertex satisfies all constraints
     */
    function isFeasibleVertex(vertex, constraints, tol = 1e-6) {
        for (const c of constraints) {
            if (Utils.dot(c.a, vertex) > c.b + tol) {
                return false;
            }
        }
        return true;
    }

    /**
     * Compute 3D convex hull using gift wrapping (simple implementation)
     * Returns array of face indices
     */
    function computeConvexHull3D(vertices) {
        if (vertices.length < 4) return [];

        const faces = [];
        const n = vertices.length;

        // Find centroid
        const centroid = Utils.zeros(3);
        for (const v of vertices) {
            for (let i = 0; i < 3; i++) {
                centroid[i] += v[i] / n;
            }
        }

        // For each triple of vertices, check if it's a face
        for (let i = 0; i < n - 2; i++) {
            for (let j = i + 1; j < n - 1; j++) {
                for (let k = j + 1; k < n; k++) {
                    // Compute normal to plane through i, j, k
                    const v1 = Utils.subtract(vertices[j], vertices[i]);
                    const v2 = Utils.subtract(vertices[k], vertices[i]);
                    const normal = cross3D(v1, v2);

                    if (Utils.norm(normal) < 1e-10) continue; // Degenerate

                    // Check if all other vertices are on one side
                    let allOneSide = true;
                    let side = 0;

                    for (let l = 0; l < n; l++) {
                        if (l === i || l === j || l === k) continue;

                        const d = Utils.dot(normal, Utils.subtract(vertices[l], vertices[i]));
                        if (Math.abs(d) < 1e-8) continue; // On plane

                        if (side === 0) {
                            side = Math.sign(d);
                        } else if (Math.sign(d) !== side) {
                            allOneSide = false;
                            break;
                        }
                    }

                    if (allOneSide) {
                        // This is a face - orient outward from centroid
                        const toCentroid = Utils.subtract(centroid, vertices[i]);
                        if (Utils.dot(normal, toCentroid) > 0) {
                            faces.push([i, k, j]); // Reverse order
                        } else {
                            faces.push([i, j, k]);
                        }
                    }
                }
            }
        }

        return faces;
    }

    /**
     * 3D cross product
     */
    function cross3D(a, b) {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        ];
    }

    /**
     * Compute convex hull of 2D points
     * Uses Graham scan algorithm
     */
    function computeConvexHull2D(points) {
        if (points.length < 3) return points.map((_, i) => i);

        // Find lowest point
        let lowest = 0;
        for (let i = 1; i < points.length; i++) {
            if (points[i][1] < points[lowest][1] ||
                (points[i][1] === points[lowest][1] && points[i][0] < points[lowest][0])) {
                lowest = i;
            }
        }

        // Sort by polar angle
        const origin = points[lowest];
        const indexed = points.map((p, i) => ({ p, i }));

        indexed.sort((a, b) => {
            if (a.i === lowest) return -1;
            if (b.i === lowest) return 1;

            const angleA = Math.atan2(a.p[1] - origin[1], a.p[0] - origin[0]);
            const angleB = Math.atan2(b.p[1] - origin[1], b.p[0] - origin[0]);

            if (Math.abs(angleA - angleB) < 1e-10) {
                const distA = Utils.norm(Utils.subtract(a.p, origin));
                const distB = Utils.norm(Utils.subtract(b.p, origin));
                return distA - distB;
            }
            return angleA - angleB;
        });

        // Graham scan
        const stack = [indexed[0].i, indexed[1].i];

        for (let i = 2; i < indexed.length; i++) {
            while (stack.length > 1) {
                const top = stack[stack.length - 1];
                const second = stack[stack.length - 2];
                if (ccw(points[second], points[top], indexed[i].p) <= 0) {
                    stack.pop();
                } else {
                    break;
                }
            }
            stack.push(indexed[i].i);
        }

        return stack;
    }

    /**
     * Counter-clockwise test
     */
    function ccw(a, b, c) {
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    }

    /**
     * Main entry point: compute polytope for any dimension
     */
    function computePolytope(problem, options = {}) {
        const n = problem.n;

        if (n === 1) {
            return computePolytope1D(problem, options);
        } else if (n === 2) {
            return computePolytope2D(problem, options);
        } else if (n === 3) {
            return computePolytope3D(problem, options);
        } else {
            return {
                vertices: [],
                faces: [],
                feasible: true,
                message: 'Polytope visualization not available for n > 3'
            };
        }
    }

    /**
     * Compute 1D polytope (interval)
     */
    function computePolytope1D(problem, options = {}) {
        const maxBound = options.maxBound || BOUND_SIZE;

        let lower = problem.bounds?.lower[0] ?? -maxBound;
        let upper = problem.bounds?.upper[0] ?? maxBound;

        lower = Math.max(lower, -maxBound);
        upper = Math.min(upper, maxBound);

        // Apply inequality constraints
        for (const ineq of problem.inequalities) {
            if (ineq.a[0] > 1e-10) {
                // a*x <= b => x <= b/a
                upper = Math.min(upper, ineq.b / ineq.a[0]);
            } else if (ineq.a[0] < -1e-10) {
                // a*x <= b => x >= b/a (since a < 0)
                lower = Math.max(lower, ineq.b / ineq.a[0]);
            } else if (ineq.b < 0) {
                // 0 <= b < 0 is infeasible
                return { vertices: [], feasible: false };
            }
        }

        // Apply equality constraints
        for (const eq of problem.equalities) {
            if (Math.abs(eq.a[0]) > 1e-10) {
                const val = eq.b / eq.a[0];
                if (val >= lower - 1e-10 && val <= upper + 1e-10) {
                    lower = upper = val;
                } else {
                    return { vertices: [], feasible: false };
                }
            } else if (Math.abs(eq.b) > 1e-10) {
                return { vertices: [], feasible: false };
            }
        }

        if (lower > upper + 1e-10) {
            return { vertices: [], feasible: false };
        }

        return {
            vertices: [[lower], [upper]],
            feasible: true
        };
    }

    /**
     * Sample points on the boundary of the polytope
     * Useful for visualization when vertex enumeration fails
     */
    function samplePolytopeBoundary(problem, numSamples = 100) {
        const samples = [];
        const n = problem.n;

        // Sample random directions and find intersection with boundary
        for (let i = 0; i < numSamples; i++) {
            const direction = Utils.randomUnitVector(n);

            // Find a feasible starting point (origin might not be feasible)
            // Try to find max step in this direction starting from origin
            let maxStep = 1e6;

            for (const ineq of problem.inequalities) {
                const ad = Utils.dot(ineq.a, direction);
                if (ad > 1e-10) {
                    maxStep = Math.min(maxStep, ineq.b / ad);
                }
            }

            if (maxStep < 1e6 && maxStep > 0) {
                const boundaryPoint = Utils.scale(direction, maxStep);
                if (Solver.isFeasible(problem, boundaryPoint, 1e-4)) {
                    samples.push(boundaryPoint);
                }
            }
        }

        return samples;
    }

    // Export public API
    return {
        computePolytope,
        computePolytope1D,
        computePolytope2D,
        computePolytope3D,
        computeConvexHull2D,
        computeConvexHull3D,
        samplePolytopeBoundary,
        clipPolygonByHalfPlane
    };
})();

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Polytope;
}
