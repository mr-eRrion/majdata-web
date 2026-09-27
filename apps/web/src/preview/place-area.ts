import parameters from '../skin/parameters.json';
import { ringRadius } from '../skin/composition.js';

export interface PlaceArea {
  key: string;
  position: readonly number[];
}

export function previewTransform(width: number, height: number) {
  return { x: width / 2, y: height / 2 + 4, scale: Math.min(width, height) * 0.36 / ringRadius };
}

/** Source serialized order matters: the last equidistant center wins. */
export function nearestPlaceArea(x: number, y: number, areas: readonly PlaceArea[] = parameters.notePlaceArea.positions): PlaceArea | null {
  if (Math.hypot(x, y) > parameters.notePlaceArea.radius) return null;
  let closest: PlaceArea | null = null;
  let distance = Infinity;
  for (const area of areas) {
    const next = Math.hypot(x - area.position[0], y - area.position[1]);
    if (next <= distance) { closest = area; distance = next; }
  }
  return closest;
}
