import type { WarningMarker } from '../checks/warning-markers';

export const WARNING_TRACK_WIDTH = 40;
export const WARNING_ICON_SIZE = 42;

export interface VisibleWarning {
  marker: WarningMarker;
  x: number;
  y: number;
}

export function drawWarningTrack(context: CanvasRenderingContext2D, markers: readonly WarningMarker[],
  images: ReadonlyMap<string, HTMLImageElement> | null,
  view: { viewSeconds: number; pixelsPerSecond: number },
  geometry: { gridLeft: number; gridTop: number; gridBottom: number; playheadY: number },
): VisibleWarning[] {
  const x = geometry.gridLeft - WARNING_TRACK_WIDTH / 2;
  const visible: VisibleWarning[] = [];
  context.save();
  context.beginPath();
  context.rect(x - WARNING_ICON_SIZE / 2, geometry.gridTop, WARNING_ICON_SIZE, geometry.gridBottom - geometry.gridTop);
  context.clip();
  for (const marker of markers) {
    const y = geometry.playheadY - (marker.seconds - view.viewSeconds) * view.pixelsPerSecond;
    // Source culls by marker center, not by the image's edge.
    if (y < geometry.gridTop || y > geometry.gridBottom) continue;
    const icon = images?.get(`check.${marker.severity}`);
    if (!icon) continue;
    context.drawImage(icon, x - WARNING_ICON_SIZE / 2, y - WARNING_ICON_SIZE / 2, WARNING_ICON_SIZE, WARNING_ICON_SIZE);
    visible.push({ marker, x, y });
  }
  context.restore();
  return visible;
}

export function hitWarning(markers: readonly VisibleWarning[], x: number, y: number): VisibleWarning | null {
  // Last drawn marker receives hover when neighboring times overlap.
  for (let index = markers.length - 1; index >= 0; index--) {
    const marker = markers[index];
    if (Math.abs(x - marker.x) <= WARNING_ICON_SIZE / 2 && Math.abs(y - marker.y) <= WARNING_ICON_SIZE / 2) return marker;
  }
  return null;
}
