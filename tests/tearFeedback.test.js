import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEAR_STYLE,
  detachedPieceOpacity,
  resolveTearStyle,
  TEAR_STYLES,
  tearWidthForMotion,
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
