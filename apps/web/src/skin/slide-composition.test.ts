import { expect, it } from 'vitest';
import type { DisplayNote, DisplaySlideSegment } from '../../../../packages/chart-core/src/types.js';
import { composeSlide } from './slide-composition.js';
import { slideHeadEntry, slideHeadParts } from './slide-head.js';
import { iconFrame, notePlacement } from './composition.js';
import { noteFrame } from './note-state.js';
import { displaySlidePaths } from './display-slide-paths.js';

type NoteWithSegments = DisplayNote & { segments?: DisplaySlideSegment[] };

function makeSlide(overrides: Partial<NoteWithSegments> = {}): NoteWithSegments {
  return {
    id: 's1', kind: 'slide', beat: { numerator: 0, denominator: 1 }, position: 1, order: 0,
    modifiers: { break: false, ex: false },
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
    },
    startSeconds: 1, moveStartSeconds: 1.5, endSeconds: 2.5, bpm: 120,
    ...overrides,
  };
}

it('uses the source blue EX for a star head, with Break and each taking priority', () => {
  const note = makeSlide({ modifiers: { break: false, ex: true } });
  const tint = (head: DisplayNote) => slideHeadParts(head, iconFrame).find(part => part.key.endsWith('.ex'))?.tint;
  expect(tint(note)).toBe(0x38b5eb);
  expect(tint({ ...note, isEach: true })).toBe(0xffff59);
  expect(tint({ ...note, isEach: true, modifiers: { break: true, ex: true } })).toBe(0xffb03b);
  expect(tint({ ...note, slide: { ...note.slide!, head: 'tap' } })).toBe(0xf2b0db);
});

it('keeps head each/break appearance separate from path each/break style', () => {
  const headFlags = composeSlide(makeSlide({ isEach: true, modifiers: { break: true, ex: false } }), 2);
  const pathEach = composeSlide(makeSlide({ isSlideEach: true }), 2);
  const pathBreak = composeSlide(makeSlide({ slide: {
    command: '-', endPosition: 3, head: 'tap', slideBreak: true,
    wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
  } }), 2);

  expect(headFlags.head).toEqual({ kind: 'star', lane: 1 });
  expect(headFlags.strips[0].key).toBe('slide.base');
  expect(headFlags.parts[0].key).toBe('star.base');
  expect(pathEach.strips[0].key).toBe('slide.each');
  expect(pathEach.parts[0].key).toBe('star.each');
  expect(pathBreak.strips[0].key).toBe('slide.break');
  expect(pathBreak.parts[0].key).toBe('star.break');
  expect(pathBreak.head.kind).toBe('tap');
});

it('returns source-point strips with the runtime line metadata', () => {
  const composition = composeSlide(makeSlide(), 1);

  expect(composition.visible).toBe(true);
  expect(composition.progress).toBe(0);
  expect(composition.strips.length).toBeGreaterThan(0);
  expect(composition.strips[0].rendererIndex).toBe(0);
  expect(composition.strips[0].sourceStartIndex).toBe(0);
  expect(composition.strips[0].positions.length).toBeGreaterThanOrEqual(4);
  expect(composition.strips[0].widthMultiplier).toBeCloseTo(0.9, 6);
  expect(composition.strips[0].textureMode).toBe(1);
  expect(composition.strips[0].material.texture.width).toBe(51);
  expect(composition.parts).toHaveLength(0);
});

