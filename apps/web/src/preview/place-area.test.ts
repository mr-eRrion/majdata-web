import { describe, expect, it } from 'vitest';
import parameters from '../skin/parameters.json';
import { nearestPlaceArea, previewTransform } from './place-area.js';

describe('source NotePlaceArea geometry', () => {
  it('keeps all 41 serialized centers distinct, including outer ring versus Touch A', () => {
    expect(parameters.notePlaceArea.positions).toHaveLength(41);
    for (const area of parameters.notePlaceArea.positions) {
      expect(nearestPlaceArea(area.position[0], area.position[1])?.key).toBe(area.key);
    }
    expect(nearestPlaceArea(0, 0)?.key).toBe('C');
    expect(nearestPlaceArea(0, 5.5)).not.toBeNull();
    expect(nearestPlaceArea(0, 5.50001)).toBeNull();
    expect(nearestPlaceArea(4, 4)).toBeNull();
  });

  it('uses the later serialized entry on a tie', () => {
    expect(nearestPlaceArea(0, 0, [
      { key: '2', position: [-1, 0] }, { key: '1', position: [1, 0] },
    ])?.key).toBe('1');
  });

  it('keeps placement aligned with the rendered world when the view is rectangular', () => {
    const wide = previewTransform(800, 400);
    const tall = previewTransform(400, 800);
    expect(wide.scale).toBe(tall.scale);
    expect(wide.x).toBe(400);
    expect(wide.y).toBe(204);
    expect(tall.x).toBe(200);
    expect(tall.y).toBe(404);
  });
});
