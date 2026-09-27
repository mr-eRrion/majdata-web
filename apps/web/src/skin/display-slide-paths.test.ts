import { expect, it } from 'vitest';
import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { composeSlide } from './slide-composition.js';
import { displaySlidePaths } from './display-slide-paths.js';

const makeSlide = (overrides: Partial<DisplayNote> = {}): DisplayNote => ({
  id: 'shared', kind: 'slide', beat: { numerator: 0, denominator: 1 }, position: 1, order: 0,
  modifiers: { break: false, ex: false },
  slide: {
    command: '-', endPosition: 3, head: 'star', slideBreak: false,
    wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
    additionalPaths: [{
      command: '>', endPosition: 5, slideBreak: true,
      wait: { kind: 'seconds', seconds: 0.75 }, move: { kind: 'seconds', seconds: 0.5 },
    }],
  },
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
  startSeconds: 1, moveStartSeconds: 1.5, endSeconds: 2.5, bpm: 120,
  ...overrides,
});

it('expands independent paths without duplicating the shared head or aggregate end time', () => {
  const paths = displaySlidePaths(makeSlide());

  expect(paths).toHaveLength(2);
  expect(paths.map(({ id }) => id)).toEqual(['shared', 'shared:path:1']);
  expect(paths.map(({ slide }) => slide?.head)).toEqual(['star', 'none']);
  expect(paths.map(({ slide }) => slide?.command)).toEqual(['-', '>']);
  expect(paths.map(({ moveStartSeconds, endSeconds }) => [moveStartSeconds, endSeconds]))
    .toEqual([[1.5, 2.5], [1.75, 2.25]]);
  expect(paths.every(({ slidePaths, slide }) => slidePaths === undefined && slide?.additionalPaths === undefined)).toBe(true);

  const first = composeSlide(paths[0], 2);
  const second = composeSlide(paths[1], 2);
  expect(first.strips[0].key).toBe('slide.base');
  expect(second.strips[0].key).toBe('slide.break');
  expect(first.visible).toBe(true);
  expect(second.visible).toBe(true);
});

it('keeps a legacy hand-made single-path DisplayNote compatible', () => {
  const note = makeSlide({ slidePaths: undefined, slide: {
    command: 'w', endPosition: 5, head: 'tap', slideBreak: false,
    wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
  } });
  const [path] = displaySlidePaths(note);

  expect(path.id).toBe(note.id);
  expect(path.slide?.head).toBe('tap');
  expect(path.slide?.command).toBe('w');
  expect(path.endSeconds).toBe(note.endSeconds);
});

it('preserves connected route data and compiled segment timing on its branch view', () => {
  const note = makeSlide({
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      continuations: [{ command: '<', endPosition: 5 }],
    },
    slidePaths: [{
      command: '-', endPosition: 3, slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      continuations: [{ command: '<', endPosition: 5 }],
      moveStartSeconds: 1.5, endSeconds: 2.5,
      segments: [
        { startPosition: 1, command: '-', endPosition: 3, moveStartSeconds: 1.5, endSeconds: 2 },
        { startPosition: 3, command: '<', endPosition: 5, moveStartSeconds: 2, endSeconds: 2.5 },
      ],
    }],
  });

  const [path] = displaySlidePaths(note);
  expect(path.slide?.continuations).toEqual([{ command: '<', endPosition: 5 }]);
  expect(path.segments?.map(({ startPosition, command, endPosition, moveStartSeconds, endSeconds }) =>
    [startPosition, command, endPosition, moveStartSeconds, endSeconds]))
    .toEqual([[1, '-', 3, 1.5, 2], [3, '<', 5, 2, 2.5]]);
});

it('keeps connected segments inside each independent shared-head branch', () => {
  const base = {
    slideBreak: false,
    wait: { kind: 'seconds' as const, seconds: 0.5 },
    move: { kind: 'seconds' as const, seconds: 1 },
  };
  const note = makeSlide({
    slide: {
      ...base, command: '-', endPosition: 3, head: 'star',
      continuations: [{ command: '<', endPosition: 5 }],
      additionalPaths: [{ ...base, command: '>', endPosition: 7,
        continuations: [{ command: '-', endPosition: 1 }] }],
    },
    slidePaths: [
      { ...base, command: '-', endPosition: 3, moveStartSeconds: 1.5, endSeconds: 2.5,
        continuations: [{ command: '<', endPosition: 5 }],
        segments: [
          { startPosition: 1, command: '-', endPosition: 3, moveStartSeconds: 1.5, endSeconds: 2 },
          { startPosition: 3, command: '<', endPosition: 5, moveStartSeconds: 2, endSeconds: 2.5 },
        ] },
      { ...base, command: '>', endPosition: 7, moveStartSeconds: 1.5, endSeconds: 2.5,
        continuations: [{ command: '-', endPosition: 1 }],
        segments: [
          { startPosition: 1, command: '>', endPosition: 7, moveStartSeconds: 1.5, endSeconds: 2 },
          { startPosition: 7, command: '-', endPosition: 1, moveStartSeconds: 2, endSeconds: 2.5 },
        ] },
    ],
  });

  const paths = displaySlidePaths(note);
  expect(paths.map(({ id, slide, segments }) => [id, slide?.head, slide?.continuations?.length, segments?.length]))
    .toEqual([['shared', 'star', 1, 2], ['shared:path:1', 'none', 1, 2]]);
  expect(paths.every(({ slidePaths, slide }) => slidePaths === undefined && slide?.additionalPaths === undefined)).toBe(true);
});
