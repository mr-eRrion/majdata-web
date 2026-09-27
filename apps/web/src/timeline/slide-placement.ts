import {
  addRational,
  beatToSeconds,
  bpmAtBeat,
  compareRational,
  rational,
  rationalToNumber,
  subtractRational,
} from '../../../../packages/chart-core/src/index.js';
import type { BpmEvent, HoldDuration, Note, Rational, SlideData } from '../../../../packages/chart-core/src/types.js';

export interface SlidePlacement {
  hitBeat: Rational;
  startPosition: number;
  moveBeat: Rational | null;
  endBeat: Rational | null;
  endPosition: number | null;
}

export interface SlidePlacementSettings {
  head: SlideData['head'];
  slideBreak: boolean;
  modifiers: Note['modifiers'];
}

/** Starts a one-segment Slide. The source defaults to a one-beat wait. */
export function beginSlidePlacement(beat: Rational, position: number, oneBeatStart: boolean): SlidePlacement {
  return {
    hitBeat: { ...beat },
    startPosition: position,
    moveBeat: oneBeatStart ? addRational(beat, rational(1)) : null,
    endBeat: null,
    endPosition: null,
  };
}

/** Advances hit → move start → endpoint. Earlier clicks are ignored. */
export function advanceSlidePlacement(
  state: SlidePlacement,
  beat: Rational,
  position: number,
): SlidePlacement {
  if (state.endBeat !== null) return state;
  if (state.moveBeat === null) {
    if (compareRational(beat, state.hitBeat) < 0) return state;
    return { ...state, moveBeat: { ...beat } };
  }
  if (compareRational(beat, state.moveBeat) < 0) return state;
  return { ...state, endBeat: { ...beat }, endPosition: position };
}

/** Mirrors the source right-click rewind; the one-beat toggle is read live. */
export function rewindSlidePlacement(state: SlidePlacement, oneBeatStart: boolean): SlidePlacement | null {
  if (state.endBeat !== null) return { ...state, endBeat: null, endPosition: null };
  if (state.moveBeat === null || oneBeatStart) return null;
  return { ...state, moveBeat: null };
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-10 * Math.max(1, Math.abs(left), Math.abs(right));
}

function durationFromHitBpm(
  start: Rational,
  end: Rational,
  hitBpm: number,
  bpms: readonly BpmEvent[],
): Exclude<HoldDuration, { kind: 'short' }> {
  const difference = subtractRational(end, start);
  const seconds = beatToSeconds(end, bpms) - beatToSeconds(start, bpms);
  const expectedSeconds = rationalToNumber(difference) * 60 / hitBpm;
  const crossesTempoChange = bpms.some((event) =>
    compareRational(event.beat, start) > 0 && compareRational(event.beat, end) < 0 && event.bpm !== hitBpm);

  if (!crossesTempoChange && close(seconds, expectedSeconds)) {
    const division = difference.denominator * 4;
    if (Number.isSafeInteger(division)) {
      return { kind: 'beatsAtStartBpm', division, beats: difference.numerator };
    }
  }
  return { kind: 'seconds', seconds };
}

function durationSeconds(start: Rational, end: Rational, bpms: readonly BpmEvent[]): number {
  return beatToSeconds(end, bpms) - beatToSeconds(start, bpms);
}

/** Builds an editable core note without converting clicked endpoints to rounded beats. */
export function finishSlidePlacement(
  state: SlidePlacement,
  command: SlideData['command'],
  settings: SlidePlacementSettings,
  bpms: readonly BpmEvent[],
): Omit<Note, 'id' | 'order'> {
  if (state.moveBeat === null || state.endBeat === null || state.endPosition === null) {
    throw new Error('Slide placement is incomplete');
  }
  const hitBpm = bpmAtBeat(state.hitBeat, bpms);
  const endPosition = command === 'w' ? (state.startPosition + 3) % 8 + 1 : state.endPosition;
  const wait = durationFromHitBpm(state.hitBeat, state.moveBeat, hitBpm, bpms);
  const move = durationFromHitBpm(state.moveBeat, state.endBeat, hitBpm, bpms);
  const oneBeatWait = wait.kind === 'beatsAtStartBpm' && wait.division === 4 && wait.beats === 1;

  // slideDurationSource only accepts a one-beat wait for beat-based wait forms.
  // Other clicked wait lengths must be stored as seconds to remain serializable.
  const serializableWait = !oneBeatWait
    ? { kind: 'seconds' as const, seconds: durationSeconds(state.hitBeat, state.moveBeat, bpms) }
    : move.kind === 'beatsAtStartBpm'
      ? wait
      : { kind: 'beatsAtBpm' as const, bpm: hitBpm, division: 4, beats: 1 };

  return {
    kind: 'slide',
    beat: { ...state.hitBeat },
    position: state.startPosition,
    modifiers: { ...settings.modifiers },
    slide: {
      command,
      endPosition,
      head: settings.head,
      slideBreak: settings.slideBreak,
      wait: serializableWait,
      move,
    },
  };
}
