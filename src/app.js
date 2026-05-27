import {
  beginGrab,
  createClothMesh,
  moveGrab,
  releaseGrab,
  resetClothMesh,
  resizeClothMesh,
  settleClothMesh,
  stressClothMesh,
  stepClothMesh,
} from './clothMesh.js';
import { HandTracker } from './handTracker.js';
import { assignLayerImages } from './layerImages.js';
import { shouldAdvanceLayer } from './layerAdvance.js';
import {
  DEFAULT_TEAR_STYLE,
  detachedPieceOpacity,
  grabRadiusForSource,
  resolveTearStyle,
  shouldCommitTearMask,
  shouldFreezeBrokenEdges,
  shouldRenderDetachedPiece,
  shouldRenderTearMask,
  TEAR_STYLES,
  tearWidthForMotion,
  twoHandTearSegments,
} from './tearFeedback.js';
import { clampPoint } from './tearGeometry.js';
import { WebglClothRenderer } from './webglClothRenderer.js';

const stageShell = document.querySelector('.stage-shell');
const sceneCanvas = document.querySelector('#webgl-stage');
const canvas = document.querySelector('#tear-stage');
const resetButton = document.querySelector('#reset');
const handToggleButton = document.querySelector('#hand-toggle');
const tearStyleToggleButton = document.querySelector('#tear-style-toggle');
const uiToggleButton = document.querySelector('#ui-toggle');
const layerUploadInput = document.querySelector('#layer-upload');
const layerUploadButton = document.querySelector('#layer-upload-button');
const handStatus = document.querySelector('#hand-status');
const handVideo = document.querySelector('#hand-video');
const context = canvas.getContext('2d', { alpha: true });
const renderer = new WebglClothRenderer(sceneCanvas);
const HAND_POINT_SMOOTHING = 0.68;
const TWO_HAND_CENTER_SMOOTHING = 0.62;

const state = {
  width: 0,
  height: 0,
  dpr: 1,
  dragging: false,
  dragSource: null,
  cloth: null,
  pointer: null,
  previousPointer: null,
  dragStartBrokenEdges: null,
  dragStartBrokenCount: 0,
  dragDistance: 0,
  lastTearSegment: null,
  layerTearGestures: 0,
  layerIndex: 0,
  layers: [],
  scraps: [],
  tearPaths: [],
  tornPieces: [],
  activeTearPath: null,
  lastScrapPoint: null,
  frameRequested: false,
  settleUntil: 0,
  needsFinalSettle: false,
  topLayer: document.createElement('canvas'),
  bottomLayer: document.createElement('canvas'),
  compositeLayer: document.createElement('canvas'),
  committedMaskLayer: document.createElement('canvas'),
  hasCommittedTearMask: false,
  customImages: [],
  customImageUrls: [],
  uiVisible: true,
  tearStyle: DEFAULT_TEAR_STYLE,
  activeRenderStyle: 'shards',
  hand: {
    tracker: null,
    enabled: false,
    initializing: false,
    visible: false,
    pinching: false,
    twoHandPinching: false,
    point: null,
    landmarks: null,
    hands: [],
    confidence: 0,
    lastSeenAt: 0,
    twoHand: {
      previousDistance: 0,
      previousCenter: null,
      previousLeftPoint: null,
      previousRightPoint: null,
      startDistance: 0,
    },
  },
};

function resize() {
  state.dpr = 1;
  state.width = window.innerWidth;
  state.height = window.innerHeight;
  configureCanvas(canvas, state.width, state.height);
  renderer.resize(state.width, state.height);
  configureCanvas(state.topLayer, state.width, state.height);
  configureCanvas(state.bottomLayer, state.width, state.height);
  configureCanvas(state.compositeLayer, state.width, state.height);
  configureCanvas(state.committedMaskLayer, state.width, state.height);
  state.hasCommittedTearMask = false;
  state.layers = createSceneLayers();
  state.layerIndex = Math.min(state.layerIndex, state.layers.length - 2);
  if (!state.cloth) {
    state.cloth = createClothMesh({
      width: state.width,
      height: state.height,
      ...meshResolution(state.width),
      irregularity: 0.3,
    });
  } else {
    resizeClothMesh(state.cloth, state.width, state.height);
  }
  requestDraw();
}

function meshResolution(width) {
  return width < 760
    ? { columns: 96, rows: 62 }
    : { columns: 128, rows: 78 };
}

function createSceneLayers() {
  const uploaded = assignLayerImages(state.customImages, 3);
  if (uploaded.length > 0) {
    return uploaded.map((image, index) => createLayer((ctx, width, height) => {
      renderUploadedLayer(ctx, width, height, image, index);
    }));
  }
  return [
    createLayer(renderTopLayer),
    createLayer(renderDossierLayer),
    createLayer(renderBlueprintLayer),
  ];
}

function createLayer(render) {
  const layer = document.createElement('canvas');
  configureCanvas(layer, state.width, state.height);
  render(layer.getContext('2d'), state.width, state.height);
  return layer;
}

function configureCanvas(target, width, height) {
  target.width = Math.round(width * state.dpr);
  target.height = Math.round(height * state.dpr);
  target.style.width = `${width}px`;
  target.style.height = `${height}px`;
  target.getContext('2d').setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
}

function pointerPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return clampPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, state.width, state.height);
}

function requestDraw() {
  if (state.frameRequested) return;
  state.frameRequested = true;
  requestAnimationFrame(() => {
    state.frameRequested = false;
    draw();
    const shouldContinue = state.dragging || state.scraps.length > 0 || performance.now() < state.settleUntil;
    if (shouldContinue) {
      requestDraw();
    } else if (state.needsFinalSettle && state.cloth) {
      state.needsFinalSettle = false;
      state.settleUntil = 0;
      settleClothMesh(state.cloth, 1);
      requestDraw();
    }
  });
}

function tearBandRadius(source = state.dragSource) {
  const base = source === 'hand' ? state.width * 0.022 : state.width * 0.021;
  const minimum = source === 'hand' ? 16 : 14;
  const maximum = source === 'hand' ? 32 : 28;
  return Math.min(maximum, Math.max(minimum, base));
}

function minTearSegmentLength(source = state.dragSource) {
  return source === 'hand' ? 10 : 4;
}

function resolveCurrentTearStyle(source, segmentLength, dragDistance) {
  return resolveTearStyle({
    requestedStyle: state.tearStyle,
    source,
    dragDistance,
    segmentLength,
    viewportMin: Math.min(state.width, state.height),
  });
}

function draw() {
  const now = performance.now();
  context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  context.clearRect(0, 0, state.width, state.height);
  const currentLayer = state.layers[state.layerIndex] || state.topLayer;
  const nextLayer = state.layers[state.layerIndex + 1] || state.bottomLayer;
  const maskedRender = shouldUseMaskedRender();
  const renderCurrentLayer = maskedRender ? prepareMaskedCurrentLayer(currentLayer) : currentLayer;

  if (state.cloth) {
    const newlyBroken = stepClothMesh(state.cloth, {
      damping: state.dragging ? 0.972 : 0.9,
      gravity: state.dragging ? 0.015 : 0.035,
      iterations: state.dragging ? 3 : 4,
      pinDrift: state.dragging ? 0 : 0.08,
      tearRatio: state.dragging ? 3.2 : 7.5,
      grabStrength: state.dragging ? 0.9 : 0.13,
      tearCenter: null,
      tearSegment: state.dragging ? state.lastTearSegment : null,
      tearRadius: tearBandRadius(),
    });
    if (newlyBroken > 0 && state.pointer) {
      state.settleUntil = now + 1600;
      if (!state.dragging) spawnScraps(state.pointer, Math.min(2, newlyBroken));
    }
    const brokenEdges = brokenEdgeSet(state.cloth);
    const visibleBrokenEdges = shouldFreezeBrokenEdges({
      renderStyle: state.activeRenderStyle,
      isDragging: state.dragging,
    }) && state.dragStartBrokenEdges
      ? state.dragStartBrokenEdges
      : brokenEdges;
    renderer.render({
      nextLayer,
      currentLayer: renderCurrentLayer,
      mesh: state.cloth,
      brokenEdges: visibleBrokenEdges,
      ignoreBroken: maskedRender,
    });
    maybeAdvanceLayer();
  }

  drawTornPieces(context, currentLayer, now);
  drawScraps(context, now);
  if (state.uiVisible) {
    drawHandSkeleton(context, now);
    drawHandCursor(context, now);
  }
}

