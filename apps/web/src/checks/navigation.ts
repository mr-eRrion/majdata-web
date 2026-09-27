import { beatToSeconds } from '../../../../packages/chart-core/src/time';
import type { BpmEvent, VisualCheckResult } from '../../../../packages/chart-core/src/types';

/** Use one seconds domain for filtering and ordering; multiple codes at one beat are one stop. */
export function adjacentWarningSeconds(results: readonly VisualCheckResult[], bpms: readonly BpmEvent[], current: number, direction: -1 | 1): number | null {
  const times = [...new Set(results.map((result) => beatToSeconds(result.beat, bpms)))].sort((a, b) => a - b);
  if (!times.length) return null;
  if (direction === 1) return times.find((time) => time > current + 0.001) ?? times[0];
  for (let index = times.length - 1; index >= 0; index--) if (times[index] < current - 0.001) return times[index];
  return times[times.length - 1];
}
