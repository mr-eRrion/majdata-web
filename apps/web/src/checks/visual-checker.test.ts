import { describe, expect, it } from 'vitest';
import { rational } from '../../../../packages/chart-core/src/rational.js';
import type { BpmEvent, Rational } from '../../../../packages/chart-core/src/types.js';
import { checkVisualChart } from './visual-checker.js';
import type { VisualCheckNote, VisualCheckPath } from './types.js';

const bpms: BpmEvent[] = [{ beat: rational(0), bpm: 120 }];
const beat = (numerator: number, denominator = 1): Rational => rational(numerator, denominator);

function note(
  id: string,
  kind: VisualCheckNote['kind'],
  hit: Rational,
  position: number,
  patch: Partial<VisualCheckNote> = {},
): VisualCheckNote {
  return { id, kind, position, hit, end: hit, ex: false, head: true, paths: [], ...patch };
}

function slidePath(
  start: Rational,
  end: Rational,
  segments: VisualCheckPath['segments'],
): VisualCheckPath {
  return { start, end, segments };
}

function wifi(start: number, end: number, button = 1): VisualCheckPath {
  const opposite = ((button + 3) % 8) + 1;
  return slidePath(beat(start), beat(end), [{ command: 'w', startPosition: button, endPosition: opposite }]);
}

function codes(results: ReturnType<typeof checkVisualChart>): [number, number, string][] {
  return results.map(({ beat: at, code, severity }) => [at.numerator / at.denominator, code, severity]);
}

describe('checkVisualChart', () => {
  it('matches multi-note and slide-branch count codes, including headless branch coverage', () => {
    expect(codes(checkVisualChart([
      note('a', 'tap', beat(0), 1), note('b', 'tap', beat(0), 3), note('c', 'tap', beat(0), 5),
    ], bpms))).toEqual([[0, 0, 'bad']]);

    const wifiSlide = note('wifi', 'slide', beat(0), 1, { paths: [wifi(0, 4)] });
    expect(codes(checkVisualChart([wifiSlide, note('tap', 'tap', beat(2), 3)], bpms)))
      .toEqual([[2, 2, 'warning']]);
    expect(codes(checkVisualChart([
      wifiSlide, note('tap-a', 'tap', beat(2), 3), note('tap-b', 'tap', beat(2), 6),
    ], bpms))).toEqual([[2, 1, 'bad']]);

    const hiddenWifi = note('hidden', 'slide', beat(0), 1, { head: false, paths: [wifi(0, 4)] });
    expect(codes(checkVisualChart([hiddenWifi, note('tap', 'tap', beat(2), 3)], bpms)))
      .toEqual([[2, 2, 'warning']]);
  });

  it('preserves pairwise strict Slide coverage, including a zero-duration path inside two longer paths', () => {
    const path = (id: string, start: number, end: number) => note(id, 'slide', beat(0), Number(id.at(-1)), {
      head: false,
      paths: [slidePath(beat(start), beat(end), [{ command: '-', startPosition: 1, endPosition: 3 }])],
    });
    const results = checkVisualChart([path('slide-1', 1, 1), path('slide-2', 0, 2), path('slide-3', 0, 2)], bpms);
    expect(codes(results)).toEqual([[1, 3, 'warning']]);
  });

  it('keeps the source conditional headless continue and IgnoreEnd endpoint rule', () => {
    const hidden = note('hidden', 'slide', beat(0), 1, { head: false, paths: [wifi(0, 2)] });
    // A Tap sharing this hidden head's beat/lane sets array[current]; the source then
    // does not execute its inner headless-slide continue and emits code 7.
    expect(codes(checkVisualChart([hidden, note('tap', 'tap', beat(0), 1)], bpms)))
      .toEqual([[0, 7, 'bad']]);

    const first = note('first', 'slide', beat(0), 1, {
      paths: [slidePath(beat(0), beat(2), [{ command: '-', startPosition: 1, endPosition: 3 }])],
    });
    const second = note('second', 'slide', beat(1), 3, {
      paths: [slidePath(beat(2), beat(3), [{ command: '-', startPosition: 3, endPosition: 5 }])],
    });
    const endpointTap = note('endpoint', 'tap', beat(2), 7);
    expect(codes(checkVisualChart([first, second, endpointTap], bpms))).toEqual([]);
  });

  it('reports A-touch overlap and same-lane hold overlap at the current note beat', () => {
    const results = checkVisualChart([
      note('hold', 'hold', beat(0), 2, { end: beat(3) }),
      note('tap', 'tap', beat(1), 2),
      note('touch-hold', 'touchHold', beat(0), 2, { touchArea: 'A', end: beat(2) }),
    ], bpms);
    expect(codes(results)).toEqual([[0, 8, 'bad'], [1, 7, 'bad'], [1, 8, 'bad']]);
  });

  it('matches severe, EX, mild, and Wi-Fi splash timing with Visual Float32 event times', () => {
    const onePath = (id: string) => note(id, 'slide', beat(0), 1, {
      paths: [slidePath(beat(0), beat(4), [{ command: '-', startPosition: 1, endPosition: 3 }])],
    });
    expect(codes(checkVisualChart([
      onePath('slide'), note('severe', 'tap', beat(5, 4), 2),
    ], bpms))).toEqual([[1.25, 5, 'bad']]);
    expect(codes(checkVisualChart([
      onePath('slide'), note('ex-severe', 'tap', beat(5, 4), 2, { ex: true }),
    ], bpms))).toEqual([[1.25, 6, 'warning']]);
    expect(codes(checkVisualChart([
      onePath('slide'), note('mild', 'tap', beat(3, 2), 2),
    ], bpms))).toEqual([[1.5, 4, 'warning']]);
    expect(codes(checkVisualChart([
      onePath('slide'), note('ex-mild', 'tap', beat(3, 2), 2, { ex: true }),
    ], bpms))).toEqual([]);

    const wifiSlide = note('wifi', 'slide', beat(0), 1, { paths: [wifi(0, 4)] });
    expect(codes(checkVisualChart([wifiSlide, note('wifi-severe', 'tap', beat(7, 2), 4)], bpms)))
      .toEqual([[3.5, 2, 'warning'], [3.5, 5, 'bad']]);
  });

  it('uses each connected fragment start lane for its own enter-area events', () => {
    const connected = note('connected', 'slide', beat(0), 1, {
      paths: [slidePath(beat(0), beat(4), [
        { command: '-', startPosition: 1, endPosition: 3 },
        { command: '-', startPosition: 3, endPosition: 5 },
      ])],
    });
    // The second segment starts on lane 3; its source area 2 maps to ring lane 4.
    // At beat 3 the event is within the mild .2s range but outside the severe .12s range.
    expect(codes(checkVisualChart([connected, note('second-leg', 'tap', beat(3), 4)], bpms)))
      .toEqual([[3, 4, 'warning']]);
  });
});