function maybeAdvanceLayer() {
  if (!state.cloth || state.dragging || state.layerIndex >= state.layers.length - 2) return;
  if (!shouldAdvanceLayer(state.cloth, {
    completedTearGestures: state.layerTearGestures,
    minCompletedTearGestures: 3,
  })) return;
  state.layerIndex += 1;
  state.dragStartBrokenEdges = null;
  state.dragStartBrokenCount = 0;
  state.dragDistance = 0;
  state.layerTearGestures = 0;
  state.needsFinalSettle = false;
  clearTearPaths();
  resetClothMesh(state.cloth);
  state.settleUntil = performance.now() + 900;
}

function startTear(point, source = 'pointer') {
  state.dragging = true;
  state.dragSource = source;
  state.pointer = point;
  state.previousPointer = point;
  state.dragStartBrokenEdges = state.cloth ? brokenEdgeSet(state.cloth) : new Set();
  state.dragStartBrokenCount = state.cloth ? state.cloth.brokenCount : 0;
  state.dragDistance = 0;
  state.lastTearSegment = null;
  state.lastScrapPoint = null;
  dismissReleasedDetachedPieces();
  startTearPath(point, source);
  if (state.cloth) {
    beginGrab(state.cloth, point, grabRadiusForSource({
      source,
      renderStyle: state.activeRenderStyle,
      viewportWidth: state.width,
    }));
  }
  requestDraw();
}

function moveTear(point, source = 'pointer') {
  if (!state.dragging || state.dragSource !== source) return;
  const previous = state.previousPointer || point;
  state.pointer = point;
  state.previousPointer = point;
  const segmentLength = Math.hypot(point.x - previous.x, point.y - previous.y);
  state.dragDistance += segmentLength;
  state.activeRenderStyle = resolveCurrentTearStyle(source, segmentLength, state.dragDistance);
  if (state.cloth) {
    moveGrab(state.cloth, point);
    if (segmentLength < minTearSegmentLength(source)) {
      requestDraw();
      return;
    }
    state.lastTearSegment = { from: previous, to: point };
    const feedbackWidth = tearWidthForMotion({
      source,
      dragDistance: state.dragDistance,
      segmentLength,
      viewportMin: Math.min(state.width, state.height),
    });
    const radiusScale = state.activeRenderStyle === 'sheet' ? 0.38 : state.activeRenderStyle === 'strip' ? 0.26 : 0.12;
    const stressRadius = Math.min(128, Math.max(tearBandRadius(source), feedbackWidth * radiusScale));
    const newlyBroken = stressClothMesh(
      state.cloth,
      previous,
      point,
      stressRadius,
      source === 'hand' ? 0.88 : 0.74,
      { minSegmentLength: minTearSegmentLength(source) },
    );
    extendTearPath(previous, point, source, newlyBroken);
    if (newlyBroken > 0) state.settleUntil = performance.now() + 1200;
  } else {
    extendTearPath(previous, point, source, 0);
  }
  requestDraw();
}

function endTear(source = 'pointer') {
  if (!state.dragging || state.dragSource !== source) return;
  const now = performance.now();
  const brokenDelta = state.cloth ? state.cloth.brokenCount - state.dragStartBrokenCount : 0;
  const meaningfulBreak = state.cloth
    ? Math.max(14, Math.floor(state.cloth.constraints.length * 0.0012))
    : 14;
  if (brokenDelta >= meaningfulBreak && state.dragDistance > Math.min(state.width, state.height) * 0.18) {
    state.layerTearGestures += 1;
  }
  if (state.activeTearPath) {
    state.activeTearPath.releasedAt = now;
    if (shouldCommitTearMask(state.activeTearPath)) {
      commitTearMask(state.activeTearPath);
      state.activeTearPath.maskCommitted = true;
    }
  }
  state.dragging = false;
  state.dragSource = null;
  state.previousPointer = null;
  state.dragStartBrokenEdges = null;
  state.dragStartBrokenCount = 0;
  state.dragDistance = 0;
  state.lastTearSegment = null;
  state.tearPaths = state.tearPaths.filter((path) => !path.maskCommitted);
  state.activeTearPath = null;
  if (state.cloth) releaseGrab(state.cloth);
  state.settleUntil = now + 1400;
  state.needsFinalSettle = true;
  requestDraw();
}

function startTearPath(point, source) {
  state.activeRenderStyle = resolveCurrentTearStyle(source, 0, 0);
  const baseWidth = tearWidthForMotion({
    source,
    dragDistance: 0,
    segmentLength: 0,
    viewportMin: Math.min(state.width, state.height),
  });
  const path = {
    source,
    style: state.activeRenderStyle,
    seed: Math.random() * 1000,
    createdAt: performance.now(),
    releasedAt: null,
    detachedDismissed: false,
    width: baseWidth,
    totalDistance: 0,
    lastVector: { x: 0, y: 0 },
    points: [{ x: point.x, y: point.y, width: baseWidth }],
  };
  state.activeTearPath = path;
  state.tearPaths.push(path);
  if (state.tearPaths.length > 7) state.tearPaths.shift();
}

function extendTearPath(previous, point, source, newlyBroken) {
  if (!state.activeTearPath) startTearPath(previous, source);
  const path = state.activeTearPath;
  const last = path.points[path.points.length - 1];
  const moved = Math.hypot(point.x - last.x, point.y - last.y);
  if (moved < 7) return;

  const pullDistance = Math.hypot(point.x - previous.x, point.y - previous.y);
  path.totalDistance += pullDistance;
  path.lastVector = { x: point.x - previous.x, y: point.y - previous.y };
  path.style = resolveCurrentTearStyle(source, pullDistance, path.totalDistance);
  state.activeRenderStyle = path.style;
  const widthTarget = tearWidthForMotion({
    source,
    dragDistance: path.totalDistance,
    segmentLength: pullDistance,
    viewportMin: Math.min(state.width, state.height),
  }) + Math.min(34, newlyBroken * 0.45);
  path.width = path.width * 0.9 + widthTarget * 0.1;
  path.points.push({ x: point.x, y: point.y, width: path.width });
  const maxPoints = path.style === 'sheet' ? 180 : path.style === 'strip' ? 132 : 96;
  if (path.points.length > maxPoints) path.points.splice(1, path.points.length - maxPoints);
}

function clearTearPaths() {
  state.tearPaths = [];
  state.tornPieces = [];
  state.activeTearPath = null;
  clearCommittedTearMask();
}

function commitTearMask(path) {
  const target = state.committedMaskLayer.getContext('2d');
  target.save();
  target.globalCompositeOperation = 'source-over';
  target.fillStyle = '#000';
  drawTornPathMasks(target, [path]);
  target.restore();
  state.hasCommittedTearMask = true;
  renderer.invalidateTexture(state.compositeLayer);
}

function clearCommittedTearMask() {
  const target = state.committedMaskLayer.getContext('2d');
  target.clearRect(0, 0, state.width, state.height);
  state.hasCommittedTearMask = false;
  renderer.invalidateTexture(state.compositeLayer);
}

function dismissReleasedDetachedPieces() {
  for (const path of state.tearPaths) {
    if (path.releasedAt) path.detachedDismissed = true;
  }
}

function shouldUseMaskedRender() {
  return state.hasCommittedTearMask || state.tearPaths.some((path) => shouldRenderTearMask(path, {
    activePath: state.activeTearPath,
    isDragging: state.dragging,
  }));
}

