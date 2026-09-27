import { expect, it } from 'vitest';
import { rational } from '../../../../packages/chart-core/src/rational.js';
import type { BpmEvent, DisplayChart, VisualCheckResult } from '../../../../packages/chart-core/src/types.js';
import { groupWarningMarkers } from './warning-markers.js';

const bpms: BpmEvent[] = [
  { beat: rational(0), bpm: 120 },
  { beat: rational(1), bpm: 240 },
];

function chart(results: VisualCheckResult[] | null): Pick<DisplayChart, 'bpms' | 'visualChecks'> {
  return {
    bpms,
    visualChecks: results === null
      ? { available: false, results: [], reason: 'not checked' }
      : { available: true, results },
  };
}

it('merges equivalent beats, combines severity, and preserves first-seen code order', () => {
  const markers = groupWarningMarkers(chart([
    { beat: rational(2, 4), code: 8, severity: 'warning' },
    { beat: rational(1, 2), code: 3, severity: 'bad' },
    { beat: rational(3, 6), code: 8, severity: 'warning' },
  ]));

  expect(markers).toEqual([{
    beat: rational(1, 2), key: '1/2', seconds: 0.25, severity: 'bad', codes: [8, 3],
  }]);
});

it('sorts markers by beat and maps seconds across BPM changes', () => {
  const markers = groupWarningMarkers(chart([
    { beat: rational(3, 2), code: 1, severity: 'warning' },
    { beat: rational(1), code: 2, severity: 'bad' },
  ]));

  expect(markers.map(({ beat, seconds }) => ({ beat, seconds }))).toEqual([
    { beat: rational(1), seconds: 0.5 },
    { beat: rational(3, 2), seconds: 0.625 },
  ]);
});

it('returns no markers when checks are unavailable or absent', () => {
  expect(groupWarningMarkers(chart(null))).toEqual([]);
  expect(groupWarningMarkers({ bpms, visualChecks: undefined })).toEqual([]);
});
