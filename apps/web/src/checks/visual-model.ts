import { compareRational, rational } from '../../../../packages/chart-core/src/rational.js';
import type { BpmEvent, DisplayChart, HoldDuration, Note, Rational, SlidePathData } from '../../../../packages/chart-core/src/types.js';
import type { VisualCheckNote, VisualCheckPath } from './types.js';

const INT_MIN = -2_147_483_648;
const INT_MAX_EXCLUSIVE = 2_147_483_648;
const LONG_MAX = 9_223_372_036_854_775_807n;
const LONG_MIN = -LONG_MAX - 1n;
const F32_EXACT_INT = 16_777_216n;
const F32 = Math.fround;

interface SourceTimeData { split: bigint; beat: bigint }

interface ImportedBpm {
  beat: Rational;
  bpm: number;
  order: number;
}

function importedBpms(bpms: readonly BpmEvent[]): ImportedBpm[] {
  const result = bpms.map((event, order) => ({
    beat: rational(event.beat.numerator, event.beat.denominator),
    bpm: parseVisualFloat(event.bpm, 'BPM'),
    order,
  })).sort((left, right) => compareRational(left.beat, right.beat) || left.order - right.order);
  if (!result.length || compareRational(result[0].beat, rational(0)) !== 0)
    throw new RangeError('Visual import needs a BPM event at beat zero.');
  if (result.some(({ bpm }) => bpm <= 0)) throw new RangeError('Visual import needs positive finite Float32 BPM values.');
  return result;
}

function parseVisualFloat(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} is outside Visual float range.`);
  const parsed = F32(Number(String(value)));
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} is outside Visual float range.`);
  return parsed;
}

function sourceInt(value: number, label: string): number {
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new RangeError(`${label} is not an integer accepted by Visual int.Parse.`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < INT_MIN || parsed >= INT_MAX_EXCLUSIVE)
    throw new RangeError(`${label} exceeds Visual Int32 range.`);
  return parsed;
}

function importedInt(value: number, label: string): number {
  if (!Number.isFinite(value) || value < INT_MIN || value >= INT_MAX_EXCLUSIVE)
    throw new RangeError(`${label} exceeds Visual Int32 conversion range.`);
  return Math.trunc(value);
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }

function gcd(left: bigint, right: bigint): bigint {
  left = abs(left);
  right = abs(right);
  while (right !== 0n) [left, right] = [right, left % right];
  return left === 0n ? 1n : left;
}

function requireExactTimeData(value: SourceTimeData, label: string): SourceTimeData {
  if (value.split <= 0n || value.split > F32_EXACT_INT || abs(value.beat) > F32_EXACT_INT / 4n)
    throw new RangeError(`${label} exceeds the exact Visual Float32 TimeData range.`);
  return value;
}

function timeData(splitValue: number, beatValue: number, label: string): SourceTimeData {
  const split = BigInt(sourceInt(splitValue, `${label} split`));
  const beat = BigInt(sourceInt(beatValue, `${label} beat count`));
  if (split <= 0n) throw new RangeError(`${label} split must be positive.`);
  return requireExactTimeData({ split, beat }, label);
}

function timeDataFromBeat(value: Rational, label: string): SourceTimeData {
  // DecryptChart normalizes every nonzero cell before assigning note/BPM hit times.
  const count = BigInt(value.numerator);
  if (count === 0n) return { split: 4n, beat: 0n };
  const split = BigInt(value.denominator) * 4n;
  const divisor = gcd(split, count);
  return requireExactTimeData({ split: split / divisor, beat: count / divisor }, label);
}

function addSourceTimeData(left: SourceTimeData, right: SourceTimeData, label: string): SourceTimeData {
  const divisor = gcd(left.split, right.split);
  const product = left.split * right.split;
  if (product > LONG_MAX) throw new RangeError(`${label} overflows Visual Int64 TimeData split arithmetic.`);
  const split = product / divisor;
  const leftBeat = left.beat * (split / left.split);
  const rightBeat = right.beat * (split / right.split);
  const beat = leftBeat + rightBeat;
  if (leftBeat < LONG_MIN || leftBeat > LONG_MAX || rightBeat < LONG_MIN || rightBeat > LONG_MAX
    || beat < LONG_MIN || beat > LONG_MAX)
    throw new RangeError(`${label} overflows Visual Int64 TimeData beat arithmetic.`);
  return requireExactTimeData({ split, beat }, label);
}

function timeDataToBeat(value: SourceTimeData, label: string): Rational {
  requireExactTimeData(value, label);
  const numerator = 4n * value.beat;
  if (numerator < BigInt(Number.MIN_SAFE_INTEGER) || numerator > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`${label} exceeds the exact Rational output range.`);
  return rational(Number(numerator), Number(value.split));
}

