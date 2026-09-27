import { beatToSeconds } from '../../../../packages/chart-core/src/time.js';
import { compareRational, rational, rationalKey } from '../../../../packages/chart-core/src/rational.js';
import type { DisplayChart, Rational, VisualCheckResult } from '../../../../packages/chart-core/src/types.js';

export interface WarningMarker {
  beat: Rational;
  key: string;
  seconds: number;
  severity: VisualCheckResult['severity'];
  codes: VisualCheckResult['code'][];
}

/** Group derived check codes into stable, timeline-aligned markers. */
export function groupWarningMarkers(chart: Pick<DisplayChart, 'bpms' | 'visualChecks'>): WarningMarker[] {
  const checks = chart.visualChecks;
  if (!checks?.available || checks.results.length === 0) return [];

  const groups = new Map<string, { beat: Rational; codes: Set<VisualCheckResult['code']>; bad: boolean }>();
  for (const result of checks.results) {
    const beat = rational(result.beat.numerator, result.beat.denominator);
    const key = rationalKey(beat);
    let group = groups.get(key);
    if (!group) {
      group = { beat, codes: new Set(), bad: false };
      groups.set(key, group);
    }
    group.codes.add(result.code);
    group.bad ||= result.severity === 'bad';
  }

  return [...groups.values()]
    .sort((left, right) => compareRational(left.beat, right.beat))
    .map(({ beat, codes, bad }) => ({
      beat,
      key: rationalKey(beat),
      seconds: beatToSeconds(beat, chart.bpms),
      severity: bad ? 'bad' : 'warning',
      codes: [...codes],
    }));
}