function prepareMaskedCurrentLayer(texture) {
  const target = state.compositeLayer.getContext('2d');
  target.clearRect(0, 0, state.width, state.height);
  target.globalCompositeOperation = 'source-over';
  target.globalAlpha = 1;
  target.drawImage(texture, 0, 0, state.width, state.height);
  target.globalCompositeOperation = 'destination-out';
  target.fillStyle = '#000';
  if (state.hasCommittedTearMask) {
    target.drawImage(state.committedMaskLayer, 0, 0, state.width, state.height);
  }
  drawTornPathMasks(target, state.tearPaths.filter((path) => shouldRenderTearMask(path, {
    activePath: state.activeTearPath,
    isDragging: state.dragging,
  })));
  target.globalCompositeOperation = 'source-over';
  renderer.invalidateTexture(state.compositeLayer);
  return state.compositeLayer;
}

function drawTornPieces(ctx, texture, now) {
  const visiblePaths = state.tearPaths.filter((path) => shouldRenderDetachedPiece(path, {
    activePath: state.activeTearPath,
    isDragging: state.dragging,
  }));
  for (const path of visiblePaths) {
    const alpha = detachedPieceOpacity(path, now, state.activeTearPath, { isDragging: state.dragging });
    if (alpha <= 0) continue;
    if (path.points.length < 2) continue;
    const polygon = buildRoughTearPolygon(path);
    if (polygon.length < 4) continue;
    const vector = path.lastVector || { x: 0, y: 0 };
    const length = Math.hypot(vector.x, vector.y) || 1;
    const lift = Math.min(path.style === 'sheet' ? 92 : 54, Math.max(16, path.width * 0.24));
    const releaseEase = path.releasedAt ? Math.min(1, Math.max(0, (now - path.releasedAt) / 340)) : 0;
    const releaseDrift = releaseEase * 18;
    const offset = {
      x: (vector.x / length) * (lift + releaseDrift),
      y: (vector.y / length) * lift - Math.min(22, path.width * 0.08) + releaseEase * 8,
    };

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,.42)';
    ctx.shadowBlur = path.style === 'sheet' ? 26 : 18;
    ctx.shadowOffsetX = offset.x * 0.18;
    ctx.shadowOffsetY = 18;
    ctx.translate(offset.x, offset.y);
    drawPolygon(ctx, polygon);
    ctx.clip();
    ctx.drawImage(texture, 0, 0, state.width, state.height);
    ctx.restore();

    drawPieceEdge(ctx, polygon, offset, path);
  }
}

function drawPieceEdge(ctx, polygon, offset, path) {
  ctx.save();
  ctx.translate(offset.x, offset.y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,248,233,.74)';
  ctx.lineWidth = path.style === 'sheet' ? 3.5 : 2.4;
  drawPolygon(ctx, polygon);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,.18)';
  ctx.lineWidth = 1.1;
  drawPolygon(ctx, polygon);
  ctx.stroke();
  ctx.restore();
}

function drawClothComposite(ctx, mesh, texture, now) {
  const brokenEdges = brokenEdgeSet(mesh);
  const topComposite = state.compositeLayer.getContext('2d');
  topComposite.clearRect(0, 0, state.width, state.height);
  topComposite.globalCompositeOperation = 'source-over';
  topComposite.drawImage(texture, 0, 0, state.width, state.height);

  if ((mesh.brokenCount > 0 || state.tearPaths.length > 0) && !state.dragging) {
    topComposite.globalCompositeOperation = 'destination-out';
    topComposite.fillStyle = '#000';
    drawTornPathMasks(topComposite, state.tearPaths);
    drawTornFiberMask(topComposite, mesh);
    topComposite.globalCompositeOperation = 'source-over';
  }

  ctx.drawImage(state.compositeLayer, 0, 0, state.width, state.height);
  if (state.dragging) drawDeformedPatch(ctx, mesh, texture, new Set(), now);
  if (!state.dragging && mesh.brokenCount > 0) {
    drawBrokenEdges(ctx, mesh, now);
  }
}

function drawElasticMembrane(ctx, mesh, texture, now) {
  if (!state.pointer || mesh.grabbed.length === 0) return;
  const anchors = mesh.grabbed
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.min(10, mesh.grabbed.length))
    .map((grab) => mesh.particles[grab.index]);
  if (anchors.length === 0) return;

  const anchor = anchors.reduce((sum, particle) => ({
    x: sum.x + particle.pinX,
    y: sum.y + particle.pinY,
  }), { x: 0, y: 0 });
  anchor.x /= anchors.length;
  anchor.y /= anchors.length;

  const dx = state.pointer.x - anchor.x;
  const dy = state.pointer.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 18) return;

  const nx = -dy / distance;
  const ny = dx / distance;
  const sheetWidth = Math.min(210, Math.max(58, distance * 0.24));
  const sag = Math.sin(now * 0.008) * 12;
  const c1 = {
    x: anchor.x + dx * 0.34 + nx * sag,
    y: anchor.y + dy * 0.34 + ny * sag - 22,
  };
  const c2 = {
    x: anchor.x + dx * 0.66 - nx * sag,
    y: anchor.y + dy * 0.66 - ny * sag + 18,
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.28)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 12;

  const body = ctx.createLinearGradient(anchor.x, anchor.y, state.pointer.x, state.pointer.y);
  body.addColorStop(0, 'rgba(248,241,224,.08)');
  body.addColorStop(0.5, 'rgba(236,226,202,.25)');
  body.addColorStop(1, 'rgba(248,241,224,.36)');
  ctx.strokeStyle = body;
  for (const layer of [
    { width: sheetWidth * 0.95, alpha: 0.34, offset: 0 },
    { width: sheetWidth * 0.62, alpha: 0.28, offset: Math.sin(now * 0.006) * sheetWidth * 0.08 },
    { width: sheetWidth * 0.36, alpha: 0.2, offset: -Math.sin(now * 0.007) * sheetWidth * 0.1 },
  ]) {
    drawMembraneCurve(ctx, anchor, c1, c2, state.pointer, nx, ny, layer.offset, layer.width, layer.alpha);
  }

  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,248,233,.42)';
  ctx.lineWidth = 1.1;
  ctx.globalAlpha = 0.42;
  for (const side of [-1, 1]) {
    drawMembraneCurve(ctx, anchor, c1, c2, state.pointer, nx, ny, side * sheetWidth * 0.5, 1.1, 0.42);
  }

  ctx.strokeStyle = 'rgba(255,248,233,.2)';
  ctx.lineWidth = 0.75;
  for (let index = -5; index <= 5; index += 1) {
    const offset = index * sheetWidth * 0.075 + Math.sin(now * 0.01 + index) * 5;
    ctx.beginPath();
    ctx.moveTo(anchor.x + nx * offset, anchor.y + ny * offset);
    ctx.bezierCurveTo(
      c1.x + nx * offset * 0.72,
      c1.y + ny * offset * 0.72,
      c2.x + nx * offset * 0.36,
      c2.y + ny * offset * 0.36,
      state.pointer.x + nx * offset * 0.08,
      state.pointer.y + ny * offset * 0.08,
    );
    ctx.stroke();
  }
  ctx.restore();
}

function drawMembraneCurve(ctx, anchor, c1, c2, pointer, nx, ny, offset, width, alpha) {
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(anchor.x + nx * offset, anchor.y + ny * offset);
  ctx.bezierCurveTo(
    c1.x + nx * offset * 0.72,
    c1.y + ny * offset * 0.72,
    c2.x + nx * offset * 0.36,
    c2.y + ny * offset * 0.36,
    pointer.x + nx * offset * 0.08,
    pointer.y + ny * offset * 0.08,
  );
  ctx.stroke();
}

