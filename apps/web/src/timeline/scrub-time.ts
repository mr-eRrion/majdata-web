import { beatToSeconds, bpmAtBeat, rational, rationalToNumber, secondsToBeat } from '../../../../packages/chart-core/src/index.js';
import type { BpmEvent } from '../../../../packages/chart-core/src/types.js';

export function snapScrubTime(seconds: number, bpms: readonly BpmEvent[], division: number): number {
  if (!Number.isFinite(seconds)) throw new RangeError('Scrub time must be finite');
  if (!Number.isSafeInteger(division) || division <= 0) throw new RangeError('Scrub division must be a positive safe integer');

  // Source BpmData extrapolates before beat zero with its first BPM; chart-core rejects negative time.
  const firstBpm = seconds < 0 ? bpmAtBeat(rational(0), bpms) : 0;
  const beat = seconds < 0 ? seconds * firstBpm / 60 : secondsToBeat(seconds, bpms);
  const gridIndex = roundToEven(beat * division);
  const snappedBeat = rational(gridIndex, division);
  const snappedSeconds = gridIndex < 0
    ? rationalToNumber(snappedBeat) * 60 / firstBpm
    : beatToSeconds(snappedBeat, bpms);
  return snappedSeconds - 0.0001;
}

function roundToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}
