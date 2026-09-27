import { expect, it } from 'vitest';
import { slideMesh } from './slide-mesh.js';
import { lineSegmentsAtProgress, resolvePath } from './slide-path.js';

it('keeps scene width and repeats the original arrow every half world unit', () => {
  const mesh = slideMesh([{ x: 0, y: 0 }, { x: 1, y: 0 }], 0.9, [2, 1], [0, 0]);
  expect(mesh.positions[1]).toBeCloseTo(-0.45);
  expect(mesh.positions[3]).toBeCloseTo(0.45);
  expect([...mesh.uvs]).toEqual([0, 0, 0, 1, 2, 0, 2, 1]);
  expect([...mesh.indices]).toEqual([0, 1, 2, 1, 3, 2]);
});

it('joins a bend at the width boundary and ignores a collapsed normalized tail', () => {
  const mesh = slideMesh([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }], 1, [2, 1], [0, 0]);
  expect([...mesh.positions.slice(4, 8)]).toEqual([1.5, -0.5, 0.5, 0.5]);
  expect(mesh.indices.length).toBe(12);
  expect([...mesh.uvs.slice(-4)]).toEqual([4, 0, 4, 1]);
});

it.each([1, -1])('bevels the source arc tail reversal (Y sign %i) while preserving tiled distance', (sign) => {
  // Dense connected-route screenshot: lane 6 -> 8 at 3.801s, after source half-unit tail snapping.
  const path = resolvePath('<', 6, 8);
  const strip = lineSegmentsAtProgress(path, 0.582106)[0];
  const points = strip.points.map(([x, y]) => ({ x, y: y * sign }));
  const mesh = slideMesh(points, 0.9, [2, 1], [0, 0]);
  const radius = Math.max(...points.map(point => Math.hypot(point.x, point.y)));
  for (let i = 0; i < mesh.positions.length; i += 2)
    expect(Math.hypot(mesh.positions[i], mesh.positions[i + 1])).toBeLessThan(radius + 1.81);
  // One beveled corner adds an incoming/outgoing pair and an outer fill triangle.
  expect(mesh.indices.length).toBe((points.length - 1) * 6 + 3);
  const length = points.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
  expect(mesh.uvs.at(-2)).toBeCloseTo(length * 2, 5);
});
