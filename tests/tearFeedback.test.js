import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEAR_STYLE,
  detachedPieceOpacity,
  grabRadiusForSource,
  resolveTearStyle,
  shouldFreezeBrokenEdges,
  shouldCommitTearMask,
  shouldRenderDetachedPiece,
  shouldRenderTearMask,
  TEAR_STYLES,
  tearWidthForMotion,
  twoHandTearSegments,
} from '../src/tearFeedback.js';

test('default tear style preserves the original shard interaction', () => {
  assert.equal(DEFAULT_TEAR_STYLE, 'shards');
  assert.ok(TEAR_STYLES.includes('shards'));
  assert.ok(TEAR_STYLES.includes('auto'));
});

test('tearWidthForMotion grows with drag distance and hand span', () => {
  const small = tearWidthForMotion({ source: 'pointer', dragDistance: 30, segmentLength: 8, viewportMin: 700 });
  const long = tearWidthForMotion({ source: 'pointer', dragDistance: 360, segmentLength: 40, viewportMin: 700 });
  const twoHand = tearWidthForMotion({ source: 'two-hand', dragDistance: 280, segmentLength: 220, viewportMin: 700 });

  assert.ok(long > small * 2);
  assert.ok(twoHand > long);
});

test('resolveTearStyle keeps shard mode for small actions and escalates to strip or sheet for broader pulls', () => {
  assert.equal(resolveTearStyle({ requestedStyle: 'auto', source: 'pointer', dragDistance: 40, segmentLength: 8, viewportMin: 700 }), 'shards');
  assert.equal(resolveTearStyle({ requestedStyle: 'auto', source: 'pointer', dragDistance: 190, segmentLength: 30, viewportMin: 700 }), 'strip');
  assert.equal(resolveTearStyle({ requestedStyle: 'auto', source: 'pointer', dragDistance: 360, segmentLength: 70, viewportMin: 700 }), 'sheet');
  assert.equal(resolveTearStyle({ requestedStyle: 'auto', source: 'two-hand', dragDistance: 80, segmentLength: 180, viewportMin: 700 }), 'sheet');
});

test('resolveTearStyle honors an explicitly requested mode', () => {
  assert.equal(resolveTearStyle({ requestedStyle: 'shards', source: 'two-hand', dragDistance: 400, segmentLength: 260, viewportMin: 700 }), 'shards');
});

test('hand gesture sources keep the selected shard mode instead of forcing sheet rendering', () => {
  assert.equal(resolveTearStyle({
    requestedStyle: 'shards',
    source: 'hand',
    dragDistance: 500,
    segmentLength: 120,
    viewportMin: 700,
  }), 'shards');
  assert.equal(resolveTearStyle({
    requestedStyle: 'shards',
    source: 'two-hand',
    dragDistance: 500,
    segmentLength: 320,
    viewportMin: 700,
  }), 'shards');
});

test('shard rendering keeps live broken edges visible while dragging', () => {
  assert.equal(shouldFreezeBrokenEdges({ renderStyle: 'shards', isDragging: true }), false);
  assert.equal(shouldFreezeBrokenEdges({ renderStyle: 'sheet', isDragging: true }), true);
  assert.equal(shouldFreezeBrokenEdges({ renderStyle: 'strip', isDragging: true }), true);
  assert.equal(shouldFreezeBrokenEdges({ renderStyle: 'shards', isDragging: false }), false);
});

test('sheet and strip paths do not preview torn pieces or masks while actively dragging', () => {
  const activeSheet = { style: 'sheet' };
  const releasedSheet = { style: 'sheet', releasedAt: 1200 };
  const activeShard = { style: 'shards' };

  assert.equal(shouldRenderDetachedPiece(activeSheet, { activePath: activeSheet, isDragging: true }), false);
  assert.equal(shouldRenderTearMask(activeSheet, { activePath: activeSheet, isDragging: true }), false);
  assert.equal(shouldRenderDetachedPiece(releasedSheet, { activePath: activeSheet, isDragging: true }), false);
  assert.equal(shouldRenderTearMask(releasedSheet, { activePath: activeSheet, isDragging: true }), true);
  assert.equal(shouldRenderTearMask(activeShard, { activePath: activeShard, isDragging: true }), false);
});

test('non-shard tears commit to a permanent mask instead of rendering ghost pieces', () => {
  const releasedSheet = { style: 'sheet', releasedAt: 1200, points: [{}, {}] };
  const releasedStrip = { style: 'strip', releasedAt: 1200, points: [{}, {}] };
  const releasedShard = { style: 'shards', releasedAt: 1200, points: [{}, {}] };

  assert.equal(shouldCommitTearMask(releasedSheet), true);
  assert.equal(shouldCommitTearMask(releasedStrip), true);
  assert.equal(shouldCommitTearMask(releasedShard), false);
  assert.equal(shouldRenderDetachedPiece(releasedSheet), false);
  assert.equal(shouldRenderDetachedPiece(releasedStrip), false);
});

test('hand shard grabbing uses a smaller local radius than pointer or sheet gestures', () => {
  const handShard = grabRadiusForSource({ source: 'hand', renderStyle: 'shards', viewportWidth: 1280 });
  const pointerShard = grabRadiusForSource({ source: 'pointer', renderStyle: 'shards', viewportWidth: 1280 });
  const handSheet = grabRadiusForSource({ source: 'hand', renderStyle: 'sheet', viewportWidth: 1280 });
  const twoHandShard = grabRadiusForSource({ source: 'two-hand', renderStyle: 'shards', viewportWidth: 1280, handSpan: 620 });

  assert.ok(handShard < pointerShard);
  assert.ok(handShard < handSheet);
  assert.ok(handShard <= 112);
  assert.ok(twoHandShard < pointerShard);
  assert.ok(twoHandShard <= 92);
});

test('two-hand tearing follows hand motion instead of the full span between hands', () => {
  const previousLeft = { x: 160, y: 220 };
  const previousRight = { x: 760, y: 220 };
  const left = { x: 146, y: 230 };
  const right = { x: 776, y: 228 };
  const segments = twoHandTearSegments({ previousLeft, previousRight, left, right, minMove: 6 });

  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.ok(Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y) < 24);
  }

  const still = twoHandTearSegments({ previousLeft: left, previousRight: right, left, right, minMove: 6 });
  assert.equal(still.length, 0);
});

test('detachedPieceOpacity only keeps released pieces briefly visible', () => {
  const active = { createdAt: 1000 };
  const released = { createdAt: 1000, releasedAt: 1200 };

  assert.equal(detachedPieceOpacity(active, 2000, active) > 0.8, true);
  assert.equal(detachedPieceOpacity(released, 1300, null) > 0.5, true);
  assert.equal(detachedPieceOpacity(released, 2600, null), 0);
});

test('detachedPieceOpacity does not keep old released pieces visible during the next drag', () => {
  const active = { createdAt: 1000 };
  const released = { createdAt: 1000, releasedAt: 1200 };
  const dismissed = { createdAt: 1000, releasedAt: 1200, detachedDismissed: true };

  assert.equal(detachedPieceOpacity(active, 6000, active) > 0.8, true);
  assert.equal(detachedPieceOpacity(released, 1300, active, { isDragging: true }), 0);
  assert.equal(detachedPieceOpacity(dismissed, 1300, null), 0);
});
