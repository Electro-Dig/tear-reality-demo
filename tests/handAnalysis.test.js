import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHand, analyzeHands } from '../src/handAnalysis.js';

function landmarksAt(x, y, pinchGap = 0.02) {
  const landmarks = Array.from({ length: 21 }, (_, index) => ({
    x: x + index * 0.001,
    y: y + index * 0.001,
    z: 0,
  }));
  landmarks[0] = { x, y: y + 0.18, z: 0 };
  landmarks[9] = { x, y, z: 0 };
  landmarks[4] = { x: x - pinchGap / 2, y, z: 0 };
  landmarks[8] = { x: x + pinchGap / 2, y, z: 0 };
  return landmarks;
}

test('analyzeHand returns pinch center and normalized pinch distance', () => {
  const hand = analyzeHand(landmarksAt(0.4, 0.3, 0.018));

  assert.equal(Math.round(hand.pinchCenter.x * 100) / 100, 0.4);
  assert.ok(hand.pinchDistance < 0.2);
  assert.ok(hand.confidence > 0.7);
});

test('analyzeHands keeps up to two hands sorted by horizontal position', () => {
  const hands = analyzeHands([
    landmarksAt(0.72, 0.3),
    landmarksAt(0.22, 0.32),
    landmarksAt(0.5, 0.34),
  ]);

  assert.equal(hands.length, 2);
  assert.ok(hands[0].pinchCenter.x < hands[1].pinchCenter.x);
});