function currentBpmAt(beat: Rational, bpms: readonly ImportedBpm[]): number {
  let current: number | null = null;
  for (const event of bpms) {
    if (compareRational(event.beat, beat) > 0) break;
    current = event.bpm;
  }
  if (current === null) throw new RangeError('Visual import has no BPM at this event.');
  return current;
}

function secondsTextToTime(seconds: number, bpm: number, label: string): SourceTimeData {
  const serializedSeconds = parseVisualFloat(seconds, label);
  const scaled = F32(F32(F32(serializedSeconds * 10) * bpm) / 6);
  const count = importedInt(scaled, `${label} TimeData`);
  return timeData(400, count, label);
}

function importedHoldDuration(duration: HoldDuration | undefined, kind: Note['kind'], bpm: number): SourceTimeData {
  const source = duration ?? { kind: 'short' as const };
  if (source.kind === 'short') return { split: 4n, beat: 0n };
  if (source.kind === 'seconds') {
    if (kind === 'touchHold')
      throw new RangeError('触摸长按的秒数时长无法由目标格式解析，已跳过视觉校验。');
    return secondsTextToTime(source.seconds, bpm, 'Hold seconds');
  }
  if (source.kind === 'beatsAtBpm') {
    throw new RangeError('指定 BPM 的长按时长无法由目标导入器解析，已跳过视觉校验。');
  }
  return timeData(source.division, source.beats, 'Hold duration');
}

function importedSlidePair(path: SlidePathData, bpm: number): { wait: SourceTimeData; move: SourceTimeData } {
  const { wait, move } = path;
  if (wait.kind === 'beatsAtStartBpm' && wait.division === 4 && wait.beats === 1
    && move.kind === 'beatsAtStartBpm') {
    const split = sourceInt(move.division, 'Slide move split');
    const beat = sourceInt(move.beats, 'Slide move beat count');
    return { wait: timeData(4, 1, 'Slide wait'), move: timeData(split, beat, 'Slide move') };
  }
  if (wait.kind === 'beatsAtBpm' && wait.division === 4 && wait.beats === 1
    && move.kind === 'beatsAtBpm' && move.bpm === wait.bpm) {
    const waitBpm = parseVisualFloat(wait.bpm, 'Slide wait BPM');
    if (waitBpm <= 0) throw new RangeError('Slide wait BPM must be positive.');
    const waitCount = importedInt(F32(F32(100 / waitBpm) * bpm), 'Slide wait TimeData');
    const split = parseVisualFloat(move.division, 'Slide move split');
    const beats = parseVisualFloat(move.beats, 'Slide move beat count');
    if (split === 0) throw new RangeError('Slide move split cannot be zero.');
    const ratio = F32(beats / split);
    const moveCount = importedInt(F32(F32(F32(ratio * 384) * bpm) / waitBpm), 'Slide move TimeData');
    return { wait: timeData(400, waitCount, 'Slide wait'), move: timeData(384, moveCount, 'Slide move') };
  }
  if (wait.kind === 'seconds' && move.kind === 'seconds') {
    return {
      wait: secondsTextToTime(wait.seconds, bpm, 'Slide wait seconds'),
      move: secondsTextToTime(move.seconds, bpm, 'Slide move seconds'),
    };
  }
  if (wait.kind === 'beatsAtBpm' && wait.division === 4 && wait.beats === 1
    && move.kind === 'seconds') {
    const waitBpm = parseVisualFloat(wait.bpm, 'Slide wait BPM');
    if (waitBpm <= 0) throw new RangeError('Slide wait BPM must be positive.');
    const waitCount = importedInt(F32(F32(100 / waitBpm) * bpm), 'Slide wait TimeData');
    return {
      wait: timeData(400, waitCount, 'Slide wait'),
      move: secondsTextToTime(move.seconds, bpm, 'Slide move seconds'),
    };
  }

  const serialized = describeSlidePair(path);
  if (wait.kind === 'seconds' && move.kind !== 'seconds') {
    throw new RangeError(`滑条等待时长使用秒、移动时长使用拍的组合无法由目标格式解析（${serialized}），已跳过视觉校验。`);
  }
  throw new RangeError(`这组滑条等待与移动时长无法由当前格式表示（${serialized}），已跳过视觉校验。`);
}

