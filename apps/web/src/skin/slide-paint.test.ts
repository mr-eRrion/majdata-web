import { expect, it } from 'vitest';
import slideMatchPaths from './slide-match-paths.json';
import { selectSlideFromPath } from './slide-paint.js';

const source = slideMatchPaths as unknown as { paths: { id: number; points: readonly (readonly [number, number, number])[] }[] };
const pathsById = new Map(source.paths.map((path) => [path.id, path]));

function drawPath(pathId: number, start: number): readonly (readonly [number, number])[] {
  const angle = -(start - 1) * Math.PI / 4;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [...pathsById.get(pathId)!.points].reverse().map(([x, y]) => [cosine * x - sine * y, sine * x + cosine * y] as const);
}

it('rotates the hand path to source coordinates and returns the source-swapped command', () => {
  const match = selectSlideFromPath(drawPath(1255, 4), 4, 6);
  const centerPath = selectSlideFromPath(drawPath(1209, 4), 4, 5);

  expect(match).toMatchObject({ command: '>', start: 4, end: 6, supported: true, pathId: 1255 });
  expect(centerPath).toMatchObject({ command: 'V', middle: 2, supported: false, pathId: 1209 });
});

it('keeps unsupported nearest candidates instead of falling back to a supported path', () => {
  const match = selectSlideFromPath(drawPath(1216, 1), 1, 4);

  expect(match).toMatchObject({ command: 'p', start: 1, end: 4, supported: false, pathId: 1216 });
});

it('chooses the last source candidate when the averaged scores tie', () => {
  const match = selectSlideFromPath([[1e20, 1e20], [1e20, 1e20]], 1, 1);

  expect(match).toMatchObject({ command: 'qq', supported: false, pathId: 1237, sourceOrder: 65 });
});
