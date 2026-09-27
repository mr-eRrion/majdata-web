import type { BpmEvent, HoldDuration, Rational } from './types.js';
import {
  addRational,
  compareRational,
  rational,
  rationalFromNumber,
  rationalKey,
  rationalToNumber,
  subtractRational,
} from './rational.js';

interface BpmTimeline { events: BpmEvent[]; starts: number[] }
const timelineCache = new WeakMap<readonly BpmEvent[], BpmTimeline>();

function orderedBpms(bpms: readonly BpmEvent[]): BpmEvent[] {
  const cached = timelineCache.get(bpms);
  if (cached) return cached.events;
  const ordered = [...bpms].sort((a, b) => compareRational(a.beat, b.beat));
  for (const event of ordered) {
    if (!Number.isFinite(event.bpm) || event.bpm <= 0) throw new RangeError('BPM must be positive and finite');
    if (compareRational(event.beat, rational(0)) < 0) throw new RangeError('BPM positions cannot be negative');
  }
  if (ordered.length === 0 || compareRational(ordered[0].beat, rational(0)) !== 0)
    throw new RangeError('A chart needs a BPM event at beat zero');
  return ordered;
}

/** Replace same-beat events with the last incoming BPM, preserving untouched source events. */
export function mergeBpmEvents(bpms: readonly BpmEvent[], incoming: readonly BpmEvent[]): BpmEvent[] {
  if (incoming.length === 0) return bpms.map((event) => ({ ...event, beat: { ...event.beat } }));
  const replacements = new Map<string, BpmEvent>();
  for (const event of incoming) {
    const beat = rational(event.beat.numerator, event.beat.denominator);
    replacements.set(rationalKey(beat), { beat, bpm: event.bpm });
  }
  const replacedBeats = new Set(replacements.keys());
  return [
    ...bpms.filter((event) => !replacedBeats.has(rationalKey(event.beat)))
      .map((event) => ({ ...event, beat: { ...event.beat } })),
    ...replacements.values(),
  ].sort((a, b) => compareRational(a.beat, b.beat));
}

function timeline(bpms: readonly BpmEvent[]): BpmTimeline {
  const cached = timelineCache.get(bpms);
  if (cached) return cached;
  const ordered = orderedBpms(bpms);
  const groups: BpmEvent[] = [];
  for (const event of ordered) {
    const previous = groups.at(-1);
    if (previous && compareRational(previous.beat, event.beat) === 0) groups[groups.length - 1] = event;
    else groups.push(event);
  }
  const starts = new Array<number>(groups.length);
  starts[0] = 0;
  for (let index = 1; index < groups.length; index++) {
    const prior = groups[index - 1];
    starts[index] = starts[index - 1]
      + rationalToNumber(subtractRational(groups[index].beat, prior.beat)) * 60 / prior.bpm;
    if (!Number.isFinite(starts[index])) throw new RangeError('BPM timeline exceeds the finite seconds range');
  }
  const value = { events: groups, starts };
  timelineCache.set(bpms, value);
  return value;
}

function upperBound<T>(items: readonly T[], value: number, get: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (get(items[middle]) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundBeat(events: readonly BpmEvent[], beat: Rational): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareRational(events[middle].beat, beat) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function bpmAtBeat(beat: Rational, bpms: readonly BpmEvent[]): number {
  const target = rational(beat.numerator, beat.denominator);
  if (compareRational(target, rational(0)) < 0) throw new RangeError('Beat cannot be negative');
  const { events } = timeline(bpms);
  return events[Math.max(0, upperBoundBeat(events, target) - 1)].bpm;
}

/** Returns chart-relative seconds; `&first` is kept separately by the document. */
export function beatToSeconds(beat: Rational, bpms: readonly BpmEvent[]): number {
  const target = rational(beat.numerator, beat.denominator);
  if (compareRational(target, rational(0)) < 0) throw new RangeError('Beat cannot be negative');
  const map = timeline(bpms);
  const index = Math.max(0, upperBoundBeat(map.events, target) - 1);
  const current = map.events[index];
  const seconds = map.starts[index] + rationalToNumber(subtractRational(target, current.beat)) * 60 / current.bpm;
  if (!Number.isFinite(seconds)) throw new RangeError('Beat time exceeds the finite seconds range');
  return seconds;
}

/** Inverts the piecewise-constant BPM timeline into an unsnapped numeric beat. */
export function secondsToBeat(seconds: number, bpms: readonly BpmEvent[]): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Seconds must be finite and non-negative');
  const map = timeline(bpms);
  const index = Math.max(0, upperBound(map.starts, seconds, (value) => value) - 1);
  return rationalToNumber(map.events[index].beat) + (seconds - map.starts[index]) * map.events[index].bpm / 60;
}

export function durationToSeconds(duration: HoldDuration, startBpm: number): number {
  if (!Number.isFinite(startBpm) || startBpm <= 0) throw new RangeError('Hold start BPM must be positive and finite');
  let seconds: number;
  switch (duration.kind) {
    case 'short':
      seconds = 0;
      break;
    case 'seconds':
      seconds = duration.seconds;
      break;
    case 'beatsAtStartBpm':
      validateBeatDuration(duration.division, duration.beats);
      seconds = duration.beats * 4 / duration.division * 60 / startBpm;
      break;
    case 'beatsAtBpm':
      if (!Number.isFinite(duration.bpm) || duration.bpm <= 0) throw new RangeError('Hold BPM must be positive and finite');
      validateBeatDuration(duration.division, duration.beats);
      seconds = duration.beats * 4 / duration.division * 60 / duration.bpm;
      break;
    default:
      throw new TypeError('Unsupported Hold duration');
  }
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Hold duration must be finite and non-negative');
  return seconds;
}

function validateBeatDuration(division: number, beats: number): void {
  if (!Number.isSafeInteger(division) || division <= 0 || !Number.isSafeInteger(beats) || beats < 0)
    throw new RangeError('Hold division must be a positive safe integer and beats a non-negative safe integer');
}

export const holdDurationSeconds = durationToSeconds;

export function secondsOffsetToBeat(seconds: number, bpm: number): Rational {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError('BPM must be positive and finite');
  return rationalFromNumber(seconds * bpm / 60);
}

export function advanceBeat(beat: Rational, delta: Rational): Rational {
  return addRational(beat, delta);
}
