import { expect, it } from 'vitest';
import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { buildChartCues } from './chart-cues.js';

const makeNote = (overrides: Partial<DisplayNote> = {}): DisplayNote => ({
  id: 'note-1', kind: 'tap', beat: { numerator: 0, denominator: 1 }, position: 1, order: 0,
  modifiers: { break: false, ex: false },
  startSeconds: 1, endSeconds: 1, bpm: 120,
  ...overrides,
});

const makeSlide = (overrides: Partial<DisplayNote> = {}): DisplayNote => makeNote({
  kind: 'slide',
  slide: {
    command: '-', endPosition: 3, head: 'star', slideBreak: false,
    wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
  },
  startSeconds: 1, moveStartSeconds: 1.5, endSeconds: 2.5,
  ...overrides,
});

it('preserves ordinary hit cues and separates head break from path break', () => {
  const headBreak = makeSlide({ id: 'head-break', modifiers: { break: true, ex: false } });
  const pathBreak = makeSlide({
    id: 'path-break',
    startSeconds: 3,
    moveStartSeconds: 3.5,
    endSeconds: 4,
    slide: {
      command: '-', endPosition: 3, head: 'tap', slideBreak: true,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 0.5 },
    },
  });

  expect(buildChartCues([
    makeNote({ id: 'tap', startSeconds: 0.25 }),
    makeNote({ id: 'break', kind: 'hold', startSeconds: 0.5, modifiers: { break: true, ex: false } }),
    headBreak,
    pathBreak,
  ])).toEqual([
    { id: 'tap:hit', chartSeconds: 0.25, frequencyHz: 880 },
    { id: 'break:hit', chartSeconds: 0.5, frequencyHz: 1320 },
    { id: 'head-break:head', chartSeconds: 1, frequencyHz: 1320 },
    { id: 'head-break:path', chartSeconds: 1.5, frequencyHz: 880 },
    { id: 'path-break:head', chartSeconds: 3, frequencyHz: 880 },
    { id: 'path-break:path', chartSeconds: 3.5, frequencyHz: 1320 },
    { id: 'path-break:pathBreak', chartSeconds: 4, frequencyHz: 1320 },
  ]);
});

it('emits one path cue for a headless each Wi-Fi slide', () => {
  const wifi = makeSlide({
    id: 'wifi', isSlideEach: true, modifiers: { break: true, ex: false },
    slide: {
      command: 'w', endPosition: 5, head: 'none', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
    },
  });

  expect(buildChartCues([wifi])).toEqual([
    { id: 'wifi:path', chartSeconds: 1.5, frequencyHz: 880 },
  ]);
});

it('skips zero-duration path starts but retains a break tail cue', () => {
  const zeroMove = makeSlide({
    id: 'zero', startSeconds: 2, moveStartSeconds: 2.5, endSeconds: 2.5,
    slide: {
      command: '-', endPosition: 3, head: 'none', slideBreak: true,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 0 },
    },
  });

  expect(buildChartCues([zeroMove])).toEqual([
    { id: 'zero:pathBreak', chartSeconds: 2.5, frequencyHz: 1320 },
  ]);
});

it('emits one shared head cue and branch-specific movement and break-tail cues', () => {
  const branches = makeSlide({
    id: 'branches',
    modifiers: { break: true, ex: false },
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      additionalPaths: [{
        command: '>', endPosition: 5, slideBreak: true,
        wait: { kind: 'seconds', seconds: 0.75 }, move: { kind: 'seconds', seconds: 0.5 },
      }],
    },
    moveStartSeconds: 1.5,
    endSeconds: 2.5,
    slidePaths: [
      {
        command: '-', endPosition: 3, slideBreak: false,
        wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
        moveStartSeconds: 1.5, endSeconds: 2.5,
      },
      {
        command: '>', endPosition: 5, slideBreak: true,
        wait: { kind: 'seconds', seconds: 0.75 }, move: { kind: 'seconds', seconds: 0.5 },
        moveStartSeconds: 1.75, endSeconds: 2.25,
      },
    ],
  });

  expect(buildChartCues([branches])).toEqual([
    { id: 'branches:head', chartSeconds: 1, frequencyHz: 1320 },
    { id: 'branches:path', chartSeconds: 1.5, frequencyHz: 880 },
    { id: 'branches:path:1:path', chartSeconds: 1.75, frequencyHz: 1320 },
    { id: 'branches:path:1:pathBreak', chartSeconds: 2.25, frequencyHz: 1320 },
  ]);
});

it('does not retrigger a connected route at its internal segment boundary', () => {
  const note = makeSlide({
    slide: { ...makeSlide().slide!, slideBreak: true, continuations: [{ command: '-', endPosition: 7 }] },
    slidePaths: [{
      ...makeSlide().slide!, slideBreak: true, continuations: [{ command: '-', endPosition: 7 }],
      moveStartSeconds: 1.5, endSeconds: 2.5,
      segments: [
        { command: '-', startPosition: 1, endPosition: 3, moveStartSeconds: 1.5, endSeconds: 1.9 },
        { command: '-', startPosition: 3, endPosition: 7, moveStartSeconds: 1.9, endSeconds: 2.5 },
      ],
    }],
  });
  expect(buildChartCues([note])).toEqual([
    { id: 'note-1:head', chartSeconds: 1, frequencyHz: 880 },
    { id: 'note-1:path', chartSeconds: 1.5, frequencyHz: 1320 },
    { id: 'note-1:pathBreak', chartSeconds: 2.5, frequencyHz: 1320 },
  ]);
});
