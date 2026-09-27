import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { displaySlidePaths } from '../skin/display-slide-paths.js';
import type { AudioCue } from './types.js';

const NORMAL_HIT_HZ = 880;
const BREAK_HIT_HZ = 1320;

export function buildChartCues(notes: readonly DisplayNote[]): AudioCue[] {
  const cues: AudioCue[] = [];

  for (const note of notes) {
    const headFrequency = note.modifiers.break ? BREAK_HIT_HZ : NORMAL_HIT_HZ;
    if (note.kind !== 'slide') {
      cues.push({ id: `${note.id}:hit`, chartSeconds: note.startSeconds, frequencyHz: headFrequency });
      continue;
    }

    const slide = note.slide;
    if (!slide) continue;

    if (slide.head !== 'none') {
      cues.push({ id: `${note.id}:head`, chartSeconds: note.startSeconds, frequencyHz: headFrequency });
    }

    for (const pathNote of displaySlidePaths(note)) {
      const path = pathNote.slide!;
      const moveStart = pathNote.moveStartSeconds;
      if (moveStart !== undefined && pathNote.endSeconds > moveStart) {
        cues.push({
          id: `${pathNote.id}:path`,
          chartSeconds: moveStart,
          frequencyHz: path.slideBreak ? BREAK_HIT_HZ : NORMAL_HIT_HZ,
        });
      }

      if (path.slideBreak) {
        cues.push({ id: `${pathNote.id}:pathBreak`, chartSeconds: pathNote.endSeconds, frequencyHz: BREAK_HIT_HZ });
      }
    }
  }

  return cues;
}
