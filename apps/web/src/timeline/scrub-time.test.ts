import { describe, expect, it } from 'vitest';
import { rational } from '../../../../packages/chart-core/src/index.js';
import { snapScrubTime } from './scrub-time.js';

const constantBpm = [{ beat: rational(0), bpm: 120 }];

describe('snapScrubTime', () => {
  it('uses round-to-even at positive and negative half-grid positions', () => {
    expect(snapScrubTime(0.25, constantBpm, 1)).toBeCloseTo(-0.0001, 10);
    expect(snapScrubTime(0.75, constantBpm, 1)).toBeCloseTo(0.9999, 10);
    expect(snapScrubTime(-0.25, constantBpm, 1)).toBeCloseTo(-0.0001, 10);
    expect(snapScrubTime(-0.75, constantBpm, 1)).toBeCloseTo(-1.0001, 10);
  });

  it('maps beat subdivisions through BPM changes before snapping', () => {
    const bpms = [
      { beat: rational(0), bpm: 120 },
      { beat: rational(2), bpm: 60 },
    ];
    expect(snapScrubTime(1.6, bpms, 1)).toBeCloseTo(1.9999, 10);
  });

  it('extrapolates negative pre-roll with the first BPM', () => {
    const bpms = [
      { beat: rational(0), bpm: 120 },
      { beat: rational(2), bpm: 60 },
    ];
    expect(snapScrubTime(-0.3, bpms, 1)).toBeCloseTo(-0.5001, 10);
  });
});
