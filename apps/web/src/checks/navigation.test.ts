import { expect, test } from 'vitest';
import { adjacentWarningSeconds } from './navigation';
import type { VisualCheckResult } from '../../../../packages/chart-core/src/types';

const bpms = [{ beat: { numerator: 0, denominator: 1 }, bpm: 120 }, { beat: { numerator: 2, denominator: 1 }, bpm: 240 }];
const results: VisualCheckResult[] = [
  { beat: { numerator: 6, denominator: 1 }, code: 0, severity: 'bad' },
  { beat: { numerator: 2, denominator: 1 }, code: 7, severity: 'bad' },
  { beat: { numerator: 2, denominator: 1 }, code: 8, severity: 'bad' },
];
test('warning navigation orders in seconds, skips duplicate times and wraps in both directions', () => {
  expect(adjacentWarningSeconds(results, bpms, 0, 1)).toBe(1);
  expect(adjacentWarningSeconds(results, bpms, 1, 1)).toBe(2);
  expect(adjacentWarningSeconds(results, bpms, 2, 1)).toBe(1);
  expect(adjacentWarningSeconds(results, bpms, 2, -1)).toBe(1);
  expect(adjacentWarningSeconds(results, bpms, 1, -1)).toBe(2);
  expect(adjacentWarningSeconds(results, bpms, 0.9995, 1)).toBe(2);
  expect(adjacentWarningSeconds([], bpms, 0, 1)).toBeNull();
});
