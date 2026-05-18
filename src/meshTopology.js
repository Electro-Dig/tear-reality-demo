export function brokenEdgeSet(mesh) {
  const edges = new Set();
  for (const constraint of mesh.constraints) {
    if (constraint.broken) edges.add(edgeKey(constraint.a, constraint.b));
  }
  return edges;
}

export function renderCellTriangles(mesh, x, y) {
  const stride = mesh.columns + 1;
  const a = y * stride + x;
  const b = a + 1;
  const c = (y + 1) * stride + x;
  const d = c + 1;
  return alternateCellDiagonal(x, y)
    ? [[a, c, d], [a, d, b]]
    : [[a, c, b], [b, c, d]];
}

export function triangleIsTorn(a, b, c, brokenEdges) {
  return brokenEdges.has(edgeKey(a, b)) || brokenEdges.has(edgeKey(b, c)) || brokenEdges.has(edgeKey(c, a));
}

export function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function alternateCellDiagonal(x, y) {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return (value - Math.floor(value)) > 0.5;
}
