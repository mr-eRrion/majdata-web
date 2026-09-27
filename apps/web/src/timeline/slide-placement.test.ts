import { expect, it } from 'vitest';
import { beatToSeconds, rational } from '../../../../packages/chart-core/src/index.js';
import { serializeChart } from '../../../../packages/chart-core/src/serialize.js';
import type { BpmEvent, Chart, Note } from '../../../../packages/chart-core/src/types.js';
import { advanceSlidePlacement, beginSlidePlacement, finishSlidePlacement, rewindSlidePlacement } from './slide-placement.js';

const settings = { head: 'star' as const, slideBreak: false, modifiers: { break: false, ex: false } };

function exportSlide(note: Omit<Note, 'id' | 'order'>, bpms: BpmEvent[], endBeat = rational(4)): string {
  const chart: Chart = {
    difficulty: 1,
    editable: true,
    diagnostics: [],
    notes: [{ ...note, id: 'placed-slide', order: 0 } as Note],
    bpms,
    endBeat,
    sourceRange: { start: 0, end: 0 },
    modified: true,
  };
  return serializeChart(chart);
}

it('defaults to a one-beat wait and takes the endpoint lane on the next click', () => {
  const state = beginSlidePlacement(rational(2), 3, true);
  expect(advanceSlidePlacement(state, rational(2), 7)).toBe(state);
  const complete = advanceSlidePlacement(state, rational(3), 7);

  expect(state.moveBeat).toEqual(rational(3));
  expect(complete).toMatchObject({ hitBeat: rational(2), startPosition: 3, endBeat: rational(3), endPosition: 7 });
});

it('off mode ignores early clicks, uses the middle click time but not its lane, and rewinds by phase', () => {
  const initial = beginSlidePlacement(rational(2), 3, false);
  expect(advanceSlidePlacement(initial, rational(1), 8)).toBe(initial);
  const waiting = advanceSlidePlacement(initial, rational(2), 8);
  expect(waiting).toMatchObject({ moveBeat: rational(2), endBeat: null, endPosition: null });

  const rewound = rewindSlidePlacement(waiting, false);
  expect(rewound).toMatchObject({ moveBeat: null, endBeat: null });
  expect(rewindSlidePlacement(waiting, true)).toBeNull();
  expect(rewindSlidePlacement(initial, false)).toBeNull();
});

it('preserves clicked seconds across a BPM change and fixes Wi-Fi at the opposite lane', () => {
  const bpms: BpmEvent[] = [
    { beat: rational(0), bpm: 120 },
    { beat: rational(2), bpm: 60 },
  ];
  const state = advanceSlidePlacement(
    advanceSlidePlacement(beginSlidePlacement(rational(1), 2, false), rational(2), 8),
    rational(3), 8,
  );
  const note = finishSlidePlacement(state, 'w', settings, bpms);

  expect(note.kind).toBe('slide');
  if (note.kind !== 'slide') throw new Error('expected slide');
  expect(note.slide).toMatchObject({ command: 'w', endPosition: 6 });
  expect(note.slide!.wait).toEqual({ kind: 'beatsAtBpm', bpm: 120, division: 4, beats: 1 });
  expect(note.slide!.move).toEqual({ kind: 'seconds', seconds: 1 });
  expect(beatToSeconds(rational(2), bpms) + 1).toBeCloseTo(beatToSeconds(rational(3), bpms), 12);
  expect(exportSlide(note, bpms)).toContain('2w6[120#1]');
});

it('serializes a selected two-beat wait as seconds while preserving the beat-based move', () => {
  const bpms: BpmEvent[] = [{ beat: rational(0), bpm: 120 }];
  const state = advanceSlidePlacement(
    advanceSlidePlacement(beginSlidePlacement(rational(0), 1, false), rational(2), 8),
    rational(3), 5,
  );
  const note = finishSlidePlacement(state, '-', settings, bpms);

  expect(note.kind).toBe('slide');
  if (note.kind !== 'slide') throw new Error('expected slide');
  expect(note.slide!.wait).toEqual({ kind: 'seconds', seconds: 1 });
  expect(note.slide!.move).toEqual({ kind: 'beatsAtStartBpm', division: 4, beats: 1 });
  expect(exportSlide(note, bpms)).toContain('1-5[1##4:1]');
});

it('accepts zero wait and zero move endpoints', () => {
  const initial = beginSlidePlacement(rational(2), 3, false);
  const complete = advanceSlidePlacement(advanceSlidePlacement(initial, rational(2), 7), rational(2), 7);
  const note = finishSlidePlacement(complete, '-', settings, [{ beat: rational(0), bpm: 120 }]);

  expect(note.kind).toBe('slide');
  if (note.kind !== 'slide') throw new Error('expected slide');
  expect(note.slide!.wait).toEqual({ kind: 'seconds', seconds: 0 });
  expect(note.slide!.move).toEqual({ kind: 'beatsAtStartBpm', division: 4, beats: 0 });
});
