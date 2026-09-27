import { rational, rationalKey } from '../../../../packages/chart-core/src/rational.js';
import type { BpmEvent, Rational, VisualCheckResult } from '../../../../packages/chart-core/src/types.js';
import { resolvePath } from '../skin/slide-path';
import { visualBeatToSeconds } from './visual-model';
import type { VisualCheckNote, VisualCheckPath } from './types';

const f32 = Math.fround;
const MAX_HIT_RANGE = f32(0.2);
const SEVERE_HIT_RANGE = f32(0.12);
const WIFI_TIME_RATE = f32(0.85073);

interface SlideBranch {
  note: VisualCheckNote;
  path: VisualCheckPath;
  ignoreEnd: boolean;
  wifi: boolean;
  endPosition?: number;
}

interface SlideEvent { position: number; seconds: number }

// The model has already validated these fractions. Avoid reducing both operands
// in every pairwise comparison; integer cross products preserve exact ordering.
function compareBeat(left: Rational, right: Rational): number {
  const a = left.numerator * right.denominator;
  const b = right.numerator * left.denominator;
  if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a < b ? -1 : a > b ? 1 : 0;
  const exactA = BigInt(left.numerator) * BigInt(right.denominator);
  const exactB = BigInt(right.numerator) * BigInt(left.denominator);
  return exactA < exactB ? -1 : exactA > exactB ? 1 : 0;
}

function normalized(beat: Rational): Rational {
  return rational(beat.numerator, beat.denominator);
}

function addTrack(track: number, offset: number): number {
  return ((track + offset - 1) % 8) + 1;
}

function sameBeat(left: Rational, right: Rational): boolean {
  return compareBeat(left, right) === 0;
}

function lerp32(start: number, end: number, rate: number): number {
  const clamped = Math.max(0, Math.min(1, rate));
  return f32(start + f32(f32(end - start) * clamped));
}

function branchOverlaps(first: SlideBranch, second: SlideBranch): boolean {
  return compareBeat(first.path.start, second.path.end) < 0
    && compareBeat(second.path.start, first.path.end) < 0;
}

function isInBranch(note: VisualCheckNote, branch: SlideBranch): boolean {
  const fromStart = compareBeat(note.hit, branch.path.start);
  if (fromStart < 0) return false;
  const toEnd = compareBeat(note.hit, branch.path.end);
  return branch.ignoreEnd ? toEnd < 0 : toEnd <= 0;
}

function countSlideBranches(note: VisualCheckNote, branches: readonly SlideBranch[]): number {
  let count = 0;
  for (const branch of branches) {
    if (isInBranch(note, branch)) count += branch.wifi ? 2 : 1;
  }
  return count;
}

function tapMulti(current: VisualCheckNote, other: VisualCheckNote): boolean {
  return compareBeat(current.hit, other.hit) >= 0
    && compareBeat(current.hit, other.kind === 'hold' ? other.end : other.hit) <= 0;
}

function tapTouchOverlap(tap: VisualCheckNote, touch: VisualCheckNote): boolean {
  if (touch.touchArea !== 'A' || touch.position !== tap.position) return false;
  const tapEnd = tap.kind === 'hold' ? tap.end : tap.hit;
  const touchEnd = touch.kind === 'touchHold' ? touch.end : touch.hit;
  return compareBeat(touch.hit, tapEnd) <= 0 && compareBeat(tap.hit, touchEnd) <= 0;
}

function buildBranches(slides: readonly VisualCheckNote[]): Map<VisualCheckNote, SlideBranch[]> {
  const result = new Map<VisualCheckNote, SlideBranch[]>();
  for (const note of slides) {
    result.set(note, note.paths.map((path) => {
      const last = path.segments.at(-1);
      return {
        note,
        path,
        ignoreEnd: false,
        wifi: path.segments[0]?.command === 'w',
        endPosition: last?.endPosition,
      };
    }));
  }
  return result;
}