function describeSlidePair(path: SlidePathData): string {
  const { wait, move } = path;
  if (wait.kind === 'beatsAtStartBpm' && wait.division === 4 && wait.beats === 1
    && move.kind === 'beatsAtStartBpm') return `${move.division}:${move.beats}`;
  if (wait.kind === 'beatsAtBpm' && wait.division === 4 && wait.beats === 1
    && move.kind === 'beatsAtBpm' && move.bpm === wait.bpm) return `${wait.bpm}#${move.division}:${move.beats}`;
  if (wait.kind === 'seconds' && move.kind === 'beatsAtStartBpm') return `${wait.seconds}##${move.division}:${move.beats}`;
  if (wait.kind === 'seconds' && move.kind === 'seconds') return `${wait.seconds}##${move.seconds}`;
  if (wait.kind === 'seconds' && move.kind === 'beatsAtBpm') return `${wait.seconds}##${move.bpm}#${move.division}:${move.beats}`;
  if (wait.kind === 'beatsAtBpm' && wait.division === 4 && wait.beats === 1 && move.kind === 'seconds')
    return `${wait.bpm}#${move.seconds}`;
  return '[unserializable]';
}

function visualPath(notePosition: number, hitTime: SourceTimeData, path: SlidePathData, bpm: number): VisualCheckPath {
  if (path.command === 'w' && path.continuations?.length)
    throw new RangeError('Wi-Fi Slide is atomic and cannot contain continuations.');
  const timing = importedSlidePair(path, bpm);
  const segments: VisualCheckPath['segments'] = [{
    command: path.command,
    startPosition: notePosition,
    endPosition: path.endPosition,
  }];
  let startPosition = path.endPosition;
  for (const continuation of path.continuations ?? []) {
    segments.push({ ...continuation, startPosition });
    startPosition = continuation.endPosition;
  }
  const startTime = addSourceTimeData(hitTime, timing.wait, 'Slide start time');
  const endTime = addSourceTimeData(startTime, timing.move, 'Slide end time');
  return {
    start: timeDataToBeat(startTime, 'Slide start time'),
    end: timeDataToBeat(endTime, 'Slide end time'),
    segments,
  };
}

/** Convert Web notes through the text forms serializeChart actually emits and Visual imports. */
export function toVisualCheckNotes(chart: Pick<DisplayChart, 'notes' | 'bpms'>): VisualCheckNote[] {
  const bpms = importedBpms(chart.bpms);
  return chart.notes.map((note) => {
    const hit = rational(note.beat.numerator, note.beat.denominator);
    const hitTime = timeDataFromBeat(hit, `Note ${note.id} hit time`);
    const bpm = currentBpmAt(hit, bpms);
    let end = hit;
    let paths: VisualCheckPath[] = [];
    if (note.kind === 'hold' || note.kind === 'touchHold') {
      end = timeDataToBeat(addSourceTimeData(hitTime,
        importedHoldDuration(note.duration, note.kind, bpm), `Note ${note.id} end time`), `Note ${note.id} end time`);
    } else if (note.kind === 'slide') {
      if (!note.slide) throw new RangeError(`Slide ${note.id} has no path DTO.`);
      paths = [note.slide, ...(note.slide.additionalPaths ?? [])]
        .map((path) => visualPath(note.position, hitTime, path, bpm));
    }
    return {
      id: note.id,
      kind: note.kind,
      position: note.position,
      ...(note.touchArea === undefined ? {} : { touchArea: note.touchArea }),
      hit,
      end,
      ex: note.modifiers.ex,
      head: note.kind !== 'slide' || note.slide?.head !== 'none',
      paths,
    };
  });
}

function visualBeatFloat(beat: Rational): number {
  const source = timeDataFromBeat(rational(beat.numerator, beat.denominator), 'Beat time');
  return F32(F32(4 * F32(Number(source.beat))) / F32(Number(source.split)));
}

/** Float32-equivalent of Visual BpmData.GetTime for constant BPM keyframes. */
export function visualBeatToSeconds(beat: Rational, bpms: readonly BpmEvent[]): number {
  const keyframes = importedBpms(bpms);
  const target = rational(beat.numerator, beat.denominator);
  const targetFloat = visualBeatFloat(target);
  let seconds = F32(0);
  let previousBeat = F32(0);
  let index = 1;
  for (; index < keyframes.length; index += 1) {
    const keyframe = keyframes[index];
    if (compareRational(target, keyframe.beat) < 0) break;
    const keyframeBeat = visualBeatFloat(keyframe.beat);
    const segmentBeats = F32(keyframeBeat - previousBeat);
    const segmentNumerator = F32(segmentBeats * 60);
    const segmentSeconds = F32(segmentNumerator / keyframes[index - 1].bpm);
    seconds = F32(seconds + segmentSeconds);
    previousBeat = keyframeBeat;
  }
  const remainingBeats = F32(targetFloat - previousBeat);
  const remainingNumerator = F32(remainingBeats * 60);
  const remainingSeconds = F32(remainingNumerator / keyframes[index - 1].bpm);
  const result = F32(seconds + remainingSeconds);
  if (!Number.isFinite(result)) throw new RangeError('Visual BpmData.GetTime exceeds Float32 range.');
  return result;
}