function drawTensionLines(ctx, mesh, now) {
  if (!state.pointer || mesh.grabbed.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const limit = Math.min(mesh.grabbed.length, 12);
  for (let index = 0; index < limit; index += 1) {
    const grab = mesh.grabbed[index];
    const particle = mesh.particles[grab.index];
    const pulse = 0.45 + Math.sin(now * 0.011 + index) * 0.18;
    ctx.globalAlpha = Math.max(0.05, Math.min(0.18, grab.weight * pulse));
    ctx.strokeStyle = '#fff8e9';
    ctx.lineWidth = 0.8 + grab.weight * 1.1;
    ctx.beginPath();
    const midX = particle.x + (state.pointer.x - particle.x) * 0.52;
    const midY = particle.y + (state.pointer.y - particle.y) * 0.52 - 18 * grab.weight;
    ctx.moveTo(particle.x, particle.y);
    ctx.quadraticCurveTo(midX, midY, state.pointer.x, state.pointer.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTornPathMasks(ctx, paths) {
  ctx.save();
  ctx.lineJoin = 'round';
  for (const path of paths) {
    if (path.points.length < 2) continue;
    const polygon = buildRoughTearPolygon(path);
    if (polygon.length < 4) continue;
    ctx.beginPath();
    polygon.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fill();

    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(6, path.width * (path.style === 'sheet' ? 0.16 : 0.24));
    ctx.beginPath();
    path.points.forEach((point, index) => {
      const wiggle = jitter(path.seed, index, 4);
      if (index === 0) ctx.moveTo(point.x, point.y + wiggle);
      else {
        const previous = path.points[index - 1];
        ctx.quadraticCurveTo(
          (previous.x + point.x) * 0.5 + jitter(path.seed, index + 30, 8),
          (previous.y + point.y) * 0.5 + jitter(path.seed, index + 60, 8),
          point.x,
          point.y + wiggle,
        );
      }
    });
    ctx.stroke();
  }
  ctx.restore();
}

function buildRoughTearPolygon(path) {
  const left = [];
  const right = [];
  const count = path.points.length;
  const styleScale = path.style === 'sheet' ? 1.08 : path.style === 'strip' ? 0.58 : 0.34;
  const jaggedness = path.style === 'sheet' ? 0.11 : path.style === 'strip' ? 0.18 : 0.28;
  for (let index = 0; index < count; index += 1) {
    const point = path.points[index];
    const previous = path.points[Math.max(0, index - 1)];
    const next = path.points[Math.min(count - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const taper = count <= 2 ? 1 : 0.66 + Math.sin((index / (count - 1)) * Math.PI) * 0.34;
    const roughLeft = point.width * styleScale * taper * (0.56 + jitter(path.seed, index, jaggedness));
    const roughRight = point.width * styleScale * taper * (0.46 + jitter(path.seed, index + 100, jaggedness));
    const tangentNoise = jitter(path.seed, index + 200, path.style === 'sheet' ? 24 : 14);
    left.push({
      x: point.x + nx * roughLeft + (dx / length) * tangentNoise,
      y: point.y + ny * roughLeft + (dy / length) * tangentNoise,
    });
    right.push({
      x: point.x - nx * roughRight - (dx / length) * jitter(path.seed, index + 300, 13),
      y: point.y - ny * roughRight - (dy / length) * jitter(path.seed, index + 300, 13),
    });
  }
  return [...left, ...right.reverse()];
}

function drawTornFiberMask(ctx, mesh) {
  const structuralRest = Math.max(mesh.width / mesh.columns, mesh.height / mesh.rows) * 1.18;
  let drawn = 0;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const constraint of mesh.constraints) {
    if (!constraint.broken) continue;
    if (constraint.rest > structuralRest) continue;
    if (drawn > 180) break;
    const a = mesh.particles[constraint.a];
    const b = mesh.particles[constraint.b];
    const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    if (state.tearPaths.length > 0 && distanceToTearPaths(mid, state.tearPaths) > 80) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    const seed = a.u * 71 + b.v * 103 + drawn;
    const gap = 5 + Math.abs(jitter(seed, 1, 8));
    ctx.lineWidth = 4 + Math.abs(jitter(seed, 2, 10));
    ctx.beginPath();
    ctx.moveTo(a.x + nx * gap, a.y + ny * gap);
    ctx.quadraticCurveTo(
      mid.x + nx * jitter(seed, 3, 12),
      mid.y + ny * jitter(seed, 4, 12),
      b.x - nx * gap,
      b.y - ny * gap,
    );
    ctx.stroke();
    drawn += 1;
  }
  ctx.restore();
}

function distanceToTearPaths(point, paths) {
  let nearest = Infinity;
  for (const path of paths) {
    for (let index = 1; index < path.points.length; index += 1) {
      nearest = Math.min(nearest, distanceToSegment(point, path.points[index - 1], path.points[index]));
    }
  }
  return nearest;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return Math.hypot(point.x - x, point.y - y);
}

function jitter(seed, index, amplitude) {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return (value - Math.floor(value) - 0.5) * amplitude * 2;
}

function drawDeformedPatch(ctx, mesh, texture, brokenEdges, now) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.24)';
  ctx.shadowBlur = 10;
  let drawn = 0;

  for (let y = 0; y < mesh.rows; y += 1) {
    for (let x = 0; x < mesh.columns; x += 1) {
      for (const triangle of cellTriangles(mesh, x, y)) {
        if (triangleIsBroken(triangle, brokenEdges)) continue;
        const points = triangle.map((index) => mesh.particles[index]);
        if (!triangleHasVisibleMotion(points)) continue;
        if (triangleMaxEdge(points) > Math.max(78, Math.min(state.width, state.height) * 0.075)) continue;
        if (state.pointer && triangleDistanceTo(points, state.pointer) > 420) continue;
        drawTexturedTriangle(ctx, texture, points[0], points[1], points[2], now);
        drawn += 1;
        if (drawn > 760) {
          ctx.restore();
          return;
        }
      }
    }
  }
  ctx.restore();
}

function triangleMaxEdge([a, b, c]) {
  return Math.max(
    Math.hypot(a.x - b.x, a.y - b.y),
    Math.hypot(b.x - c.x, b.y - c.y),
    Math.hypot(c.x - a.x, c.y - a.y),
  );
}

function triangleHasVisibleMotion(points) {
  return points.some((point) => Math.hypot(point.x - point.pinX, point.y - point.pinY) > 10);
}

function triangleDistanceTo(points, target) {
  const x = (points[0].x + points[1].x + points[2].x) / 3;
  const y = (points[0].y + points[1].y + points[2].y) / 3;
  return Math.hypot(x - target.x, y - target.y);
}

function drawTexturedTriangle(ctx, image, p0, p1, p2, now) {
  const sx0 = p0.u * image.width;
  const sy0 = p0.v * image.height;
  const sx1 = p1.u * image.width;
  const sy1 = p1.v * image.height;
  const sx2 = p2.u * image.width;
  const sy2 = p2.v * image.height;
  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(denom) < 0.001) return;

  const wave0 = Math.sin(p0.u * 22 + p0.v * 11 + now * 0.006) * 1.1;
  const wave1 = Math.sin(p1.u * 22 + p1.v * 11 + now * 0.006) * 1.1;
  const wave2 = Math.sin(p2.u * 22 + p2.v * 11 + now * 0.006) * 1.1;
  const x0 = p0.x;
  const y0 = p0.y + wave0;
  const x1 = p1.x;
  const y1 = p1.y + wave1;
  const x2 = p2.x;
  const y2 = p2.y + wave2;
  const cx = (x0 + x1 + x2) / 3;
  const cy = (y0 + y1 + y2) / 3;
  const seamPad = 0.9;
  const clip0 = expandClipPoint(x0, y0, cx, cy, seamPad);
  const clip1 = expandClipPoint(x1, y1, cx, cy, seamPad);
  const clip2 = expandClipPoint(x2, y2, cx, cy, seamPad);

  const a = (x0 * (sy1 - sy2) + x1 * (sy2 - sy0) + x2 * (sy0 - sy1)) / denom;
  const b = (y0 * (sy1 - sy2) + y1 * (sy2 - sy0) + y2 * (sy0 - sy1)) / denom;
  const c = (sx0 * (x1 - x2) + sx1 * (x2 - x0) + sx2 * (x0 - x1)) / denom;
  const d = (sx0 * (y1 - y2) + sx1 * (y2 - y0) + sx2 * (y0 - y1)) / denom;
  const e = (sx0 * (sy2 * x1 - sy1 * x2) + sx1 * (sy0 * x2 - sy2 * x0) + sx2 * (sy1 * x0 - sy0 * x1)) / denom;
  const f = (sx0 * (sy2 * y1 - sy1 * y2) + sx1 * (sy0 * y2 - sy2 * y0) + sx2 * (sy1 * y0 - sy0 * y1)) / denom;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(clip0.x, clip0.y);
  ctx.lineTo(clip1.x, clip1.y);
  ctx.lineTo(clip2.x, clip2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

function expandClipPoint(x, y, cx, cy, amount) {
  const dx = x - cx;
  const dy = y - cy;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: x + (dx / length) * amount,
    y: y + (dy / length) * amount,
  };
}

function drawBrokenEdges(ctx, mesh, now) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const structuralRest = Math.max(mesh.width / mesh.columns, mesh.height / mesh.rows) * 1.15;
  let drawn = 0;
  for (const constraint of mesh.constraints) {
    if (drawn > 80) break;
    if (!constraint.broken) continue;
    if (constraint.rest > structuralRest) continue;
    const a = mesh.particles[constraint.a];
    const b = mesh.particles[constraint.b];
    const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    if (state.tearPaths.length > 0 && distanceToTearPaths(mid, state.tearPaths) > 72) continue;
    const flutter = Math.sin(now * 0.01 + a.u * 9) * 2;
    ctx.strokeStyle = 'rgba(0,0,0,.16)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + flutter);
    ctx.lineTo(b.x, b.y - flutter);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,248,233,.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + flutter);
    ctx.lineTo(b.x, b.y - flutter);
    ctx.stroke();
    drawn += 1;
  }
  ctx.restore();
}

function brokenEdgeSet(mesh) {
  const edges = new Set();
  for (const constraint of mesh.constraints) {
    if (constraint.broken) edges.add(edgeKey(constraint.a, constraint.b));
  }
  return edges;
}

function triangleIsBroken([a, b, c], brokenEdges) {
  return brokenEdges.has(edgeKey(a, b)) || brokenEdges.has(edgeKey(b, c)) || brokenEdges.has(edgeKey(c, a));
}

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function renderUploadedLayer(ctx, width, height, image, index) {
  ctx.fillStyle = index % 2 === 0 ? '#15110e' : '#0d1418';
  ctx.fillRect(0, 0, width, height);
  drawImageCover(ctx, image, 0, 0, width, height);

  const vignette = ctx.createRadialGradient(width * 0.5, height * 0.48, height * 0.24, width * 0.5, height * 0.5, width * 0.72);
  vignette.addColorStop(0, 'rgba(255,255,255,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,.26)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#fff8e9';
  ctx.lineWidth = 1;
  for (let y = 0; y < height; y += 18) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.sin(y * 0.031 + index) * 3);
    ctx.bezierCurveTo(
      width * 0.28,
      y + Math.sin(y * 0.022 + index * 3) * 6,
      width * 0.7,
      y + Math.cos(y * 0.017 + index) * 5,
      width,
      y + Math.sin(y * 0.011) * 4,
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawImageCover(ctx, image, x, y, width, height) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function renderTopLayer(ctx, width, height) {
  const wall = ctx.createLinearGradient(0, 0, width, height);
  wall.addColorStop(0, '#dac9af');
  wall.addColorStop(0.52, '#b89261');
  wall.addColorStop(1, '#3b2a1c');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, width, height);

  drawWindow(ctx, width, height);
  drawDesk(ctx, width, height);
  drawLaptop(ctx, width, height);
  drawHangingPlant(ctx, width, height);
  drawRoomVignette(ctx, width, height);
}

function renderDossierLayer(ctx, width, height) {
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#211e1a');
  bg.addColorStop(0.55, '#604a31');
  bg.addColorStop(1, '#0e0d0c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width * 0.47, height * 0.48);
  ctx.rotate(-0.045);
  const paperW = Math.min(width * 0.84, 980);
  const paperH = Math.min(height * 0.76, 720);
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 34;
  ctx.fillStyle = '#f2ead7';
  roundRect(ctx, -paperW / 2, -paperH / 2, paperW, paperH, 7);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#191613';
  ctx.font = `900 ${Math.max(34, paperW * 0.075)}px Georgia, serif`;
  ctx.fillText('DOSSIER 13/100', -paperW * 0.42, -paperH * 0.34);
  ctx.font = `700 ${Math.max(17, paperW * 0.027)}px Georgia, serif`;
  ctx.fillText('"What if we could tear down reality?"', -paperW * 0.42, -paperH * 0.22);

  ctx.fillStyle = '#111';
  for (let index = 0; index < 5; index += 1) {
    ctx.fillRect(-paperW * 0.42, -paperH * 0.07 + index * 34, paperW * (0.76 - index * 0.08), 13);
  }

  ctx.strokeStyle = '#a93428';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(paperW * 0.28, -paperH * 0.16, 94, 54, -0.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#a93428';
  ctx.font = `900 ${Math.max(19, paperW * 0.034)}px Georgia, serif`;
  ctx.fillText('DECLASSIFIED', paperW * 0.11, -paperH * 0.13);
  ctx.restore();
}

function renderBlueprintLayer(ctx, width, height) {
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#111a21');
  bg.addColorStop(0.55, '#274b5a');
  bg.addColorStop(1, '#071015');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width * 0.5, height * 0.5);
  ctx.rotate(0.035);
  const sheetW = Math.min(width * 0.78, 920);
  const sheetH = Math.min(height * 0.64, 560);
  ctx.shadowColor = 'rgba(0,0,0,.48)';
  ctx.shadowBlur = 30;
  ctx.fillStyle = '#d7eef0';
  roundRect(ctx, -sheetW / 2, -sheetH / 2, sheetW, sheetH, 8);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(22,91,105,.38)';
  ctx.lineWidth = 2;
  for (let x = -sheetW / 2 + 36; x < sheetW / 2; x += 42) {
    ctx.beginPath();
    ctx.moveTo(x, -sheetH / 2 + 24);
    ctx.lineTo(x, sheetH / 2 - 24);
    ctx.stroke();
  }
  for (let y = -sheetH / 2 + 34; y < sheetH / 2; y += 42) {
    ctx.beginPath();
    ctx.moveTo(-sheetW / 2 + 24, y);
    ctx.lineTo(sheetW / 2 - 24, y);
    ctx.stroke();
  }

  ctx.strokeStyle = '#174d5d';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.rect(-sheetW * 0.32, -sheetH * 0.18, sheetW * 0.42, sheetH * 0.35);
  ctx.moveTo(-sheetW * 0.11, -sheetH * 0.18);
  ctx.lineTo(-sheetW * 0.11, sheetH * 0.17);
  ctx.moveTo(-sheetW * 0.32, -sheetH * 0.02);
  ctx.lineTo(sheetW * 0.1, -sheetH * 0.02);
  ctx.stroke();

  ctx.fillStyle = '#174d5d';
  ctx.font = `900 ${Math.max(28, sheetW * 0.055)}px Georgia, serif`;
  ctx.fillText('ROOM LAYER 03', -sheetW * 0.42, -sheetH * 0.33);
  ctx.font = `700 ${Math.max(15, sheetW * 0.024)}px Georgia, serif`;
  ctx.fillText('Under the dossier: another surface to tear.', -sheetW * 0.42, sheetH * 0.35);
  ctx.restore();
}

function drawWindow(ctx, width, height) {
  const wx = width * 0.22;
  const wy = height * 0.13;
  const ww = width * 0.48;
  const wh = height * 0.58;
  ctx.save();
  ctx.shadowColor = 'rgba(255,239,203,.48)';
  ctx.shadowBlur = 34;
  ctx.fillStyle = '#f6eddc';
  roundRect(ctx, wx, wy, ww, wh, 18);
  ctx.fill();
  ctx.shadowBlur = 0;

  const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
  sky.addColorStop(0, '#cfe8eb');
  sky.addColorStop(1, '#d8ccb4');
  ctx.fillStyle = sky;
  roundRect(ctx, wx + 22, wy + 22, ww - 44, wh - 44, 10);
  ctx.fill();

  ctx.strokeStyle = '#f9f2e6';
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(wx + ww / 2, wy + 20);
  ctx.lineTo(wx + ww / 2, wy + wh - 20);
  ctx.moveTo(wx + 20, wy + wh * 0.52);
  ctx.lineTo(wx + ww - 20, wy + wh * 0.52);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(92,87,57,.28)';
  ctx.lineWidth = 4;
  for (let index = 0; index < 8; index += 1) {
    const x = wx + 50 + index * ww * 0.075;
    ctx.beginPath();
    ctx.moveTo(x, wy + wh * 0.18);
    ctx.bezierCurveTo(x + 18, wy + wh * 0.34, x - 20, wy + wh * 0.5, x + 8, wy + wh * 0.76);
    ctx.stroke();
  }
  ctx.restore();
}

function drawDesk(ctx, width, height) {
  const y = height * 0.72;
  const wood = ctx.createLinearGradient(0, y, 0, height);
  wood.addColorStop(0, '#a45d25');
  wood.addColorStop(1, '#4a2510');
  ctx.fillStyle = wood;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y - height * 0.04);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,222,164,.12)';
  for (let index = 0; index < 9; index += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y + index * 28);
    ctx.bezierCurveTo(width * 0.25, y + index * 20, width * 0.55, y + index * 38, width, y + index * 24);
    ctx.stroke();
  }
}

