export function analyzeHands(handLandmarks, limit = 2) {
  return handLandmarks
    .filter((landmarks) => Array.isArray(landmarks) && landmarks.length >= 21)
    .sort((a, b) => a[0].x - b[0].x)
    .slice(0, limit)
    .map(analyzeHand);
}

export function analyzeHand(landmarks) {
  const thumb = landmarks[4];
  const index = landmarks[8];
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  const handSize = Math.max(0.001, distance(wrist, middleMcp));
  const pinchDistance = distance(thumb, index) / handSize;
  const pinchCenter = {
    x: (thumb.x + index.x) * 0.5,
    y: (thumb.y + index.y) * 0.5,
  };

  return {
    landmarks,
    pinchCenter,
    pinchDistance,
    confidence: Math.max(0, Math.min(1, 1 - pinchDistance / 0.75)),
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
