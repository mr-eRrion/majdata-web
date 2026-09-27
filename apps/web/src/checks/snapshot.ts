import type { DisplaySnapshot } from '../../../../packages/chart-core/src/types';
import { checkVisualChart } from './visual-checker';
import { toVisualCheckNotes } from './visual-model';

/** Checks enrich the response after a committed edit; a check failure must never reject that edit. */
export function withVisualChecks(snapshot: DisplaySnapshot): DisplaySnapshot {
  for (const chart of snapshot.charts) {
    if (!chart.editable) {
      chart.visualChecks = { available: false, results: [], reason: '此难度含未完整识别的语法，未运行碰撞检查。' };
      continue;
    }
    try {
      chart.visualChecks = { available: true, results: checkVisualChart(toVisualCheckNotes(chart), chart.bpms) };
    } catch (cause) {
      chart.visualChecks = { available: false, results: [],
        reason: `未完成碰撞检查：${cause instanceof Error ? cause.message : String(cause)}` };
    }
  }
  return snapshot;
}
