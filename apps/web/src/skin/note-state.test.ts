import { expect, it } from 'vitest';
import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { noteFrame } from './note-state.js';

const makeNote = (kind: DisplayNote['kind'], startSeconds: number, endSeconds: number): DisplayNote => ({
  id: kind,
  kind,
  position: kind === 'touch' || kind === 'touchHold' ? 1 : 1,
  touchArea: kind === 'touch' || kind === 'touchHold' ? 'A' : undefined,
  beat: { numerator: 0, denominator: 1 },
  order: 0,
  modifiers: { break: false, ex: false },
  startSeconds,
  endSeconds,
  bpm: 120,
});

it('recomputes Hold length and endpoint after arbitrary seeks', () => {
  const hold = makeNote('hold', 1, 5);
  const beforeStart = noteFrame(hold, 0, 1);
  const during = noteFrame(hold, 4, 1);

  expect(beforeStart.visible).toBe(true);
  expect(beforeStart.length).toBeCloseTo(3.6 - 1.44444, 5);
  expect(beforeStart.endpointVisible).toBe(false);
  expect(during.length).toBeCloseTo(1.44444, 5);
  expect(during.endpointVisible).toBe(true);
});

it('applies Touch SetAlpha twice and hides at its distance boundary', () => {
  const touch = makeNote('touch', 3, 3);
  const atAlphaHalf = noteFrame(touch, 3 - 3.5 / 1.44444, 8, 1);
  const atBoundary = noteFrame(touch, 3 - 4 / 1.44444, 8, 1);

  expect(atAlphaHalf.alpha).toBeCloseTo(0.25, 8);
  expect(atAlphaHalf.touchSpread).toBeCloseTo(0.3, 3);
  expect(atBoundary.distance).toBeCloseTo(4, 8);
  expect(atBoundary.visible).toBe(false);
});

it('reports TouchHold progress as a bounded fraction', () => {
  const hold = makeNote('touchHold', 2, 6);
  const frame = noteFrame(hold, 4, 8, 1);
  expect(frame.visible).toBe(true);
  expect(frame.progress).toBe(0.5);
});
