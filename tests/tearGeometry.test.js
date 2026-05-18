import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginGrab,
  createClothMesh,
  moveGrab,
  resetClothMesh,
  stressClothMesh,
  stepClothMesh,
} from '../src/clothMesh.js';
import { buildTearBand, buildTearOpening, clampPoint } from '../src/tearGeometry.js';

test('clampPoint keeps pointer coordinates inside the canvas bounds', () => {
  assert.deepEqual(clampPoint({ x: -10, y: 900 }, 320, 240), { x: 0, y: 240 });
});

test('cloth mesh stress breaks structural constraints after repeated pull', () => {
  const mesh = createClothMesh({ width: 400, height: 240, columns: 8, rows: 5 });
  beginGrab(mesh, { x: 160, y: 100 }, 90);
  let broken = 0;
  for (let index = 0; index < 8; index += 1) {
    const from = { x: 160 + index * 12, y: 100 + index * 6 };
    const to = { x: 210 + index * 14, y: 132 + index * 7 };
    moveGrab(mesh, to);
    stepClothMesh(mesh, { gravity: 0, iterations: 3, tearRatio: 9, grabStrength: 0.8 });
    broken += stressClothMesh(mesh, from, to, 58, 1.2);
  }

  assert.ok(broken > 0);
  assert.equal(mesh.brokenCount, broken);
});

test('buildTearBand returns a closed polygon around the drag path', () => {
  const band = buildTearBand([
    { x: 10, y: 10 },
    { x: 110, y: 20 },
    { x: 210, y: 40 },
  ], 24);

  assert.equal(band.length, 6);
  assert.ok(Math.min(...band.map((point) => point.y)) < 10);
  assert.ok(Math.max(...band.map((point) => point.y)) > 40);
});

test('buildTearOpening creates one tapered opening between grab and pull points', () => {
  const opening = buildTearOpening({ x: 100, y: 120 }, { x: 460, y: 260 }, { segments: 8, maxWidth: 120 });

  assert.ok(opening);
  assert.equal(opening.upper.length, 9);
  assert.equal(opening.lower.length, 9);
  assert.equal(opening.polygon.length, 18);
  assert.ok(opening.distance > 380);
  assert.ok(opening.polygon.some((point) => point.y < 120));
  assert.ok(opening.polygon.some((point) => point.y > 260));
});

test('cloth mesh creates particles and structural constraints', () => {
  const mesh = createClothMesh({ width: 300, height: 200, columns: 3, rows: 2 });

  assert.equal(mesh.particles.length, 12);
  assert.ok(mesh.constraints.length > 0);
  assert.equal(mesh.particles[0].pinned, true);
  assert.equal(mesh.particles[5].pinned, false);
});

test('cloth mesh drag moves nearby unpinned particles', () => {
  const mesh = createClothMesh({ width: 400, height: 240, columns: 4, rows: 3 });
  const before = mesh.particles[6].x;

  beginGrab(mesh, { x: 100, y: 80 }, 120);
  moveGrab(mesh, { x: 220, y: 150 });
  stepClothMesh(mesh, { gravity: 0, iterations: 2, tearRatio: 8 });

  assert.ok(mesh.particles[6].x > before + 10);
});

test('cloth mesh breaks overstretched constraints and can reset', () => {
  const mesh = createClothMesh({ width: 400, height: 240, columns: 4, rows: 3 });

  beginGrab(mesh, { x: 100, y: 80 }, 160);
  moveGrab(mesh, { x: 390, y: 220 });
  for (let index = 0; index < 4; index += 1) {
    stepClothMesh(mesh, { gravity: 0, iterations: 3, tearRatio: 1.25 });
  }

  assert.equal(mesh.brokenCount, 0);
  for (let index = 0; index < 4; index += 1) {
    stepClothMesh(mesh, {
      gravity: 0,
      iterations: 3,
      tearRatio: 1.25,
      tearCenter: { x: 390, y: 220 },
      tearRadius: 220,
    });
  }

  assert.ok(mesh.brokenCount > 0);
  resetClothMesh(mesh);
  assert.equal(mesh.brokenCount, 0);
  assert.equal(mesh.constraints.some((constraint) => constraint.broken), false);
});

test('cloth mesh step tearing is limited to the active drag segment', () => {
  const createStretchedMesh = () => {
    const mesh = createClothMesh({ width: 400, height: 240, columns: 8, rows: 5 });
    const stride = mesh.columns + 1;
    const a = 2 * stride + 3;
    const b = a + 1;
    const target = mesh.constraints.find((constraint) => (
      (constraint.a === a && constraint.b === b) || (constraint.a === b && constraint.b === a)
    ));
    mesh.particles[b].x += target.rest * 1.6;
    mesh.particles[b].oldX = mesh.particles[b].x;
    return { mesh, target };
  };

  const far = createStretchedMesh();

  stepClothMesh(far.mesh, {
    gravity: 0,
    iterations: 1,
    tearRatio: 1.2,
    tearSegment: { from: { x: 320, y: 220 }, to: { x: 390, y: 230 } },
    tearRadius: 12,
  });
  assert.equal(far.target.broken, false);

  const near = createStretchedMesh();
  stepClothMesh(near.mesh, {
    gravity: 0,
    iterations: 1,
    tearRatio: 1.2,
    tearSegment: { from: { x: 140, y: 96 }, to: { x: 240, y: 96 } },
    tearRadius: 48,
  });
  assert.equal(near.target.broken, true);
});

test('cloth mesh ignores tiny tear segments instead of making circular holes', () => {
  const mesh = createClothMesh({ width: 400, height: 240, columns: 8, rows: 5 });
  const stride = mesh.columns + 1;
  const a = 2 * stride + 3;
  const b = a + 1;
  const target = mesh.constraints.find((constraint) => (
    (constraint.a === a && constraint.b === b) || (constraint.a === b && constraint.b === a)
  ));

  mesh.particles[b].x += target.rest * 1.6;
  mesh.particles[b].oldX = mesh.particles[b].x;

  const broken = stressClothMesh(
    mesh,
    { x: 170, y: 96 },
    { x: 172, y: 97 },
    48,
    1.2,
    { minSegmentLength: 10 },
  );
  assert.equal(broken, 0);

  stepClothMesh(mesh, {
    gravity: 0,
    iterations: 1,
    tearRatio: 1.2,
    tearSegment: { from: { x: 170, y: 96 }, to: { x: 171, y: 96 } },
    tearRadius: 48,
  });
  assert.equal(target.broken, false);
});
