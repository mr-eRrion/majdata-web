import { describe, expect, it } from 'vitest';
import {
  beatToSeconds,
  bpmAtBeat,
  compile,
  holdDurationSeconds,
  queryVisible,
  rational,
  rationalFromNumber,
  rationalToNumber,
  mergeBpmEvents,
  secondsToBeat,
  addRational,
} from '../src/index.js';
import type { Chart } from '../src/types.js';

describe('chart timing primitives', () => {
  it('keeps exact beat fractions bounded and round-trips finite decimals', () => {
    expect(rational(2, 4)).toEqual({ numerator: 1, denominator: 2 });
    expect(addRational(rational(1, 3), rational(1, 6))).toEqual({ numerator: 1, denominator: 2 });
    expect(rationalFromNumber(0.125)).toEqual({ numerator: 1, denominator: 8 });
    expect(rationalToNumber(rational(5, 8))).toBe(0.625);
    expect(rational(1, Number.MAX_SAFE_INTEGER).denominator).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => rational(1, Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
  });

  it('integrates BPM changes and computes Holds using their specified timing basis', () => {
    const bpms = [
      { beat: rational(0), bpm: 120 },
      { beat: rational(1), bpm: 240 },
    ];
    expect(beatToSeconds(rational(3), bpms)).toBe(1);
    expect(secondsToBeat(0.75, bpms)).toBe(2);
    expect(bpmAtBeat(rational(1), bpms)).toBe(240);
    expect(holdDurationSeconds({ kind: 'beatsAtStartBpm', division: 4, beats: 4 }, 120)).toBe(2);
    expect(holdDurationSeconds({ kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 4 }, 120)).toBe(1);
    expect(holdDurationSeconds({ kind: 'seconds', seconds: 0.25 }, 120)).toBe(0.25);
    expect(holdDurationSeconds({ kind: 'short' }, 120)).toBe(0);
  });

  it('replaces same-beat BPMs deterministically and preserves untouched events', () => {
    const bpms = [
      { beat: rational(0), bpm: 120 },
      { beat: rational(2), bpm: 180 },
      { beat: rational(6), bpm: 240 },
    ];
    expect(mergeBpmEvents(bpms, [
      { beat: rational(2), bpm: 200 },
      { beat: rational(2, 1), bpm: 210 },
      { beat: rational(8), bpm: 300 },
    ])).toEqual([
      { beat: rational(0), bpm: 120 },
      { beat: rational(2), bpm: 210 },
      { beat: rational(6), bpm: 240 },
      { beat: rational(8), bpm: 300 },
    ]);
    expect(bpms[1].bpm).toBe(180);
  });

  it('sorts display notes and retains a long interval that began before the visible window', () => {
    const chart: Chart = {
      difficulty: 1,
      editable: true,
      diagnostics: [],
      notes: [
        { id: 'long', kind: 'hold', beat: rational(0), position: 1, order: 0, duration: { kind: 'seconds', seconds: 3 }, modifiers: { break: false, ex: false } },
        { id: 'tap', kind: 'tap', beat: rational(2), position: 2, order: 1, modifiers: { break: false, ex: false } },
      ],
      bpms: [{ beat: rational(0), bpm: 120 }],
      endBeat: rational(4),
      sourceRange: { start: 0, end: 0 },
      modified: false,
    };
    const compiled = compile(chart);
    expect(queryVisible(compiled, 2, 2.1).map((note) => note.id)).toEqual(['long']);
    expect(queryVisible(compiled, 1, 1).map((note) => note.id)).toEqual(['long', 'tap']);
    expect(compiled.notes.map((note) => note.isEach)).toEqual([false, false]);
    // Overlapping durations do not count as each; equal hit beats across families do.
    chart.notes.push({ id: 'touch', kind: 'touch', beat: rational(4, 2), position: 0,
      touchArea: 'C', order: 2, modifiers: { break: false, ex: false } });
    expect(compile(chart).notes.map((note) => note.isEach)).toEqual([false, true, true]);
    chart.notes.pop();
    expect(compile(chart).notes.map((note) => note.isEach)).toEqual([false, false]);
  });
});
