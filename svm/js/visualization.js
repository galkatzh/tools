/**
 * visualization.js - Plotly rendering functions
 *
 * Handles all visualization using Plotly.js
 */

const Visualization = (function() {
    'use strict';

    // Color scheme
    const COLORS = {
        optimalPoints: '#e74c3c',      // Red
        optimalHull: 'rgba(241, 196, 15, 0.5)',  // Yellow, translucent
        feasibleRegion: 'rgba(52, 152, 219, 0.3)', // Blue, translucent
        feasibleBorder: '#2980b9',
        highlight: '#2ecc71',           // Green
        grid: '#ecf0f1'
    };

    /**
     * Main rendering function
     *
     * @param {string} containerId - ID of the container element
     * @param {Object} data - Visualization data
     * @param {Object} options - Rendering options
     */
    function render(containerId, data, options = {}) {
        const {
            projectedPoints = [],
            fullPointsData = [],
            polytopeVertices = [],
            polytopeFaces = [],
            hullIndices = [],
            dimensions = 2,
            labels = ['X', 'Y', 'Z']
        } = data;

        const {
            showPolytope = true,
            showHull = true,
            showPoints = true
        } = options;

        if (dimensions === 2) {
            render2D(containerId, data, options);
        } else {
            render3D(containerId, data, options);
        }
    }

    /**
     * Render 2D visualization
     */
    function render2D(containerId, data, options = {}) {
        const {
            projectedPoints = [],
            fullPointsData = [],
            polytopeVertices = [],
            hullIndices = [],
            labels = ['X', 'Y']
        } = data;

        const {
            showPolytope = true,
            showHull = true,
            showPoints = true
        } = options;

        const traces = [];

        // Feasible region (polygon)
        if (showPolytope && polytopeVertices.length >= 3) {
            const polyX = [...polytopeVertices.map(v => v[0]), polytopeVertices[0][0]];
            const polyY = [...polytopeVertices.map(v => v[1]), polytopeVertices[0][1]];

            traces.push({
                type: 'scatter',
                mode: 'lines',
                x: polyX,
                y: polyY,
                fill: 'toself',
                fillcolor: COLORS.feasibleRegion,
                line: { color: COLORS.feasibleBorder, width: 2 },
                name: 'Feasible Region',
                hoverinfo: 'skip'
            });
        }

        // Convex hull of optimal points
        if (showHull && hullIndices.length >= 3 && projectedPoints.length > 0) {
            const hullX = [...hullIndices.map(i => projectedPoints[i][0]),
                          projectedPoints[hullIndices[0]][0]];
            const hullY = [...hullIndices.map(i => projectedPoints[i][1]),
                          projectedPoints[hullIndices[0]][1]];

            traces.push({
                type: 'scatter',
                mode: 'lines',
                x: hullX,
                y: hullY,
                fill: 'toself',
                fillcolor: COLORS.optimalHull,
                line: { color: '#f39c12', width: 2 },
                name: 'Optimal Set Hull',
                hoverinfo: 'skip'
            });
        }

        // Optimal points
        if (showPoints && projectedPoints.length > 0) {
            const hoverTexts = fullPointsData.map(d => formatHoverText(d));

            traces.push({
                type: 'scatter',
                mode: 'markers',
                x: projectedPoints.map(p => p[0]),
                y: projectedPoints.map(p => p[1]),
                marker: {
                    size: 8,
                    color: COLORS.optimalPoints,
                    line: { color: 'white', width: 1 }
                },
                name: 'Optimal Points',
                hoverinfo: 'text',
                hovertext: hoverTexts
            });
        }

        const layout = {
            title: 'QP Solution Visualization',
            xaxis: {
                title: labels[0],
                zeroline: true,
                gridcolor: COLORS.grid
            },
            yaxis: {
                title: labels[1],
                zeroline: true,
                gridcolor: COLORS.grid,
                scaleanchor: 'x',
                scaleratio: 1
            },
            hovermode: 'closest',
            showlegend: true,
            legend: {
                x: 1,
                xanchor: 'right',
                y: 1
            },
            margin: { t: 50, r: 50, b: 50, l: 50 }
        };

        Plotly.newPlot(containerId, traces, layout, { responsive: true });
    }

    /**
     * Render 3D visualization
     */
    function render3D(containerId, data, options = {}) {
        const {
            projectedPoints = [],
            fullPointsData = [],
            polytopeVertices = [],
            polytopeFaces = [],
            hullIndices = [],
            labels = ['X', 'Y', 'Z']
        } = data;

        const {
            showPolytope = true,
            showHull = true,
            showPoints = true
        } = options;

        const traces = [];

        // Feasible region (3D mesh)
        if (showPolytope && polytopeVertices.length >= 4 && polytopeFaces.length > 0) {
            traces.push({
                type: 'mesh3d',
                x: polytopeVertices.map(v => v[0]),
                y: polytopeVertices.map(v => v[1]),
                z: polytopeVertices.map(v => v[2]),
                i: polytopeFaces.map(f => f[0]),
                j: polytopeFaces.map(f => f[1]),
                k: polytopeFaces.map(f => f[2]),
                opacity: 0.3,
                color: COLORS.feasibleBorder,
                name: 'Feasible Region',
                hoverinfo: 'skip',
                flatshading: true
            });

            // Add wireframe edges
            const edges = getPolytopeEdges(polytopeVertices, polytopeFaces);
            if (edges.x.length > 0) {
                traces.push({
                    type: 'scatter3d',
                    mode: 'lines',
                    x: edges.x,
                    y: edges.y,
                    z: edges.z,
                    line: { color: COLORS.feasibleBorder, width: 2 },
                    hoverinfo: 'skip',
                    showlegend: false
                });
            }
        }

        // Convex hull of optimal points (3D)
        if (showHull && projectedPoints.length >= 4) {
            const hull = computeOptimalHull3D(projectedPoints);
            if (hull.faces.length > 0) {
                traces.push({
                    type: 'mesh3d',
                    x: projectedPoints.map(p => p[0]),
                    y: projectedPoints.map(p => p[1]),
                    z: projectedPoints.map(p => p[2]),
                    i: hull.faces.map(f => f[0]),
                    j: hull.faces.map(f => f[1]),
                    k: hull.faces.map(f => f[2]),
                    opacity: 0.5,
                    color: '#f1c40f',
                    name: 'Optimal Set Hull',
                    hoverinfo: 'skip',
                    flatshading: true
                });
            }
        }

        // Optimal points
        if (showPoints && projectedPoints.length > 0) {
            const hoverTexts = fullPointsData.map(d => formatHoverText(d));

            traces.push({
                type: 'scatter3d',
                mode: 'markers',
                x: projectedPoints.map(p => p[0]),
                y: projectedPoints.map(p => p[1]),
                z: projectedPoints.map(p => p[2]),
                marker: {
                    size: 5,
                    color: COLORS.optimalPoints,
                    line: { color: 'white', width: 1 }
                },
                name: 'Optimal Points',
                hoverinfo: 'text',
                hovertext: hoverTexts
            });
        }

        const layout = {
            title: 'QP Solution Visualization',
            scene: {
                xaxis: { title: labels[0], gridcolor: COLORS.grid },
                yaxis: { title: labels[1], gridcolor: COLORS.grid },
                zaxis: { title: labels[2], gridcolor: COLORS.grid },
                aspectmode: 'auto'
            },
            hovermode: 'closest',
            showlegend: true,
            legend: {
                x: 1,
                xanchor: 'right',
                y: 1
            },
            margin: { t: 50, r: 50, b: 50, l: 50 }
        };

        Plotly.newPlot(containerId, traces, layout, { responsive: true });
    }

    /**
     * Render 1D visualization (number line)
     */
    function render1D(containerId, data, options = {}) {
        const {
            projectedPoints = [],
            fullPointsData = [],
            polytopeVertices = [],
            labels = ['X']
        } = data;

        const {
            showPolytope = true,
            showPoints = true
        } = options;

        const traces = [];

        // Feasible region (interval on number line)
        if (showPolytope && polytopeVertices.length >= 2) {
            const minX = Math.min(...polytopeVertices.map(v => v[0]));
            const maxX = Math.max(...polytopeVertices.map(v => v[0]));

            traces.push({
                type: 'scatter',
                mode: 'lines',
                x: [minX, maxX],
                y: [0, 0],
                line: { color: COLORS.feasibleBorder, width: 10 },
                name: 'Feasible Region',
                hoverinfo: 'skip'
            });
        }

        // Optimal points
        if (showPoints && projectedPoints.length > 0) {
            const hoverTexts = fullPointsData.map(d => formatHoverText(d));

            traces.push({
                type: 'scatter',
                mode: 'markers',
                x: projectedPoints.map(p => p[0]),
                y: projectedPoints.map(() => 0),
                marker: {
                    size: 12,
                    color: COLORS.optimalPoints,
                    line: { color: 'white', width: 2 }
                },
                name: 'Optimal Points',
                hoverinfo: 'text',
                hovertext: hoverTexts
            });
        }

        const layout = {
            title: 'QP Solution Visualization',
            xaxis: {
                title: labels[0],
                zeroline: true
            },
            yaxis: {
                visible: false,
                range: [-1, 1]
            },
            hovermode: 'closest',
            showlegend: true,
            height: 200
        };

        Plotly.newPlot(containerId, traces, layout, { responsive: true });
    }

    /**
     * Format hover text for a point
     */
    function formatHoverText(pointData) {
        const lines = [];

        // Primal solution
        if (pointData.x) {
            const xStr = pointData.x.map(v => Utils.formatNumber(v, 4)).join(', ');
            lines.push(`x = [${xStr}]`);
        }

        // Dual variables
        if (pointData.dual) {
            if (pointData.dual.inequalities && pointData.dual.inequalities.length > 0) {
                const lambdaStr = pointData.dual.inequalities
                    .map(v => Utils.formatNumber(v, 4)).join(', ');
                lines.push(`\u03BB = [${lambdaStr}]`);
            }
            if (pointData.dual.equalities && pointData.dual.equalities.length > 0) {
                const nuStr = pointData.dual.equalities
                    .map(v => Utils.formatNumber(v, 4)).join(', ');
                lines.push(`\u03BD = [${nuStr}]`);
            }
        }

        return lines.join('<br>');
    }

    /**
     * Get edges of a 3D polytope for wireframe rendering
     */
    function getPolytopeEdges(vertices, faces) {
        const edges = new Set();
        const x = [], y = [], z = [];

        for (const face of faces) {
            for (let i = 0; i < face.length; i++) {
                const v1 = face[i];
                const v2 = face[(i + 1) % face.length];
                const edgeKey = v1 < v2 ? `${v1}-${v2}` : `${v2}-${v1}`;

                if (!edges.has(edgeKey)) {
                    edges.add(edgeKey);
                    x.push(vertices[v1][0], vertices[v2][0], null);
                    y.push(vertices[v1][1], vertices[v2][1], null);
                    z.push(vertices[v1][2], vertices[v2][2], null);
                }
            }
        }

        return { x, y, z };
    }

    /**
     * Compute 3D convex hull for optimal points
     */
    function computeOptimalHull3D(points) {
        if (points.length < 4) {
            return { faces: [] };
        }

        // Use Polytope module's convex hull function
        const faces = Polytope.computeConvexHull3D(points);
        return { faces };
    }

    /**
     * Update visualization with new data
     */
    function update(containerId, data, options) {
        render(containerId, data, options);
    }

    /**
     * Clear the visualization
     */
    function clear(containerId) {
        Plotly.purge(containerId);
    }

    /**
     * Render error state
     */
    function renderError(containerId, message) {
        const container = document.getElementById(containerId);
        if (container) {
            container.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: center;
                            height: 100%; color: #e74c3c; text-align: center; padding: 20px;">
                    <div>
                        <div style="font-size: 48px; margin-bottom: 10px;">&#9888;</div>
                        <div>${message}</div>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Render empty state
     */
    function renderEmpty(containerId, message = 'No data to display') {
        const container = document.getElementById(containerId);
        if (container) {
            container.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: center;
                            height: 100%; color: #7f8c8d; text-align: center; padding: 20px;">
                    <div>
                        <div style="font-size: 48px; margin-bottom: 10px;">&#128200;</div>
                        <div>${message}</div>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Render loading state
     */
    function renderLoading(containerId) {
        const container = document.getElementById(containerId);
        if (container) {
            container.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: center;
                            height: 100%; color: #3498db; text-align: center; padding: 20px;">
                    <div>
                        <div style="font-size: 32px; margin-bottom: 10px;">&#8987;</div>
                        <div>Computing...</div>
                    </div>
                </div>
            `;
        }
    }

    // Export public API
    return {
        render,
        render1D,
        render2D,
        render3D,
        update,
        clear,
        renderError,
        renderEmpty,
        renderLoading,
        formatHoverText,
        COLORS
    };
})();

// Export for Node.js testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Visualization;
}
