import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { composeNote, composePrefab, notePlacement, type FrameState, type Prefab } from './composition.js';
import { noteFrame } from './note-state.js';
import type { SkinSpriteEntry } from './pixi.js';
import parameters from './slide-parameters.json';
import { displaySlidePaths } from './display-slide-paths.js';

function sourceMoveQuarters(note: DisplayNote, move: NonNullable<DisplayNote['slide']>['move']): number {
  switch (move.kind) {
    case 'beatsAtStartBpm':
      return 4 * move.beats / move.division;
    case 'beatsAtBpm':
      return Math.trunc(move.beats / move.division * 384 * note.bpm / move.bpm) * 4 / 384;
    case 'seconds':
      return Math.trunc(move.seconds * 10 * note.bpm / 6) * 4 / 400;
  }
}

function headRotateSpeed(note: DisplayNote): number {
  const shortest = Math.min(...displaySlidePaths(note)
    .map((path) => sourceMoveQuarters(note, path.slide!.move))
    .filter((move) => move > 0.001));
  return Number.isFinite(shortest) ? -360 / shortest : 0;
}

export function slideHeadParts(note: DisplayNote, frame: FrameState) {
  if (note.slide?.head === 'none') return [];
  const head: DisplayNote = { ...note, kind: 'tap', slide: undefined };
  return note.slide?.head === 'tap' ? composeNote(head, frame)
    : composePrefab(head, frame, parameters.head as Prefab,
      displaySlidePaths(note).length > 1 ? 'star.double' : 'star');
}

export function slideHeadEntry(note: DisplayNote, nowSeconds: number): SkinSpriteEntry | null {
  if (note.slide?.head === 'none') return null;
  const head: DisplayNote = { ...note, kind: 'tap', slide: undefined };
  const frame = noteFrame(head, nowSeconds);
  if (!frame.visible) return null;
  const placement = notePlacement(head, frame);
  placement.rotation -= nowSeconds * headRotateSpeed(note) * Math.PI / 180;
  return { id: note.id, parts: slideHeadParts(note, frame), placement,
    groupOrder: parameters.sorting.slideHead[0].sortingOrder, depth: note.startSeconds };
}
