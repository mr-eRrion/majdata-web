import { useEffect, useState } from 'react';
import type { DisplayChart, DisplaySnapshot, EditCommand, Rational } from '../../../../packages/chart-core/src/types';
import { rationalFromNumber } from '../../../../packages/chart-core/src/rational';

type Commands = { disabled: boolean; onCommand(command: EditCommand): Promise<void>; onError(error: unknown): void };

export function BpmProperties({ chart, disabled, onCommand, onError }: Commands & { chart: DisplayChart }) {
  const fromChart = () => chart.bpms.map((event) => ({ beat: String(event.beat.numerator / event.beat.denominator), bpm: String(event.bpm), originalBeat: event.beat as Rational | undefined }));
  const [rows, setRows] = useState(fromChart);
  useEffect(() => setRows(fromChart()), [chart]);
  function patch(index: number, field: 'beat' | 'bpm', value: string) {
    setRows((items) => items.map((item, current) => current === index ? { ...item, [field]: value } : item));
  }
  async function apply() {
    try {
      const bpms = rows.map((row) => ({ beat: row.originalBeat && row.beat === String(row.originalBeat.numerator / row.originalBeat.denominator) ? row.originalBeat : rationalFromNumber(Number(row.beat)), bpm: Number(row.bpm) }));
      await onCommand({ type: 'set-bpms', difficulty: chart.difficulty, bpms });
    } catch (error) { onError(error); }
  }
  return <details className="property-details">
    <summary>BPM 事件（{chart.bpms.length}）</summary>
    <p className="muted">拍点以四分音符为 1 拍。修改后点击应用，作为一次撤销操作。</p>
    {rows.map((row, index) => <div key={index} className="bpm-row">
      <label>拍点<input aria-label={`BPM 拍点 ${index + 1}`} type="number" min="0" step="0.25" value={row.beat} disabled={disabled || index === 0} onChange={(event) => patch(index, 'beat', event.target.value)} /></label>
      <label>BPM<input aria-label={`BPM 数值 ${index + 1}`} type="number" min="0.001" step="any" value={row.bpm} disabled={disabled} onChange={(event) => patch(index, 'bpm', event.target.value)} /></label>
      <button aria-label={`删除 BPM ${index + 1}`} disabled={disabled || index === 0} onClick={() => setRows((items) => items.filter((_, current) => current !== index))}>×</button>
    </div>)}
    <div className="button-grid"><button disabled={disabled} onClick={() => setRows((items) => [...items, { beat: String(Number(items.at(-1)?.beat ?? 0) + 4), bpm: items.at(-1)?.bpm ?? '120', originalBeat: undefined }])}>添加 BPM</button><button disabled={disabled} onClick={() => void apply()}>应用 BPM</button></div>
  </details>;
}

export function MetadataProperties({ snapshot, difficulty, disabled, onCommand, onError }: Commands & { snapshot: DisplaySnapshot; difficulty: number }) {
  const fields = [['title', '标题'], ['artist', '作者'], ['des', '默认谱师'], [`lv_${difficulty}`, '当前难度等级'], [`des_${difficulty}`, '当前难度谱师']];
  return <details className="property-details"><summary>谱面信息</summary>
    {!snapshot.metadataEditable && <p className="muted">存在歧义字段，暂不允许修改谱面信息。</p>}
    {fields.map(([field, label]) => <label key={`${snapshot.generation}:${field}:${snapshot.metadata[field] ?? ''}`}>{label}<input aria-label={`谱面${label}`} type="text" defaultValue={snapshot.metadata[field] ?? ''} disabled={disabled} onBlur={(event) => {
      const value = event.target.value;
      if (value !== (snapshot.metadata[field] ?? '')) void onCommand({ type: 'set-metadata', field, value }).catch(onError);
    }} /></label>)}
  </details>;
}
