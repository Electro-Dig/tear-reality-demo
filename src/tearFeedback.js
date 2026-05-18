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

function easeOutCubic(value) {
  const t = Math.max(0, Math.min(1, value));
  return 1 - (1 - t) ** 3;
}
