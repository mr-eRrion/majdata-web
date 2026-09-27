import { expect, test } from 'vitest';
import { rational, rationalKey, compareRational } from '../../../../packages/chart-core/src/rational';
import { checkVisualChart } from './visual-checker';
import type { VisualCheckNote } from './types';

// Compare the optimized overlap search with the source's three distinct branch loops.
test('Slide triple results match an independent exhaustive search, including zero durations', () => {
  let random = 1729;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  for (let trial = 0; trial < 80; trial++) {
    const spans = Array.from({ length: 9 }, () => {
      const start = next() % 8;
      return [start, start + next() % 5];
    });
    const notes: VisualCheckNote[] = spans.map(([start, end], index) => ({
      id: String(index), kind: 'slide', position: 1, hit: rational(0), end: rational(0), ex: false, head: false,
      paths: [{ start: rational(start), end: rational(end), segments: [{ command: 'w', startPosition: 1, endPosition: 5 }] }],
    }));
    const expected = new Set<number>();
    const overlap = (a: number, b: number) => spans[a][0] < spans[b][1] && spans[b][0] < spans[a][1];
    for (let a = 0; a < spans.length; a++) for (let b = a + 1; b < spans.length; b++) for (let c = b + 1; c < spans.length; c++) {
      if (overlap(a, b) && overlap(b, c) && overlap(c, a)) expected.add(Math.max(spans[a][0], spans[b][0], spans[c][0]));
    }
    const actual = checkVisualChart(notes, [{ beat: rational(0), bpm: 120 }]).filter((result) => result.code === 3);
    expect(actual.map((result) => rationalKey(result.beat))).toEqual([...expected].map((beat) => rational(beat)).sort(compareRational).map(rationalKey));
  }
});
