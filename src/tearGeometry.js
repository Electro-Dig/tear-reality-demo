export function clampPoint(point, width, height) {
  return {
    x: Math.max(0, Math.min(width, point.x)),
    y: Math.max(0, Math.min(height, point.y)),
  };
}

export function buildTearBand(points, radius = 24) {
  if (points.length < 2) return [];

  const upper = [];
  const lower = [];

  for (let index = 0; index < points.length; index += 1) {
    const prev = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const wobble = Math.sin(index * 1.9) * radius * 0.24;
    const width = radius + wobble;

    upper.push({ x: current.x + nx * width, y: current.y + ny * width });
    lower.push({ x: current.x - nx * width, y: current.y - ny * width });
  }

  return upper.concat(lower.reverse());
}

export function buildTearOpening(anchor, current, options = {}) {
  const distance = Math.hypot(current.x - anchor.x, current.y - anchor.y);
  if (distance < 4) return null;

  const segments = options.segments ?? 18;
  const maxWidth = Math.min(options.maxWidth ?? 170, Math.max(42, distance * 0.32));
  const dx = (current.x - anchor.x) / distance;
  const dy = (current.y - anchor.y) / distance;
  const nx = -dy;
  const ny = dx;
  const upper = [];
  const lower = [];

  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const centerX = anchor.x + (current.x - anchor.x) * t;
    const centerY = anchor.y + (current.y - anchor.y) * t;
    const taper = Math.sin(Math.PI * t);
    const pullWidth = 8 + taper * maxWidth + t * 18;
    const jag = Math.sin(index * 2.73) * 7 + Math.sin(index * 5.19) * 3;
    const width = Math.max(5, pullWidth + jag);

    upper.push({ x: centerX + nx * width, y: centerY + ny * width });
    lower.push({ x: centerX - nx * width * 0.82, y: centerY - ny * width * 0.82 });
  }

  return {
    anchor,
    current,
    distance,
    angle: Math.atan2(dy, dx),
    normal: { x: nx, y: ny },
    upper,
    lower,
    polygon: upper.concat(lower.slice().reverse()),
  };
}

export function simplifyPath(points, minDistance = 10) {
  const simplified = [];

  for (const point of points) {
    const previous = simplified.at(-1);
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance) {
      simplified.push(point);
    }
  }

  return simplified;
}