function applyIgnoreEnd(slides: readonly VisualCheckNote[], branchesByNote: ReadonlyMap<VisualCheckNote, SlideBranch[]>): void {
  for (const first of slides) {
    const firstBranches = branchesByNote.get(first) ?? [];
    for (const second of slides) {
      if (first === second) continue;
      for (const branch of firstBranches) {
        if (branch.ignoreEnd || branch.wifi || branch.endPosition !== second.position) continue;
        if (second.paths.some((path) => sameBeat(branch.path.end, path.start))) branch.ignoreEnd = true;
      }
    }
  }
}

function sourceBeatSeconds(beat: Rational, bpms: readonly BpmEvent[]): number {
  return f32(visualBeatToSeconds(beat, bpms));
}

function divide32(left: number, right: number): number {
  return f32(left / right);
}

function multiply32(left: number, right: number): number {
  return f32(left * right);
}

function add32(left: number, right: number): number {
  return f32(left + right);
}

function buildSlideEvents(branches: readonly SlideBranch[], bpms: readonly BpmEvent[]): SlideEvent[] {
  const events: SlideEvent[] = [];
  for (const branch of branches) {
    const fromSeconds = sourceBeatSeconds(branch.path.start, bpms);
    const toSeconds = sourceBeatSeconds(branch.path.end, bpms);
    if (branch.wifi) {
      const start = branch.note.position;
      const eventSeconds = lerp32(fromSeconds, toSeconds, WIFI_TIME_RATE);
      for (const offset of [3, 4, 5]) events.push({ position: addTrack(start, offset), seconds: eventSeconds });
      continue;
    }

    const resolved = branch.path.segments.map((segment) => resolvePath(
      segment.command,
      segment.startPosition,
      segment.endPosition,
    ));
    let totalLength = f32(0);
    for (const path of resolved) totalLength = add32(totalLength, f32(path.warningLength));

    let prefixLength = f32(0);
    for (const [segmentIndex, path] of resolved.entries()) {
      const fragmentLength = f32(path.warningLength);
      const prefixRate = divide32(prefixLength, totalLength);
      const fragmentRate = divide32(fragmentLength, totalLength);
      for (const area of path.enterAreaData) {
        const rate = add32(prefixRate, multiply32(f32(area.timeRate), fragmentRate));
        events.push({
          position: addTrack(area.area, branch.path.segments[segmentIndex].startPosition - 1),
          seconds: lerp32(fromSeconds, toSeconds, rate),
        });
      }
      prefixLength = add32(prefixLength, fragmentLength);
    }
  }
  return events;
}

function addResult(results: Map<string, Map<number, VisualCheckResult>>, beat: Rational, code: VisualCheckResult['code']): void {
  const canonicalBeat = normalized(beat);
  const key = rationalKey(canonicalBeat);
  let atBeat = results.get(key);
  if (!atBeat) {
    atBeat = new Map();
    results.set(key, atBeat);
  }
  if (atBeat.has(code)) return;
  const severity: VisualCheckResult['severity'] = code === 0 || code === 1 || code === 5 || code === 7 || code === 8
    ? 'bad'
    : 'warning';
  atBeat.set(code, { beat: canonicalBeat, code, severity });
}

function addSlideTriangleResults(branches: readonly SlideBranch[], results: Map<string, Map<number, VisualCheckResult>>): void {
  const count = branches.length;
  if (count < 3) return;

  // The source builds a symmetric pairwise-coverage matrix, then searches all triples.
  // Bit rows preserve its strict endpoint test without repeating the cubic permutation loop.
  const adjacency = new Array<bigint>(count).fill(0n);
  for (let left = 0; left < count; left += 1) {
    for (let right = left + 1; right < count; right += 1) {
      if (!branchOverlaps(branches[left], branches[right])) continue;
      adjacency[left] |= 1n << BigInt(right);
      adjacency[right] |= 1n << BigInt(left);
    }
  }

  const ordered = branches.map((branch, index) => ({ index, beat: normalized(branch.path.start) }))
    .sort((left, right) => compareBeat(left.beat, right.beat) || left.index - right.index);
  const masks = new Map<string, bigint>();
  let mask = 0n;
  for (let cursor = 0; cursor < ordered.length;) {
    const beat = ordered[cursor].beat;
    while (cursor < ordered.length && sameBeat(ordered[cursor].beat, beat)) {
      mask |= 1n << BigInt(ordered[cursor].index);
      cursor += 1;
    }
    masks.set(rationalKey(beat), mask);
  }

  for (let left = 0; left < count; left += 1) {
    for (let right = left + 1; right < count; right += 1) {
      if ((adjacency[left] & (1n << BigInt(right))) === 0n) continue;
      const maxStart = compareBeat(branches[left].path.start, branches[right].path.start) >= 0
        ? normalized(branches[left].path.start)
        : normalized(branches[right].path.start);
      const maxStartMask = masks.get(rationalKey(maxStart)) ?? 0n;
      if ((adjacency[left] & adjacency[right] & maxStartMask) !== 0n) addResult(results, maxStart, 3);
    }
  }
}

