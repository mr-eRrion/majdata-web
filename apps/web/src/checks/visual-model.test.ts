import { expect, it } from 'vitest';
import { compileNote } from '../../../../packages/chart-core/src/compile.js';
import { rational, rationalFromNumber } from '../../../../packages/chart-core/src/rational.js';
import { serializeChart } from '../../../../packages/chart-core/src/serialize.js';
import type { BpmEvent, Chart, DisplayNote, Note } from '../../../../packages/chart-core/src/types.js';
import { toVisualCheckNotes, visualBeatToSeconds } from './visual-model.js';

const bpm120: BpmEvent[] = [{ beat: rational(0), bpm: 120 }];

function note(id: string, kind: Note['kind'], beat: number, fields: Partial<Note> = {}): Note {
  return {
    id, kind, beat: rationalFromNumber(beat), position: 2, order: 0,
    modifiers: { break: false, ex: false }, ...fields,
  };
}

function chart(notes: Note[], bpms = bpm120, endBeat = 8): Chart {
  return { difficulty: 1, editable: true, diagnostics: [], notes, bpms, endBeat: rational(endBeat),
    sourceRange: { start: 0, end: 0 }, modified: false };
}

function displayed(notes: Note[], bpms = bpm120): DisplayNote[] {
  return notes.map((item) => compileNote(item, bpms));
}

it('maps exported Hold forms through Visual integer TimeData, including seconds truncation', () => {
  const notes = [
    note('tap', 'tap', 3),
    note('hold-seconds', 'hold', 1, { duration: { kind: 'seconds', seconds: 0.333 } }),
    note('touch-hold', 'touchHold', 2, { touchArea: 'C', position: 0,
      duration: { kind: 'beatsAtStartBpm', division: 4, beats: 3 } }),
  ];
  const source = serializeChart(chart(notes));
  expect(source).toContain('2h[#0.333]');
  expect(source).toContain('Ch[4:3]');

  const result = toVisualCheckNotes({ notes: displayed(notes), bpms: bpm120 });
  expect(result.find((item) => item.id === 'tap')?.end).toEqual(rational(3));
  // Visual truncates (0.333f * 10f * 120f / 6f) to 66, then stores [400:66].
  expect(result.find((item) => item.id === 'hold-seconds')?.end).toEqual(rational(83, 50));
  expect(result.find((item) => item.id === 'touch-hold')?.end).toEqual(rational(5));
});

it('converts the serializer BPM slide form into the importer TimeData beats', () => {
  const slide = note('slide', 'slide', 0, { position: 1, slide: {
    command: '-', endPosition: 3, head: 'star', slideBreak: false,
    wait: { kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 },
    move: { kind: 'beatsAtBpm', bpm: 240, division: 8, beats: 1 },
  } });
  expect(serializeChart(chart([slide]))).toContain('1-3[240#8:1]');

  const result = toVisualCheckNotes({ notes: displayed([slide]), bpms: bpm120 })[0];
  expect(result.hit).toEqual(rational(0));
  expect(result.end).toEqual(result.hit);
  expect(result.paths).toHaveLength(1);
  expect(result.paths[0]).toMatchObject({ start: rational(1, 2), end: rational(3, 4) });

  const bpmHold = note('bpm-hold', 'hold', 0, { duration: { kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 } });
  expect(serializeChart(chart([bpmHold]))).toContain('2h[240#4:1]');
  expect(() => toVisualCheckNotes({ notes: displayed([bpmHold]), bpms: bpm120 }))
    .toThrow(/指定 BPM 的长按时长无法由目标导入器解析/);
});

it('retains shared heads, continuous segments, and headless Slides with branch-local time', () => {
  const slide = note('headless', 'slide', 0.5, { position: 2, slide: {
    command: '-', endPosition: 4, head: 'none', slideBreak: false,
    wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
    move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
    continuations: [{ command: '<', endPosition: 6 }],
    additionalPaths: [{
      command: '>', endPosition: 7, slideBreak: true,
      wait: { kind: 'seconds', seconds: 0.25 }, move: { kind: 'seconds', seconds: 0.5 },
    }],
  } });
  const source = serializeChart(chart([slide]));
  expect(source).toContain('2!-4<6[4:2]*>7b[0.25##0.5]');

  const result = toVisualCheckNotes({ notes: displayed([slide]), bpms: bpm120 })[0];
  expect(result.head).toBe(false);
  expect(result.paths).toHaveLength(2);
  expect(result.paths[0]).toMatchObject({ start: rational(3, 2), end: rational(7, 2), segments: [
    { command: '-', startPosition: 2, endPosition: 4 },
    { command: '<', startPosition: 4, endPosition: 6 },
  ] });
  expect(result.paths[1]).toMatchObject({ start: rational(1), end: rational(2), segments: [
    { command: '>', startPosition: 2, endPosition: 7 },
  ] });
});

it('uses BpmData float32 piecewise time across BPM changes and rejects importer-invalid descriptors', () => {
  const bpms: BpmEvent[] = [
    { beat: rational(0), bpm: 120 },
    { beat: rational(1), bpm: 240 },
  ];
  expect(visualBeatToSeconds(rational(3), bpms)).toBe(1);

  const badTouchHold = note('bad-touch-hold', 'touchHold', 0, { touchArea: 'A',
    duration: { kind: 'seconds', seconds: 0.5 } });
  expect(() => toVisualCheckNotes({ notes: displayed([badTouchHold]), bpms: bpm120 }))
    .toThrow(/触摸长按的秒数时长无法由目标格式解析/);
  const unparsedSlide = note('bad-slide', 'slide', 0, { position: 1, slide: {
    command: '-', endPosition: 3, head: 'star', slideBreak: false,
    wait: { kind: 'seconds', seconds: 0.25 },
    move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
  } });
  expect(() => toVisualCheckNotes({ notes: displayed([unparsedSlide]), bpms: bpm120 }))
    .toThrow(/滑条等待时长使用秒、移动时长使用拍的组合无法由目标格式解析/);
});
