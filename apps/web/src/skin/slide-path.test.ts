import { expect, it } from 'vitest';
import { lineSegmentsAtProgress, pointAtProgress, resolvePath, samplePathAtProgress, slideFrame, wifiStarPositions } from './slide-path.js';

it('swaps < and > for start buttons 3 through 6', () => {
  const path = resolvePath('<', 3, 6);
  expect(path.command).toBe('>');
  expect(path.id).toBe(1264);
  expect(() => resolvePath('V', 3, 6, 5)).toThrow(/Unsupported slide path command/);
});

it('resolves the serialized v, s, and z paths and rejects absent endpoint distances', () => {
  const vPaths = [[1, 1246], [2, 1247], [3, 1248], [5, 1249], [6, 1250], [7, 1251]] as const;

  for (const [distance, id] of vPaths) {
    const path = resolvePath('v', 1, distance + 1);
    expect(path.id).toBe(id);
    expect(path.command).toBe('v');
    expect(path.points).toHaveLength(41);
    expect(path.splitIndexes).toEqual([20]);
    expect(pointAtProgress(path, 0).x).toBeCloseTo(path.points.at(-1)![0], 10);
    expect(pointAtProgress(path, 0).y).toBeCloseTo(path.points.at(-1)![1], 10);
    expect(pointAtProgress(path, 1).x).toBeCloseTo(path.points[0][0], 10);
    expect(pointAtProgress(path, 1).y).toBeCloseTo(path.points[0][1], 10);
  }

  for (const [command, id] of [['s', 1245], ['z', 1252]] as const) {
    const path = resolvePath(command, 1, 5);
    expect(path.id).toBe(id);
    expect(path.command).toBe(command);
    expect(path.points).toHaveLength(61);
    expect(path.splitIndexes).toEqual([20, 40]);
    expect(resolvePath(command, 4, 8).id).toBe(id);
  }

  expect(() => resolvePath('v', 1, 5)).toThrow(/No serialized v path/);
  expect(() => resolvePath('v', 1, 1)).toThrow(/No serialized v path/);
  expect(() => resolvePath('s', 1, 4)).toThrow(/No serialized s path/);
  expect(() => resolvePath('z', 1, 4)).toThrow(/No serialized z path/);
});

it('keeps each v/s/z LineRenderer slice attached to its serialized split points', () => {
  const cases = [
    { path: resolvePath('v', 1, 2), ranges: [[0, 20], [20, 40]] },
    { path: resolvePath('s', 1, 5), ranges: [[0, 20], [20, 40], [40, 60]] },
    { path: resolvePath('z', 1, 5), ranges: [[0, 20], [20, 40], [40, 60]] },
  ] as const;

  for (const { path, ranges } of cases) {
    const segments = lineSegmentsAtProgress(path, 0);
    expect(segments.map(({ sourceStartIndex, sourceEndIndex }) => [sourceStartIndex, sourceEndIndex]))
      .toEqual(ranges);
    for (const [index, segment] of segments.entries()) {
      expect(segment.rendererIndex).toBe(index);
      expect(segment.points[0]).toEqual(path.points[segment.sourceStartIndex]);
      expect(segment.points).toHaveLength(segment.sourceEndIndex - segment.sourceStartIndex + 1);
    }
  }
});

it('reverses source points, rotates by the start lane, and samples progress by arc length', () => {
  const path = resolvePath('-', 2, 4);
  const initial = samplePathAtProgress(path, 0);
  const start = pointAtProgress(path, 0);
  const end = pointAtProgress(path, 1);
  const [lastX, lastY] = path.points[path.points.length - 1];
  const rootAngle = path.rotation * Math.PI / 180;

  expect(path.rotation).toBe(-45);
  expect(initial.point.x).toBeCloseTo(Math.cos(rootAngle) * lastX - Math.sin(rootAngle) * lastY, 10);
  expect(initial.point.y).toBeCloseTo(Math.sin(rootAngle) * lastX + Math.cos(rootAngle) * lastY, 10);
  expect(initial.point.rotation).toBe(path.rotation);
  expect(initial.lastPointIndex).toBe(path.points.length - 1);
  expect(start).toEqual(initial.point);
  expect(start.x).toBeCloseTo(4.433, 2);
  expect(start.y).toBeCloseTo(1.837, 2);
  expect(end.x).toBeCloseTo(1.8365, 3);
  expect(end.y).toBeCloseTo(-4.4337, 3);
  expect(pointAtProgress(path, 2)).toEqual(end);
});

it('restores fade, reveal, and movement state at boundaries and after a seek', () => {
  const beforeVisible = slideFrame(0.2, 1.2, 3.2, 0);
  const fade = slideFrame(0.2, 1.2, 3.2, 0.1);
  const reveal = slideFrame(0.2, 1.2, 3.2, 0.7);
  const sought = slideFrame(0.2, 1.2, 3.2, 2.2);
  const ended = slideFrame(0.2, 1.2, 3.2, 3.2);

  expect(beforeVisible.visible).toBe(false);
  expect(fade.visible).toBe(true);
  expect(fade.alpha).toBeCloseTo(0.5, 8);
  expect(fade.starVisible).toBe(false);
  expect(reveal.starVisible).toBe(true);
  expect(reveal.starAlpha).toBeCloseTo(0.5, 8);
  expect(reveal.starScale).toBeCloseTo(0.7, 8);
  expect(reveal.progress).toBe(0);
  expect(sought.progress).toBeCloseTo(0.5, 8);
  expect(ended.visible).toBe(false);
});

it('keeps a zero-wait, zero-move slide valid until its end boundary', () => {
  const waiting = slideFrame(1, 1, 1, 0.9);
  const ended = slideFrame(1, 1, 1, 1);

  expect(waiting.visible).toBe(true);
  expect(waiting.progress).toBe(0);
  expect(waiting.starAlpha).toBe(0);
  expect(ended.visible).toBe(false);
  expect(ended.progress).toBe(0);
});

it('snaps each rendered path segment to the source even 0.5-unit length', () => {
  const makePath = (length: number) => ({
    id: 0, command: '-' as const, distance: 1, rotation: 0, name: 'test',
    points: [[0, 0], [length, 0]] as [number, number][], splitIndexes: [], length,
  });
  const quarter = makePath(0.25);
  const threeQuarter = makePath(0.75);
  const originalQuarter = structuredClone(quarter.points);

  expect(lineSegmentsAtProgress(quarter, 0)[0].points).toEqual([[0, 0], [0, 0]]);
  expect(lineSegmentsAtProgress(threeQuarter, 0)[0].points).toEqual([[0, 0], [1, 0]]);
  expect(quarter.points).toEqual(originalQuarter);
});

it('places the three Wi-Fi stars along their serialized track pairs', () => {
  const starts = wifiStarPositions(0, 1);
  const ends = wifiStarPositions(1, 1);
  expect(starts).toHaveLength(3);
  for (const point of starts) {
    expect(point.x).toBeCloseTo(1.8338, 3);
    expect(point.y).toBeCloseTo(4.4272, 3);
  }
  expect(ends[0].x).toBeCloseTo(1.8338, 3);
  expect(ends[0].y).toBeCloseTo(-4.4272, 3);
});
