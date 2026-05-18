import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginGrab,
  createClothMesh,
  moveGrab,
  releaseGrab,
  stressClothMesh,
  stepClothMesh,
} from '../src/clothMesh.js';
import { layerAdvanceProgress, shouldAdvanceLayer } from '../src/layerAdvance.js';

const VIEWPORT = { width: 604, height: 720 };

function createMobileMesh() {
  return createClothMesh({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    columns: 120,
    rows: 78,
    irregularity: 0.22,
  });
}

function dragStroke(mesh, from, to, steps = 32) {
  beginGrab(mesh, from, Math.min(178, Math.max(98, VIEWPORT.width * 0.088)));
  let previous = from;
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const point = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    };
    moveGrab(mesh, point);
    stressClothMesh(
      mesh,
      previous,
      point,
      Math.min(164, Math.max(92, VIEWPORT.width * 0.078)),
      0.72,
    );
    for (let frame = 0; frame < 3; frame += 1) {
      stepClothMesh(mesh, {
        gravity: 0.015,
        iterations: 4,
        tearRatio: 3.2,
        grabStrength: 0.9,
        tearCenter: point,
        tearRadius: Math.min(160, Math.max(86, VIEWPORT.width * 0.075)),
      });
    }
    previous = point;
  }
  releaseGrab(mesh);
  for (let frame = 0; frame < 8; frame += 1) {
    stepClothMesh(mesh, {
      gravity: 0.07,
      iterations: 3,
      tearRatio: 7.5,
      grabStrength: 0.13,
      tearCenter: null,
    });
  }
}

test('one long drag does not advance to the next layer by itself', () => {
  const mesh = createMobileMesh();
  dragStroke(mesh, { x: 120, y: 170 }, { x: 520, y: 540 });

  const oldCountThreshold = Math.max(18, Math.floor(mesh.constraints.length * 0.012));
  const progress = layerAdvanceProgress(mesh);

  assert.ok(mesh.brokenCount >= oldCountThreshold);
  assert.ok(progress.tornTriangleRatio < 0.11);
  assert.equal(shouldAdvanceLayer(mesh, { completedTearGestures: 1, minCompletedTearGestures: 3 }), false);
});

test('repeated broad tearing can advance after enough visible surface is gone', () => {
  const mesh = createMobileMesh();
  const strokes = [
    [{ x: 100, y: 170 }, { x: 520, y: 540 }],
    [{ x: 520, y: 180 }, { x: 90, y: 540 }],
    [{ x: 110, y: 360 }, { x: 540, y: 360 }],
    [{ x: 300, y: 120 }, { x: 300, y: 650 }],
    [{ x: 80, y: 610 }, { x: 560, y: 150 }],
  ];

  for (const [from, to] of strokes) dragStroke(mesh, from, to);

  const progress = layerAdvanceProgress(mesh);
  assert.ok(progress.brokenRatio >= 0.03);
  assert.ok(progress.tornTriangleRatio >= 0.16);
  assert.equal(shouldAdvanceLayer(mesh, {
    completedTearGestures: strokes.length,
    minCompletedTearGestures: 3,
  }), true);
});
