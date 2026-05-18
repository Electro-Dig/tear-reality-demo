export function assignLayerImages(images, layerCount = 3) {
  if (!Array.isArray(images) || images.length === 0 || layerCount <= 0) return [];
  const limited = images.slice(0, layerCount);
  while (limited.length < layerCount) {
    limited.push(limited[limited.length - 1]);
  }
  return limited;
}
