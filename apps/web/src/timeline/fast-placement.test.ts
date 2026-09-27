import { describe, expect, it } from 'vitest';
import { rational } from '../../../../packages/chart-core/src/index.js';
import { fastPlacementStep } from './fast-placement.js';

const laneOrder = [8, 7, 6, 5, 4, 3, 2, 1];
const bpms = [{ beat: rational(0), bpm: 120 }];

describe('fast placement', () => {
  it('moves by the displayed lane order and wraps at both ends', () => {
    const left = fastPlacementStep({ position: 5, beat: rational(2), bpms, snapDivision: 4,
      laneOrder, direction: 'left', playheadSeconds: 1 });
    const right = fastPlacementStep({ position: 5, beat: rational(2), bpms, snapDivision: 4,
      laneOrder, direction: 'right', playheadSeconds: 1 });
    expect(left?.nextPosition).toBe(6);
    expect(right?.nextPosition).toBe(4);
    expect(fastPlacementStep({ position: 8, beat: rational(0), bpms, snapDivision: 4,
      laneOrder, direction: 'left', playheadSeconds: 0 })?.nextPosition).toBe(1);
    expect(fastPlacementStep({ position: 1, beat: rational(0), bpms, snapDivision: 4,
      laneOrder, direction: 'right', playheadSeconds: 0 })?.nextPosition).toBe(8);
  });

  it('adds one snap division and preserves the playhead-to-hover time offset across BPM changes', () => {
    const step = fastPlacementStep({
      position: 5,
      beat: rational(3, 4),
      bpms: [...bpms, { beat: rational(7, 8), bpm: 60 }],
      snapDivision: 4,
      laneOrder,
      direction: 'right',
      playheadSeconds: 10,
    });
    expect(step).toEqual({
      position: 5,
      beat: rational(3, 4),
      nextPosition: 4,
      nextBeat: rational(1),
      nextChartSeconds: 10.1875,
    });
  });

  it('rejects a position outside the lane order', () => {
    expect(fastPlacementStep({ position: 9, beat: rational(0), bpms, snapDivision: 4,
      laneOrder, direction: 'left', playheadSeconds: 0 })).toBeNull();
  });
});
