import { addRational, beatToSeconds, rational } from '../../../../packages/chart-core/src/index.js';
import type { BpmEvent, Rational } from '../../../../packages/chart-core/src/types.js';

export interface FastPlacementInput {
  position: number;
  beat: Rational;
  bpms: readonly BpmEvent[];
  snapDivision: number;
  laneOrder: readonly number[];
  direction: 'left' | 'right';
  playheadSeconds: number;
}

export interface FastPlacementStep {
  position: number;
  beat: Rational;
  nextPosition: number;
  nextBeat: Rational;
  nextChartSeconds: number;
}

/** Places at the current lane/beat, then computes the next fast-placement cursor. */
export function fastPlacementStep(input: FastPlacementInput): FastPlacementStep | null {
  const laneIndex = input.laneOrder.indexOf(input.position);
  if (!Number.isInteger(input.position) || laneIndex < 0) return null;

  const laneCount = input.laneOrder.length;
  const step = input.direction === 'left' ? -1 : 1;
  const nextPosition = input.laneOrder[(laneIndex + step + laneCount) % laneCount];
  const nextBeat = addRational(input.beat, rational(1, input.snapDivision));
  const beatSeconds = beatToSeconds(input.beat, input.bpms);
  const nextBeatSeconds = beatToSeconds(nextBeat, input.bpms);

  return {
    position: input.position,
    beat: input.beat,
    nextPosition,
    nextBeat,
    nextChartSeconds: input.playheadSeconds + nextBeatSeconds - beatSeconds,
  };
}
