export const TEAR_STYLES = ['auto', 'sheet', 'strip', 'shards'];
export const DEFAULT_TEAR_STYLE = 'shards';

export function resolveTearStyle({
  requestedStyle = 'auto',
  source = 'pointer',
  dragDistance = 0,
  segmentLength = 0,
  viewportMin = 720,
} = {}) {
  if (requestedStyle && requestedStyle !== 'auto') return requestedStyle;
  if (source === 'two-hand') return 'sheet';

  const distanceRatio = viewportMin > 0 ? dragDistance / viewportMin : 0;
  const segmentRatio = viewportMin > 0 ? segmentLength / viewportMin : 0;
  if (distanceRatio > 0.42 || segmentRatio > 0.085) return 'sheet';
  if (distanceRatio > 0.2 || segmentRatio > 0.032) return 'strip';
  return 'shards';
}

export function tearWidthForMotion({
  source = 'pointer',
  dragDistance = 0,
  segmentLength = 0,
  viewportMin = 720,
} = {}) {
  const base = source === 'two-hand' ? 82 : source === 'hand' ? 42 : 34;
  const distance = Math.max(0, dragDistance);
  const segment = Math.max(0, segmentLength);
  const pullScale = Math.min(1, (distance + segment * 1.8) / Math.max(1, viewportMin * 0.58));
  const maxWidth = source === 'two-hand'
    ? Math.min(360, viewportMin * 0.42)
    : Math.min(260, viewportMin * 0.32);
  return Math.round(base + (maxWidth - base) * easeOutCubic(pullScale));
}

export function detachedPieceOpacity(path, now, activePath = null, options = {}) {
  const { lifetime = 900, isDragging = false } = typeof options === 'number'
    ? { lifetime: options, isDragging: false }
    : options;
  if (!path) return 0;
  if (path.detachedDismissed) return 0;
  if (path === activePath && !path.releasedAt) return 0.92;
  if (isDragging) return 0;
  if (!path.releasedAt) return 0;
  const age = now - path.releasedAt;
  if (age < 0) return 0.9;
  if (age >= lifetime) return 0;
  return Math.max(0, 0.88 * (1 - easeOutCubic(age / lifetime)));
}

export function shouldRenderDetachedPiece(path, { activePath = null, isDragging = false } = {}) {
  if (!path || path.detachedDismissed) return false;
  if (isDragging || path === activePath || !path.releasedAt) return false;
  return false;
}

export function shouldRenderTearMask(path, { activePath = null, isDragging = false } = {}) {
  if (!path || path.style === 'shards') return false;
  if (isDragging && path === activePath) return false;
  return true;
}

export function shouldCommitTearMask(path) {
  return Boolean(path && path.style !== 'shards' && path.points && path.points.length >= 2);
}

export function shouldFreezeBrokenEdges({ renderStyle = 'shards', isDragging = false } = {}) {
  return Boolean(isDragging && renderStyle !== 'shards');
}

export function grabRadiusForSource({
  source = 'pointer',
  renderStyle = 'shards',
  viewportWidth = 1280,
  handSpan = 0,
} = {}) {
  if (source === 'two-hand') {
    const base = renderStyle === 'shards'
      ? Math.min(92, Math.max(42, handSpan * 0.12))
      : Math.min(260, Math.max(140, handSpan * 0.55));
    return Math.round(base);
  }
  if (source === 'hand' && renderStyle === 'shards') {
    return Math.round(Math.min(112, Math.max(54, viewportWidth * 0.052)));
  }
  return Math.round(Math.min(178, Math.max(98, viewportWidth * 0.088)));
}

export function twoHandTearSegments({
  previousLeft,
  previousRight,
  left,
  right,
  minMove = 8,
} = {}) {
  const segments = [];
  appendMovedSegment(segments, previousLeft, left, minMove);
  appendMovedSegment(segments, previousRight, right, minMove);
  return segments;
}

function appendMovedSegment(segments, from, to, minMove) {
  if (!from || !to) return;
  if (Math.hypot(to.x - from.x, to.y - from.y) < minMove) return;
  segments.push({ from, to });
}

function easeOutCubic(value) {
  const t = Math.max(0, Math.min(1, value));
  return 1 - (1 - t) ** 3;
}
