import { expect, it } from 'vitest';
import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { composeNote, iconFrame, notePlacement, ringRadius } from './composition.js';

const note: DisplayNote = { id: 'a', kind: 'hold', position: 1, beat: { numerator: 0, denominator: 1 }, order: 0,
  modifiers: { break: true, ex: true }, isEach: true, startSeconds: 0, endSeconds: 2, bpm: 120 };

it('combines Break before each with an independently sliced EX overlay and original endpoint', () => {
  const parts = composeNote(note, { ...iconFrame, length: 2 });
  expect(parts.map((part) => part.key)).toEqual(['hold.break', 'hold.ex', 'hold.end.break']);
  expect(parts[0].height).toBe(3.4);
  expect(parts[0].borders).toEqual([0, 55, 0, 58]);
  expect(parts[1].borders).toEqual([0, 47, 0, 48]);
  expect(parts[2].y).toBe(-2);
  expect(parts[2].width).toBe(0.64);
  const placement = notePlacement(note, { ...iconFrame, distance: 2 });
  expect(Math.hypot(placement.x, placement.y)).toBeCloseTo(ringRadius - 2, 5);
});

it('keeps four TouchHold colours as simultaneous parts and uses the extracted sensor position', () => {
  const touch = { ...note, kind: 'touchHold' as const, touchArea: 'B' as const };
  const parts = composeNote(touch, { ...iconFrame, alpha: 0.25, progress: 0.5 });
  expect(parts.filter((part) => /^touchhold\.\d$/.test(part.key))).toHaveLength(4);
  expect(parts.find((part) => part.key === 'touch.point.base')?.alpha).toBe(0.25);
  expect(parts.find((part) => part.key === 'touchhold.border')?.progress).toBe(0.5);
  const placement = notePlacement(touch, iconFrame);
  expect(placement.x).toBeCloseTo(0.8799432, 5);
  expect(placement.y).toBeCloseTo(-2.1243708, 5);
});

it('uses the static source Star prefab for force-star Tap without the moving star scale', () => {
  const tap = { ...note, kind: 'tap' as const, forceStar: true, modifiers: { break: false, ex: true }, isEach: false };
  const parts = composeNote(tap, iconFrame);
  expect(parts.map(part => part.key)).toEqual(['star.base', 'star.ex']);
  expect(parts[0].width).toBe(1.26);
  expect(parts[0].height).toBe(1.26);
  expect(parts[0].scaleX).toBe(1);
  expect(parts[0].rotation).toBeCloseTo(0);
  expect(parts[1].tint).toBe(0x38b5eb);
  expect(notePlacement(tap, iconFrame)).toEqual(notePlacement({ ...tap, forceStar: false }, iconFrame));
});