it('moves one star continuously while connected segments hide, progress, and reveal in order', () => {
  const connected = makeSlide({
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      continuations: [{ command: '<', endPosition: 5 }],
    },
    segments: [
      { startPosition: 1, command: '-', endPosition: 3, moveStartSeconds: 1.5, endSeconds: 2 },
      { startPosition: 3, command: '<', endPosition: 5, moveStartSeconds: 2, endSeconds: 2.5 },
    ],
  });
  const firstHalf = composeSlide(connected, 1.75);
  const join = composeSlide(connected, 2);
  const secondHalf = composeSlide(connected, 2.25);
  const starParts = (composition: ReturnType<typeof composeSlide>) =>
    composition.parts.filter(({ key }) => key.startsWith('star.'));

  expect(firstHalf.strips.map(({ segmentIndex }) => segmentIndex)).toContain(0);
  expect(firstHalf.strips.map(({ segmentIndex }) => segmentIndex)).toContain(1);
  expect(join.strips.every(({ segmentIndex }) => segmentIndex === 1)).toBe(true);
  expect(secondHalf.strips.every(({ segmentIndex }) => segmentIndex === 1)).toBe(true);
  expect(join.activeSegmentIndex).toBe(0);
  expect(secondHalf.activeSegmentIndex).toBe(1);
  expect(starParts(firstHalf)).toHaveLength(starParts(secondHalf).length);
  expect(starParts(firstHalf).map(({ x, y }) => [x, y])).not.toEqual(starParts(secondHalf).map(({ x, y }) => [x, y]));
  expect(starParts(join).every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  expect(composeSlide(connected, 2.5).visible).toBe(false);
});

it('handles a zero-duration segment at its boundary without a duplicate star or invalid coordinates', () => {
  const connected = makeSlide({
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      continuations: [{ command: '<', endPosition: 5 }],
    },
    segments: [
      { startPosition: 1, command: '-', endPosition: 3, moveStartSeconds: 1.5, endSeconds: 1.5 },
      { startPosition: 3, command: '<', endPosition: 5, moveStartSeconds: 1.5, endSeconds: 2.5 },
    ],
  });

  const composition = composeSlide(connected, 1.5);
  const stars = composition.parts.filter(({ key }) => key.startsWith('star.'));
  expect(composition.strips.length).toBeGreaterThan(0);
  expect(composition.strips.every(({ segmentIndex }) => segmentIndex === 1)).toBe(true);
  expect(stars.length).toBeGreaterThan(0);
  expect(stars.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
});

it('keeps a zero-total-duration route hidden at its movement end', () => {
  const zeroMove = makeSlide({
    moveStartSeconds: 1.5,
    endSeconds: 1.5,
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 0 },
      continuations: [{ command: '<', endPosition: 5 }],
    },
    segments: [
      { startPosition: 1, command: '-', endPosition: 3, moveStartSeconds: 1.5, endSeconds: 1.5 },
      { startPosition: 3, command: '<', endPosition: 5, moveStartSeconds: 1.5, endSeconds: 1.5 },
    ],
  });

  expect(composeSlide(zeroMove, 1.5).visible).toBe(false);
});

it('renders continuation strips in the continuation start lane’s coordinate frame', () => {
  const connected = makeSlide({
    position: 2,
    slide: {
      command: '-', endPosition: 4, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      continuations: [{ command: '<', endPosition: 6 }],
    },
    segments: [
      { startPosition: 2, command: '-', endPosition: 4, moveStartSeconds: 1.5, endSeconds: 2 },
      { startPosition: 4, command: '<', endPosition: 6, moveStartSeconds: 2, endSeconds: 2.5 },
    ],
  });
  const standalone = makeSlide({
    position: 4,
    slide: {
      command: '<', endPosition: 6, head: 'none', slideBreak: false,
      wait: { kind: 'seconds', seconds: 1 }, move: { kind: 'seconds', seconds: 0.5 },
    },
    moveStartSeconds: 2,
    endSeconds: 2.5,
  });
  const chainedFrame = composeSlide(connected, 2.25);
  const standaloneFrame = composeSlide(standalone, 2.25);
  const chainedStrips = chainedFrame.strips.filter(({ segmentIndex }) => segmentIndex === 1)
    .map(({ rendererIndex, positions }) => ({ rendererIndex, positions }));
  const standaloneStrips = standaloneFrame.strips
    .map(({ rendererIndex, positions }) => ({ rendererIndex, positions }));

  expect(chainedStrips).toEqual(standaloneStrips);
  expect(chainedFrame.parts.map(({ x, y }) => [x, y])).toEqual(standaloneFrame.parts.map(({ x, y }) => [x, y]));
});

