import parameters from './parameters.json';

/** The editor marker is separate from the gameplay hit animation. */
export function drawTouchFireworkMarker(
  context: CanvasRenderingContext2D,
  images: Map<string, HTMLImageElement>,
  x: number,
  y: number,
  glyphSize: number,
  kind: 'touch' | 'touchHold',
  variant: 'timeline' | 'pointer',
  opacity = 1,
): void {
  const image = images.get('touch.firework');
  if (!image) return;
  const placement = parameters.touchFirework.placements[variant];
  const marker = placement.image;
  const scale = glyphSize / placement.glyphSizes[kind][0];
  const width = marker.size[0] * scale;
  const height = marker.size[1] * scale;
  context.save();
  context.globalAlpha *= marker.color[3] * opacity;
  context.drawImage(image,
    x + marker.anchoredPosition[0] * scale - marker.pivot[0] * width,
    y - marker.anchoredPosition[1] * scale - (1 - marker.pivot[1]) * height,
    width, height);
  context.restore();
}