function drawLaptop(ctx, width, height) {
  const cx = width * 0.52;
  const top = height * 0.58;
  const screenW = Math.min(width * 0.44, 620);
  const screenH = screenW * 0.54;
  ctx.save();
  ctx.translate(cx, top + screenH * 0.42);
  ctx.fillStyle = '#15191e';
  roundRect(ctx, -screenW / 2, -screenH / 2, screenW, screenH, 12);
  ctx.fill();
  ctx.fillStyle = '#273343';
  ctx.fillRect(-screenW / 2 + 18, -screenH / 2 + 18, screenW - 36, screenH - 42);
  ctx.fillStyle = '#78acd0';
  ctx.fillRect(-screenW / 2 + 18, -screenH / 2 + 18, screenW - 36, screenH * 0.42);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  for (let index = 0; index < 14; index += 1) {
    ctx.fillRect(-screenW / 2 + 34, -screenH / 2 + 34 + index * 8, 90 + Math.sin(index) * 38, 2);
  }
  ctx.fillStyle = '#1d1410';
  ctx.beginPath();
  ctx.moveTo(-screenW * 0.58, screenH / 2 - 4);
  ctx.lineTo(screenW * 0.58, screenH / 2 - 4);
  ctx.lineTo(screenW * 0.68, screenH / 2 + 58);
  ctx.lineTo(-screenW * 0.68, screenH / 2 + 58);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHangingPlant(ctx, width, height) {
  ctx.save();
  ctx.strokeStyle = 'rgba(49,61,27,.78)';
  ctx.lineWidth = 3;
  for (let index = 0; index < 5; index += 1) {
    const startX = width * (0.56 + index * 0.055);
    const endX = width * (0.64 + index * 0.04);
    const endY = height * (0.25 + index * 0.09);
    ctx.beginPath();
    ctx.moveTo(startX, -20);
    ctx.bezierCurveTo(startX + 30, height * 0.15, endX - 30, height * 0.2, endX, endY);
    ctx.stroke();
    ctx.fillStyle = index % 2 ? '#637c28' : '#324d18';
    ctx.beginPath();
    ctx.ellipse(endX, endY, 13, 22, Math.PI * 0.2 + index, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawRoomVignette(ctx, width, height) {
  const vignette = ctx.createRadialGradient(width * 0.52, height * 0.45, height * 0.2, width * 0.5, height * 0.5, width * 0.78);
  vignette.addColorStop(0, 'rgba(255,255,255,0)');
  vignette.addColorStop(1, 'rgba(11,7,3,.58)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

function drawTearShadow(ctx, opening) {
  context.save();
  drawPolygon(context, opening.polygon);
  context.shadowColor = 'rgba(0,0,0,.52)';
  context.shadowBlur = 28;
  context.strokeStyle = 'rgba(0,0,0,.55)';
  context.lineWidth = 26;
  context.stroke();
  context.restore();
}

function drawRawEdges(ctx, opening, now) {
  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  drawEdgeLine(context, opening.upper, now, 1);
  drawEdgeLine(context, opening.lower, now, -1);
  context.restore();
}

function drawEdgeLine(ctx, points, now, direction) {
  ctx.strokeStyle = '#fff8e9';
  ctx.lineWidth = 13;
  tracePoints(ctx, points, direction * Math.sin(now / 180) * 0.6);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(30,26,22,.72)';
  ctx.lineWidth = 3;
  ctx.setLineDash([12, 9]);
  tracePoints(ctx, points, 0);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawLiftedFlap(ctx, opening) {
  const { anchor, current, distance, angle, normal } = opening;
  const pull = Math.min(1, distance / 520);
  const flapLength = Math.min(380, 120 + distance * 0.46);
  const flapWidth = Math.min(155, 48 + distance * 0.13);
  const cx = current.x + normal.x * 42;
  const cy = current.y + normal.y * 42;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0,0,0,.5)';
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 18;

  const curl = ctx.createLinearGradient(-flapLength, -flapWidth, flapLength, flapWidth);
  curl.addColorStop(0, '#f9f2e5');
  curl.addColorStop(0.5, '#e0c5a1');
  curl.addColorStop(1, '#8b6c4d');
  ctx.fillStyle = curl;
  ctx.beginPath();
  ctx.moveTo(0, -flapWidth * 0.48);
  ctx.bezierCurveTo(-flapLength * 0.22, -flapWidth * (0.68 + pull * 0.16), -flapLength * 0.68, -flapWidth * 0.55, -flapLength, -flapWidth * 0.18);
  ctx.bezierCurveTo(-flapLength * 0.82, flapWidth * 0.24, -flapLength * 0.38, flapWidth * (0.6 + pull * 0.12), 0, flapWidth * 0.48);
  ctx.bezierCurveTo(flapLength * 0.08, flapWidth * 0.18, flapLength * 0.08, -flapWidth * 0.18, 0, -flapWidth * 0.48);
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-flapLength * 0.85, -flapWidth * 0.15);
  ctx.bezierCurveTo(-flapLength * 0.55, -flapWidth * 0.05, -flapLength * 0.3, flapWidth * 0.22, -flapLength * 0.04, flapWidth * 0.08);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255,248,233,.8)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(anchor.x, anchor.y);
  ctx.lineTo(current.x, current.y);
  ctx.stroke();
  ctx.restore();
}

function drawScraps(ctx, now) {
  const live = [];
  for (const scrap of state.scraps) {
    const age = (now - scrap.createdAt) / 1000;
    if (age > 1.6) continue;
    live.push(scrap);
    ctx.save();
    ctx.globalAlpha = 1 - age / 1.6;
    ctx.translate(scrap.x + scrap.vx * age * 76, scrap.y + scrap.vy * age * 76 + age * age * 42);
    ctx.rotate(scrap.rotation + age * scrap.spin);
    ctx.fillStyle = scrap.color;
    ctx.fillRect(-scrap.size / 2, -scrap.size / 2, scrap.size, scrap.size * 0.45);
    ctx.restore();
  }
  state.scraps = live;
}

function spawnScraps(point, preferredCount = 3) {
  if (state.lastScrapPoint && Math.hypot(point.x - state.lastScrapPoint.x, point.y - state.lastScrapPoint.y) < 70) return;
  state.lastScrapPoint = point;
  const available = Math.max(0, 30 - state.scraps.length);
  const count = Math.min(available, preferredCount);
  for (let index = 0; index < count; index += 1) {
    state.scraps.push({
      x: point.x,
      y: point.y,
      vx: (Math.random() - 0.5) * 1.5,
      vy: -0.3 - Math.random() * 1.1,
      size: 1 + Math.random() * 2.2,
      spin: (Math.random() - 0.5) * 5.6,
      rotation: Math.random() * Math.PI,
      color: Math.random() > 0.45 ? '#f5ead4' : '#c99a5a',
      createdAt: performance.now(),
    });
  }
}

async function startHandTracking() {
  if (state.hand.initializing) return;
  if (state.hand.enabled) {
    stopHandTracking();
    return;
  }

  state.hand.initializing = true;
  setHandStatus('Starting camera...');
  handToggleButton.disabled = true;

  try {
    state.hand.tracker = new HandTracker(handVideo);
    await state.hand.tracker.initialize();
    state.hand.enabled = true;
    handVideo.classList.add('visible');
    handToggleButton.textContent = 'Hand On';
    setHandStatus('Pinch thumb + index to grab');
    state.hand.tracker.start(handleHandFrame);
  } catch (error) {
    console.error(error);
    setHandStatus(error?.message || 'Hand tracking failed');
    stopHandTracking();
  } finally {
    state.hand.initializing = false;
    handToggleButton.disabled = false;
  }
}

function stopHandTracking() {
  state.hand.tracker?.stop();
  state.hand.enabled = false;
  state.hand.visible = false;
  state.hand.pinching = false;
  state.hand.twoHandPinching = false;
  state.hand.point = null;
  state.hand.landmarks = null;
  state.hand.hands = [];
  state.hand.lastSeenAt = 0;
  state.hand.twoHand.previousCenter = null;
  state.hand.twoHand.previousLeftPoint = null;
  state.hand.twoHand.previousRightPoint = null;
  state.hand.twoHand.previousDistance = 0;
  state.hand.twoHand.startDistance = 0;
  handVideo.classList.remove('visible');
  handToggleButton.textContent = 'Hand';
  setHandStatus('Hand tracking off');
  endTear('hand');
  endTear('two-hand');
  requestDraw();
}

function handleHandFrame(frame) {
  if (frame === undefined) return;
  const now = performance.now();
  const hands = normalizeHandFrame(frame);
  if (hands.length === 0) {
    const missingFor = state.hand.lastSeenAt ? now - state.hand.lastSeenAt : Infinity;
    if ((state.hand.pinching || state.hand.twoHandPinching) && missingFor > 260) {
      state.hand.pinching = false;
      state.hand.twoHandPinching = false;
      endTear('hand');
      endTear('two-hand');
    }
    if (!state.hand.pinching && !state.hand.twoHandPinching && missingFor > 260) {
      state.hand.visible = false;
      state.hand.confidence = 0;
      state.hand.landmarks = null;
      state.hand.hands = [];
    }
    setHandStatus((state.hand.pinching || state.hand.twoHandPinching) ? 'Hold pinch: tracking briefly lost' : 'Show one or two hands to the camera');
    requestDraw();
    return;
  }

  const canvasHands = hands.map(canvasHand).sort((a, b) => a.point.x - b.point.x);
  const primary = canvasHands[0];
  state.hand.hands = canvasHands;
  state.hand.landmarks = primary.landmarks;
  state.hand.point = smoothPoint(state.hand.point, primary.point, HAND_POINT_SMOOTHING);
  state.hand.visible = true;
  state.hand.confidence = Math.max(...hands.map((hand) => hand.confidence));
  state.hand.lastSeenAt = now;

  const pinchingHands = canvasHands.filter((hand) => hand.pinching);
  if (pinchingHands.length >= 2) {
    if (state.hand.pinching) {
      state.hand.pinching = false;
      endTear('hand');
    }
    if (!state.hand.twoHandPinching) {
      state.hand.twoHandPinching = true;
      startTwoHandTear(pinchingHands[0], pinchingHands[1]);
    } else {
      moveTwoHandTear(pinchingHands[0], pinchingHands[1]);
    }
    setHandStatus('Two-hand pull: stretch a larger sheet');
    requestDraw();
    return;
  }

  if (state.hand.twoHandPinching) {
    state.hand.twoHandPinching = false;
    endTear('two-hand');
  }

  const pinchHand = pinchingHands[0];
  if (pinchHand && !state.hand.pinching) {
    state.hand.pinching = true;
    state.hand.point = pinchHand.point;
    startTear(pinchHand.point, 'hand');
  } else if (pinchHand) {
    state.hand.point = smoothPoint(state.hand.point, pinchHand.point, HAND_POINT_SMOOTHING);
    moveTear(state.hand.point, 'hand');
  } else if (state.hand.pinching) {
    state.hand.pinching = false;
    endTear('hand');
  }

  setHandStatus(state.hand.pinching ? 'Pinching: pulling surface' : 'Open hand: move cursor');
  requestDraw();
}

function normalizeHandFrame(frame) {
  if (!frame) return [];
  return Array.isArray(frame) ? frame : [frame];
}

function canvasHand(hand) {
  const point = handPointToCanvas(hand.pinchCenter);
  const landmarks = hand.landmarks.map(handLandmarkToCanvas);
  const pinching = hand.pinchDistance < (state.hand.pinching || state.hand.twoHandPinching ? 0.46 : 0.34);
  return { ...hand, point, landmarks, pinching };
}

function smoothPoint(previous, point, amount) {
  return previous ? {
    x: previous.x * (1 - amount) + point.x * amount,
    y: previous.y * (1 - amount) + point.y * amount,
  } : point;
}

function startTwoHandTear(left, right) {
  const center = midpoint(left.point, right.point);
  state.dragging = true;
  state.dragSource = 'two-hand';
  state.pointer = center;
  state.previousPointer = center;
  state.dragStartBrokenEdges = state.cloth ? brokenEdgeSet(state.cloth) : new Set();
  state.dragStartBrokenCount = state.cloth ? state.cloth.brokenCount : 0;
  state.dragDistance = 0;
  state.lastTearSegment = { from: left.point, to: right.point };
  state.lastScrapPoint = null;
  state.hand.twoHand.previousCenter = center;
  state.hand.twoHand.previousDistance = distance(left.point, right.point);
  state.hand.twoHand.previousLeftPoint = left.point;
  state.hand.twoHand.previousRightPoint = right.point;
  state.hand.twoHand.startDistance = state.hand.twoHand.previousDistance;
  dismissReleasedDetachedPieces();
  startTearPath(center, 'two-hand');
  updateTwoHandPath(left, right, 0);
  if (state.cloth) {
    beginGrab(state.cloth, center, grabRadiusForSource({
      source: 'two-hand',
      renderStyle: state.activeRenderStyle,
      viewportWidth: state.width,
      handSpan: state.hand.twoHand.previousDistance,
    }));
  }
  requestDraw();
}

function moveTwoHandTear(left, right) {
  if (!state.dragging || state.dragSource !== 'two-hand') return;
  const rawCenter = midpoint(left.point, right.point);
  const previousCenter = state.hand.twoHand.previousCenter || rawCenter;
  const center = smoothPoint(previousCenter, rawCenter, TWO_HAND_CENTER_SMOOTHING);
  const currentDistance = distance(left.point, right.point);
  const previousDistance = state.hand.twoHand.previousDistance || currentDistance;
  const distanceDelta = Math.max(0, currentDistance - previousDistance);
  const centerMove = distance(previousCenter, center);
  const segments = twoHandTearSegments({
    previousLeft: state.hand.twoHand.previousLeftPoint,
    previousRight: state.hand.twoHand.previousRightPoint,
    left: left.point,
    right: right.point,
    minMove: minTearSegmentLength('hand'),
  });
  const segmentLength = Math.max(centerMove, distanceDelta * 0.35, ...segments.map((segment) => distance(segment.from, segment.to)));
  state.pointer = center;
  state.previousPointer = center;
  state.dragDistance += segmentLength;
  state.lastTearSegment = strongestSegment(segments);
  state.activeRenderStyle = resolveCurrentTearStyle('two-hand', segmentLength, state.dragDistance);

  let newlyBroken = 0;
  if (state.cloth) {
    moveGrab(state.cloth, center);
    const radius = Math.min(96, Math.max(30, currentDistance * 0.055 + distanceDelta * 0.35));
    for (const segment of segments) {
      newlyBroken += stressClothMesh(
        state.cloth,
        segment.from,
        segment.to,
        radius,
        0.82,
        { minSegmentLength: minTearSegmentLength('hand') },
      );
    }
    if (newlyBroken > 0) state.settleUntil = performance.now() + 1400;
  }

  updateTwoHandPath(left, right, newlyBroken);
  state.hand.twoHand.previousCenter = center;
  state.hand.twoHand.previousDistance = currentDistance;
  state.hand.twoHand.previousLeftPoint = left.point;
  state.hand.twoHand.previousRightPoint = right.point;
  requestDraw();
}

function strongestSegment(segments) {
  let strongest = null;
  let longest = 0;
  for (const segment of segments) {
    const length = distance(segment.from, segment.to);
    if (length > longest) {
      strongest = segment;
      longest = length;
    }
  }
  return strongest;
}

function updateTwoHandPath(left, right, newlyBroken) {
  if (!state.activeTearPath) startTearPath(midpoint(left.point, right.point), 'two-hand');
  const path = state.activeTearPath;
  const span = distance(left.point, right.point);
  path.source = 'two-hand';
  path.style = resolveCurrentTearStyle('two-hand', span, state.dragDistance);
  path.totalDistance = Math.max(path.totalDistance || 0, state.dragDistance);
  path.lastVector = { x: right.point.x - left.point.x, y: right.point.y - left.point.y };
  const widthTarget = tearWidthForMotion({
    source: 'two-hand',
    dragDistance: state.dragDistance,
    segmentLength: span,
    viewportMin: Math.min(state.width, state.height),
  }) + Math.min(42, newlyBroken * 0.32);
  path.width = path.width * 0.86 + widthTarget * 0.14;
  path.points = [
    { x: left.point.x, y: left.point.y, width: path.width },
    { x: right.point.x, y: right.point.y, width: path.width },
  ];
}

function midpoint(a, b) {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function handPointToCanvas(point) {
  return handLandmarkToCanvas(point);
}

function handLandmarkToCanvas(point) {
  return clampPoint({
    x: (1 - point.x) * state.width,
    y: point.y * state.height,
  }, state.width, state.height);
}

function setHandStatus(text) {
  handStatus.textContent = text;
}

function drawHandSkeleton(ctx, now) {
  if (!state.hand.enabled || !state.hand.visible || state.hand.hands.length === 0) return;
  const bones = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 10;
  for (const hand of state.hand.hands) {
    const landmarks = hand.landmarks;
    const activePinch = hand.pinching;
    ctx.globalAlpha = 0.78;
    ctx.strokeStyle = activePinch ? 'rgba(255,248,233,.92)' : 'rgba(151,218,232,.72)';
    ctx.lineWidth = activePinch ? 3 : 2;
    for (const [a, b] of bones) {
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x, landmarks[a].y);
      ctx.lineTo(landmarks[b].x, landmarks[b].y);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    for (let index = 0; index < landmarks.length; index += 1) {
      const point = landmarks[index];
      const isPinchTip = index === 4 || index === 8;
      ctx.globalAlpha = isPinchTip ? 0.95 : 0.72;
      ctx.fillStyle = isPinchTip ? '#fff8e9' : 'rgba(151,218,232,.92)';
      ctx.beginPath();
      ctx.arc(point.x, point.y, isPinchTip ? 5.2 : 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (landmarks[4] && landmarks[8]) {
      const thumb = landmarks[4];
      const index = landmarks[8];
      ctx.globalAlpha = activePinch ? 0.9 : 0.34;
      ctx.strokeStyle = activePinch ? '#fff8e9' : 'rgba(255,248,233,.6)';
      ctx.lineWidth = activePinch ? 3 : 1.5;
      ctx.setLineDash(activePinch ? [] : [6, 7]);
      ctx.beginPath();
      ctx.moveTo(thumb.x, thumb.y);
      ctx.lineTo(index.x, index.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (activePinch) {
        ctx.globalAlpha = 0.84 + Math.sin(now * 0.014) * 0.08;
        ctx.fillStyle = '#fff8e9';
        ctx.font = '800 11px Aptos, Segoe UI, sans-serif';
        ctx.fillText('PINCH', hand.point.x + 18, hand.point.y - 18);
      }
    }
  }
  ctx.restore();
}

function drawHandCursor(ctx, now) {
  if (!state.hand.enabled || !state.hand.visible || state.hand.hands.length === 0) return;
  ctx.save();
  for (const hand of state.hand.hands) {
    const point = hand.point;
    const radius = hand.pinching ? 22 : 15;
    ctx.globalAlpha = 0.78;
    ctx.lineWidth = hand.pinching ? 3 : 2;
    ctx.strokeStyle = hand.pinching ? '#fff8e9' : 'rgba(248,239,225,.72)';
    ctx.fillStyle = hand.pinching ? 'rgba(248,239,225,.18)' : 'rgba(120,172,208,.15)';
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius + Math.sin(now * 0.014) * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#fff8e9';
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPolygon(ctx, polygon) {
  ctx.beginPath();
  polygon.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
}

function tracePoints(ctx, points, offset) {
  ctx.beginPath();
  points.forEach((point, index) => {
    const y = point.y + Math.sin(index * 1.7) * offset;
    if (index === 0) ctx.moveTo(point.x, y);
    else ctx.lineTo(point.x, y);
  });
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function resetInteractionState({ resetLayer = true } = {}) {
  endTear('hand');
  endTear('pointer');
  state.pointer = null;
  state.previousPointer = null;
  state.dragStartBrokenEdges = null;
  state.dragStartBrokenCount = 0;
  state.dragDistance = 0;
  state.lastTearSegment = null;
  state.dragSource = null;
  state.activeRenderStyle = 'shards';
  if (resetLayer) state.layerIndex = 0;
  state.layerTearGestures = 0;
  state.scraps = [];
  clearTearPaths();
  state.tornPieces = [];
  state.lastScrapPoint = null;
  state.settleUntil = 0;
  state.needsFinalSettle = false;
  if (state.cloth) resetClothMesh(state.cloth);
  requestDraw();
}

function setUiVisible(visible) {
  state.uiVisible = visible;
  stageShell.classList.toggle('ui-hidden', !visible);
  uiToggleButton.textContent = visible ? 'UI On' : 'UI Hidden';
  uiToggleButton.setAttribute('aria-pressed', String(visible));
  requestDraw();
}

function cycleTearStyle() {
  const currentIndex = TEAR_STYLES.indexOf(state.tearStyle);
  state.tearStyle = TEAR_STYLES[(currentIndex + 1) % TEAR_STYLES.length] || 'auto';
  updateTearStyleLabel();
}

function updateTearStyleLabel() {
  const label = state.tearStyle[0].toUpperCase() + state.tearStyle.slice(1);
  tearStyleToggleButton.textContent = `Tear ${label}`;
}

async function handleLayerUpload(event) {
  const files = Array.from(event.target.files || [])
    .filter((file) => file.type.startsWith('image/'))
    .slice(0, 3);
  event.target.value = '';
  if (files.length === 0) return;

  const uploads = await Promise.all(files.map(loadImageFile));
  state.customImageUrls.forEach((url) => URL.revokeObjectURL(url));
  state.customImageUrls = uploads.map((upload) => upload.url);
  state.customImages = uploads.map((upload) => upload.image);
  state.layers = createSceneLayers();
  layerUploadButton.textContent = files.length === 1 ? 'Image 1x3' : `Images ${files.length}/3`;
  resetInteractionState({ resetLayer: true });
}

function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  return new Promise((resolve, reject) => {
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not load ${file.name}`));
    };
    image.src = url;
  });
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  startTear(pointerPoint(event), 'pointer');
});

canvas.addEventListener('pointermove', (event) => {
  moveTear(pointerPoint(event), 'pointer');
});

canvas.addEventListener('pointerup', (event) => {
  endTear('pointer');
  canvas.releasePointerCapture(event.pointerId);
});

canvas.addEventListener('pointercancel', () => {
  endTear('pointer');
});

resetButton.addEventListener('click', () => {
  resetInteractionState({ resetLayer: true });
});

handToggleButton.addEventListener('click', () => {
  startHandTracking();
});

tearStyleToggleButton.addEventListener('click', () => {
  cycleTearStyle();
});

uiToggleButton.addEventListener('click', () => {
  const nextVisible = !state.uiVisible;
  setUiVisible(nextVisible);
  if (!nextVisible) uiToggleButton.blur();
});

layerUploadButton.addEventListener('click', () => {
  layerUploadInput.click();
});

layerUploadInput.addEventListener('change', handleLayerUpload);

window.addEventListener('resize', resize);
resize();
