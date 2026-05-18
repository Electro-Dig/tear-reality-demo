import { brokenEdgeSet, renderCellTriangles, triangleIsTorn } from './meshTopology.js';

const DEFAULT_MIN_BROKEN_RATIO = 0.03;
const DEFAULT_MIN_TORN_TRIANGLE_RATIO = 0.16;

export function shouldAdvanceLayer(mesh, options = {}) {
  if (!mesh) return false;
  const {
    minBrokenRatio = DEFAULT_MIN_BROKEN_RATIO,
    minTornTriangleRatio = DEFAULT_MIN_TORN_TRIANGLE_RATIO,
    completedTearGestures = 0,
    minCompletedTearGestures = 0,
  } = options;
  const progress = layerAdvanceProgress(mesh);
  return (
    completedTearGestures >= minCompletedTearGestures
    && progress.brokenRatio >= minBrokenRatio
    && progress.tornTriangleRatio >= minTornTriangleRatio
  );
}

export function layerAdvanceProgress(mesh) {
  const brokenEdges = brokenEdgeSet(mesh);
  const totalTriangles = mesh.columns * mesh.rows * 2;
  let tornTriangles = 0;

  for (let y = 0; y < mesh.rows; y += 1) {
    for (let x = 0; x < mesh.columns; x += 1) {
      for (const [a, b, c] of renderCellTriangles(mesh, x, y)) {
        if (triangleIsTorn(a, b, c, brokenEdges)) tornTriangles += 1;
      }
    }
  }

  return {
    brokenRatio: mesh.constraints.length > 0 ? mesh.brokenCount / mesh.constraints.length : 0,
    tornTriangleRatio: totalTriangles > 0 ? tornTriangles / totalTriangles : 0,
  };
}
