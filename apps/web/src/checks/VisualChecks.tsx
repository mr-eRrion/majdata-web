import { useEffect, useState } from 'react';
import { beatToSeconds } from '../../../../packages/chart-core/src/time';
import type { BpmEvent, VisualChecks as CheckState } from '../../../../packages/chart-core/src/types';
import './VisualChecks.css';
import { warningMessages } from './messages';

export function VisualChecks({ checks, bpms, onSeek, onNavigate }: {
  checks: CheckState | undefined;
  bpms: BpmEvent[];
  onSeek: (seconds: number) => void;
  onNavigate: (direction: -1 | 1) => void;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [checks]);
  const results = checks?.available ? checks.results : [];
  const pageSize = 50;
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(results.length / pageSize) - 1));
  const first = pageIndex * pageSize;
  return <section className="visual-checks" aria-label="Visual 碰撞检查">
    <h3>Visual 碰撞检查</h3>
    <p className="muted">按原程序默认阈值检查：严重范围 0.12 秒，提醒范围 0.20 秒。采用 Visual 的拍时长；跨 BPM 时可能与 Simai 播放时长不同。</p>
    {!checks || !checks.available ? <p role="status">{checks && !checks.available ? checks.reason : '尚未取得检查结果。'}</p>
      : <>
        <p role="status">{checks.results.length ? `${checks.results.length} 项结果 · ${checks.results.filter((result) => result.severity === 'bad').length} 项冲突` : '未发现碰撞或多押告警。'}</p>
        <div className="button-grid">
          <button disabled={!checks.results.length} onClick={() => onNavigate(-1)}>上一处告警</button>
          <button disabled={!checks.results.length} onClick={() => onNavigate(1)}>下一处告警</button>
        </div>
        <ul>{results.slice(first, first + pageSize).map((result) => {
          const seconds = beatToSeconds(result.beat, bpms);
          return <li key={`${result.beat.numerator}/${result.beat.denominator}:${result.code}`}>
            <button className={result.severity} onClick={() => onSeek(seconds)}>
              <time>{seconds.toFixed(3)} s</time><span>{warningMessages[result.code]}</span>
            </button>
          </li>;
        })}</ul>
        {results.length > pageSize && <div className="check-pages">
          <button disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>上一页结果</button>
          <span>第 {first + 1}–{Math.min(first + pageSize, results.length)} 项，共 {results.length} 项</span>
          <button disabled={first + pageSize >= results.length} onClick={() => setPage(pageIndex + 1)}>下一页结果</button>
        </div>}
      </>}
  </section>;
}
