import { FilesetResolver, HandLandmarker } from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
import { analyzeHands } from './handAnalysis.js';

export class HandTracker {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.handLandmarker = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.lastHands = [];
    this.smoothing = 0.42;
    this.lastDetectAt = 0;
    this.minDetectInterval = 66;
  }

  async initialize() {
    const vision = await FilesetResolver.forVisionTasks(
      '/node_modules/@mediapipe/tasks-vision/wasm',
    );

    this.handLandmarker = await createHandLandmarker(vision);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 640, max: 960 },
        height: { ideal: 360, max: 540 },
        frameRate: { ideal: 24, max: 24 },
      },
      audio: false,
    });

    this.videoElement.srcObject = stream;
    await new Promise((resolve) => {
      this.videoElement.onloadedmetadata = resolve;
    });
    await this.videoElement.play();
  }

  start(onFrame) {
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      const hand = this.detect();
      onFrame(hand);
      requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
  }

  detect() {
    if (!this.handLandmarker || this.videoElement.readyState < 2) return undefined;
    const now = performance.now();
    if (now - this.lastDetectAt < this.minDetectInterval) return undefined;
    if (this.videoElement.currentTime === this.lastVideoTime) return undefined;
    this.lastDetectAt = now;
    this.lastVideoTime = this.videoElement.currentTime;

    const result = this.handLandmarker.detectForVideo(this.videoElement, now);
    const landmarks = (result.landmarks || [])
      .filter((handLandmarks) => handLandmarks.length >= 21)
      .sort((a, b) => a[0].x - b[0].x)
      .slice(0, 2);
    if (landmarks.length === 0) {
      this.lastHands = [];
      return null;
    }

    const smoothed = this.smoothHands(landmarks);
    this.lastHands = smoothed;
    return analyzeHands(smoothed);
  }

  smoothHands(hands) {
    return hands.map((landmarks, handIndex) => this.smoothLandmarks(landmarks, this.lastHands[handIndex]));
  }

  smoothLandmarks(landmarks, previousLandmarks) {
    if (!previousLandmarks || previousLandmarks.length !== landmarks.length) {
      return landmarks.map(copyPoint);
    }

    return landmarks.map((point, index) => {
      const previous = previousLandmarks[index];
      return {
        x: point.x * this.smoothing + previous.x * (1 - this.smoothing),
        y: point.y * this.smoothing + previous.y * (1 - this.smoothing),
        z: (point.z ?? 0) * this.smoothing + previous.z * (1 - this.smoothing),
      };
    });
  }
}

async function createHandLandmarker(vision) {
  const options = (delegate) => ({
    baseOptions: {
      modelAssetPath: '/hand_landmarker.task',
      delegate,
    },
    numHands: 2,
    runningMode: 'VIDEO',
  });

  try {
    return await HandLandmarker.createFromOptions(vision, options('GPU'));
  } catch {
    return HandLandmarker.createFromOptions(vision, options('CPU'));
  }
}

function copyPoint(point) {
  return { x: point.x, y: point.y, z: point.z ?? 0 };
}