/** Replays Visual Maimai's beat-domain ChartWatcher.Check rules for imported chart data. */
export function checkVisualChart(notes: readonly VisualCheckNote[], bpms: readonly BpmEvent[]): VisualCheckResult[] {
  const taps = notes.filter((note) => note.kind === 'tap');
  const holds = notes.filter((note) => note.kind === 'hold');
  const slides = notes.filter((note) => note.kind === 'slide');
  const ringNotes = [...taps, ...holds, ...slides];
  const touches = notes.filter((note) => note.kind === 'touch' || note.kind === 'touchHold');
  const branchesByNote = buildBranches(slides);
  const branches = slides.flatMap((slide) => branchesByNote.get(slide) ?? []);
  applyIgnoreEnd(slides, branchesByNote);

  const array = ringNotes.map((note, index) => ringNotes.some((slide, otherIndex) => otherIndex !== index
    && slide.kind === 'slide'
    && slide.position === note.position
    && slide.paths.some((path) => sameBeat(note.hit, path.start))));

  const results = new Map<string, Map<number, VisualCheckResult>>();
  for (let index = 0; index < ringNotes.length; index += 1) {
    const current = ringNotes[index];
    if (current.kind === 'slide' && !current.head) continue;

    const overlaps = { sameLane: false, touch: false };
    let noteCount = 1;
    let slideCount = 0;
    for (let otherIndex = 0; otherIndex < ringNotes.length; otherIndex += 1) {
      if (index === otherIndex) continue;
      const other = ringNotes[otherIndex];
      if (!array[index] && other.kind === 'slide') {
        slideCount += countSlideBranches(current, branchesByNote.get(other) ?? []);
        // This continue is conditional in the source. When array[index] is true,
        // headless Slide notes still reach IsTapMulti and can affect code 7.
        if (!other.head) continue;
      }
      if (!tapMulti(current, other)) continue;
      overlaps.sameLane ||= current.position === other.position;
      if (!array[index] && !array[otherIndex]) noteCount += 1;
    }

    for (const touch of touches) overlaps.touch ||= tapTouchOverlap(current, touch);

    if (overlaps.sameLane) addResult(results, current.hit, 7);
    if (overlaps.touch) addResult(results, current.hit, 8);
    if (noteCount >= 3) addResult(results, current.hit, 0);
    if (slideCount > 0 && slideCount + noteCount >= 3) {
      addResult(results, current.hit, noteCount > 1 ? 1 : 2);
    }
  }

  addSlideTriangleResults(branches, results);

  const slideEvents = buildSlideEvents(branches, bpms);
  for (const note of ringNotes) {
    if (note.kind === 'slide' && !note.head) continue;
    const noteSeconds = sourceBeatSeconds(note.hit, bpms);
    let mildCollision = false;
    for (const event of slideEvents) {
      if (event.position !== note.position) continue;
      const delta = f32(noteSeconds - event.seconds);
      if (delta > MAX_HIT_RANGE || noteSeconds < event.seconds - 0.001) continue;
      if (delta < SEVERE_HIT_RANGE) {
        mildCollision = false;
        addResult(results, note.hit, note.ex ? 6 : 5);
        break;
      }
      if (!note.ex) mildCollision = true;
    }
    if (mildCollision) addResult(results, note.hit, 4);
  }

  return [...results.values()].flatMap((atBeat) => [...atBeat.values()])
    .sort((left, right) => compareBeat(left.beat, right.beat));
}