it('reveals only the remaining Wi-Fi arrows and uses the path each sprites', () => {
  const wifi = makeSlide({ isSlideEach: true, slide: {
    command: 'w', endPosition: 5, head: 'none', slideBreak: false,
    wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
  } });
  const composition = composeSlide(wifi, 2);
  const arrowParts = composition.parts.filter((part) => part.key.startsWith('wifi.'));
  const movingStars = composition.parts.filter((part) => part.key.startsWith('star.'));

  expect(arrowParts).toHaveLength(6);
  expect(arrowParts[0].key).toBe('wifi.each.5');
  expect(arrowParts[5].key).toBe('wifi.each.10');
  expect(movingStars).toHaveLength(3);
  expect(movingStars.every((part) => part.key === 'star.each')).toBe(true);
  expect(composition.strips).toHaveLength(0);
});

it('uses the SlideMulti head skin and rotates the shared head at the shortest path rate', () => {
  const note = makeSlide({
    id: 'branched', startSeconds: 5, moveStartSeconds: 5.5, endSeconds: 7.5, bpm: 120,
    modifiers: { break: false, ex: true },
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'beatsAtStartBpm', division: 4, beats: 4 },
      additionalPaths: [{
        command: '>', endPosition: 5, slideBreak: false,
        wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
      }],
    },
    slidePaths: [
      {
        command: '-', endPosition: 3, slideBreak: false,
        wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'beatsAtStartBpm', division: 4, beats: 4 },
        moveStartSeconds: 5.5, endSeconds: 7.5,
      },
      {
        command: '>', endPosition: 5, slideBreak: false,
        wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
        moveStartSeconds: 5.5, endSeconds: 6.5,
      },
    ],
  });
  const parts = slideHeadParts(note, iconFrame);
  const noteModel = parts.find((part) => part.key.startsWith('star.double.'));
  const exModel = parts.find((part) => part.key === 'star.double.ex');

  expect(noteModel?.key).toBe('star.double.base');
  expect(exModel?.tint).toBe(0x38b5eb);

  const head = { ...note, kind: 'tap' as const, slide: undefined };
  const now = 4.9;
  const baseRotation = notePlacement(head, noteFrame(head, now)).rotation;
  const entry = slideHeadEntry(note, now)!;
  // The shortest branch is two quarter-note beats, so source speed is -360/2 degrees per second.
  expect(entry.placement.rotation - baseRotation).toBeCloseTo(now * Math.PI, 8);
});

it('keeps path Each styling independent from shared head Break/EX and headless branch state', () => {
  const note = makeSlide({
    isSlideEach: true,
    modifiers: { break: true, ex: true },
    slide: {
      command: '-', endPosition: 3, head: 'star', slideBreak: false,
      wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      additionalPaths: [{
        command: '>', endPosition: 5, slideBreak: false,
        wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
      }],
    },
    slidePaths: [
      {
        command: '-', endPosition: 3, slideBreak: false,
        wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
        moveStartSeconds: 1.5, endSeconds: 2.5,
      },
      {
        command: '>', endPosition: 5, slideBreak: false,
        wait: { kind: 'seconds', seconds: 0.5 }, move: { kind: 'seconds', seconds: 1 },
        moveStartSeconds: 1.5, endSeconds: 2.5,
      },
    ],
  });
  const paths = displaySlidePaths(note);
  const moving = composeSlide(paths[1], 2);

  expect(paths[1].slide?.head).toBe('none');
  expect(paths[1].modifiers).toEqual({ break: true, ex: true });
  expect(moving.strips[0].key).toBe('slide.each');
  expect(moving.parts[0].key).toBe('star.each');
});
