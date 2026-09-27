import { useCallback, useEffect, useRef, useState } from 'react';
import type { Checkpoint, DisplayNote, EditCommand, Note, Rational, SlidePathData } from '../../../../packages/chart-core/src/types';
import { addRational, beatToSeconds, compareRational, durationToSeconds, mergeBpmEvents, rational, rationalFromNumber, rationalKey, secondsToBeat, subtractRational, transformNotes } from '../../../../packages/chart-core/src/index';
import sampleText from '../../../../fixtures/charts/baseline.maidata.txt?raw';
import { AudioTransport } from '../audio';
import { buildChartCues } from '../audio/chart-cues';
import type { AudioSnapshot, PlaybackRate } from '../audio/types';
import type { WaveformPyramid } from '../audio/waveform';
import { Timeline, type EditMenuRequest, type SlidePathRequest, type TimelineHandle } from '../timeline/Timeline';
import { snapScrubTime } from '../timeline/scrub-time';
import { VisualChecks } from '../checks/VisualChecks';
import { adjacentWarningSeconds } from '../checks/navigation';
import { CircularPreview } from '../preview/CircularPreview';
import { ToolIcon } from '../skin/ToolIcon';
import { SlidePathPicker } from './SlidePathPicker';
import { EditContextMenu, type EditContextMenuItem } from './EditContextMenu';
import { TouchSensorPicker } from './TouchSensorPicker';
import { useEditor } from './useEditor';
import { BpmProperties, MetadataProperties } from './Properties';
import { discardRecovery, downloadBytes as download, readChartFile, readRecovery, saveRecovery, type RecoveryReadResult } from '../files/index';

type DrawHandle = { draw(chartSeconds: number): void };
type Clipboard = { notes: Note[]; bpms: { beat: Rational; bpm: number }[]; origin: Rational };

export function App() {
  const [storageWarning, setStorageWarning] = useState('');
  const [recoveryOffer, setRecoveryOffer] = useState<RecoveryReadResult | null>(null);
  const [storedCheckpoint, setStoredCheckpoint] = useState<{ version: number; createdAt: string } | null>(null);
  const persistCheckpoint = useCallback(async (checkpoint: Checkpoint) => {
    try {
      await saveRecovery(checkpoint);
      setStoredCheckpoint({ version: checkpoint.document.version, createdAt: checkpoint.createdAt });
      setStorageWarning('');
    } catch (cause) { setStorageWarning(`本地恢复不可用：${cause instanceof Error ? cause.message : String(cause)}。仍可下载导出。`); }
  }, []);
  const editor = useEditor(persistCheckpoint);
  const [filename, setFilename] = useState('尚未打开谱面');
  const [difficulty, setDifficulty] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedBpmBeats, setSelectedBpmBeats] = useState<string[]>([]);
  const [tool, setTool] = useState<'select' | Exclude<Note['kind'], 'slide'> | 'slide'>('select');
  const [ringTool, setRingTool] = useState<'tap' | 'hold' | 'slide'>('tap');
  const [ringModifiers, setRingModifiers] = useState<Note['modifiers']>({ break: false, ex: false });
  const [ringForceStar, setRingForceStar] = useState(false);
  const [slideOneBeatStart, setSlideOneBeatStart] = useState(true);
  const [slideWifi, setSlideWifi] = useState(false);
  const [slideHead, setSlideHead] = useState<NonNullable<Note['slide']>['head']>('star');
  const [slideBreak, setSlideBreak] = useState(false);
  const [editMenu, setEditMenu] = useState<EditMenuRequest | null>(null);
  const [slidePathRequest, setSlidePathRequest] = useState<SlidePathRequest | null>(null);
  const [touchFirework, setTouchFirework] = useState(false);
  const [touchTool, setTouchTool] = useState<'touch' | 'touchHold'>('touch');
  const [touchArea, setTouchArea] = useState<NonNullable<Note['touchArea']>>('B');
  const [touchPosition, setTouchPosition] = useState(1);
  const [touchTime, setTouchTime] = useState<Rational | null>(null);
  const [snapDivision, setSnapDivision] = useState(4);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [audioState, setAudioState] = useState<AudioSnapshot | null>(null);
  const [waveform, setWaveform] = useState<WaveformPyramid | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(4);
  const audio = useRef<AudioTransport | null>(null);
  const clipboard = useRef<Clipboard | null>(null);
  const timeline = useRef<TimelineHandle>(null);
  const preview = useRef<DrawHandle>(null);
  const timeLabel = useRef<HTMLOutputElement>(null);
  const seekInput = useRef<HTMLInputElement>(null);
  const chartInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const lastAudioDocument = useRef('');
  const tabPreviewStart = useRef<number | null>(null);
  const audioLoadRequest = useRef(0);
  const snapshot = editor.snapshot;
  const chart = snapshot?.charts.find((item) => item.difficulty === difficulty);
  const selectedSet = new Set(selectedIds);
  const selected = chart?.notes.filter((note) => selectedSet.has(note.id)) ?? [];
  const selectedBpmSet = new Set(selectedBpmBeats);
  const selectedBpms = chart?.bpms.filter((event) => selectedBpmSet.has(rationalKey(event.beat))) ?? [];
  const note = selected.length === 1 ? selected[0] : undefined;
  const editable = Boolean(chart?.editable && !editor.workerFailed && !editor.busy);

  useEffect(() => { setEditMenu(null); }, [snapshot?.generation, snapshot?.version, difficulty, editor.documentChanging, editor.workerFailed]);
  useEffect(() => { setSelectedBpmBeats([]); }, [snapshot?.generation, difficulty]);

  const createAudio = useCallback(() => {
    audio.current?.dispose();
    const transport = new AudioTransport({ onChange: setAudioState });
    audio.current = transport;
    setAudioState(transport.getSnapshot());
    setWaveform(null);
    return transport;
  }, []);

  useEffect(() => {
    try {
      createAudio();
      const onVisibility = () => { if (document.hidden) audio.current?.pause(); };
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        audio.current?.dispose();
        audio.current = null;
      };
    } catch (cause) { setAudioError(String(cause)); }
  }, [createAudio]);

  useEffect(() => {
    void readRecovery().then(setRecoveryOffer).catch((cause) => setStorageWarning(`本地恢复不可用：${cause instanceof Error ? cause.message : String(cause)}。仍可下载导出。`));
  }, []);

  useEffect(() => { if (editor.workerFailed) audio.current?.pause(); }, [editor.workerFailed]);

  useEffect(() => {
    const transport = audio.current;
    if (!transport || !snapshot) return;
    tabPreviewStart.current = null;
    transport.pause();
    if (lastAudioDocument.current !== snapshot.generation || transport.getSnapshot().firstOffsetSeconds !== snapshot.firstSeconds) {
      transport.setLoop(null);
      transport.setFirstOffsetSeconds(snapshot.firstSeconds);
      lastAudioDocument.current = snapshot.generation;
    }
    transport.setCues(buildChartCues(chart?.notes ?? []));
    const liveIds = new Set(chart?.notes.map((item) => item.id));
    setSelectedIds((ids) => ids.filter((id) => liveIds.has(id)));
    const liveBpmBeats = new Set(chart?.bpms.map((event) => rationalKey(event.beat)));
    setSelectedBpmBeats((keys) => keys.filter((key) => liveBpmBeats.has(key)));
  }, [snapshot, chart]);

  useEffect(() => {
    if (snapshot?.charts.length && !snapshot.charts.some((item) => item.difficulty === difficulty)) {
      setDifficulty(snapshot.charts[0].difficulty);
    }
  }, [snapshot, difficulty]);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const state = audio.current?.getSnapshot();
      const seconds = state?.estimatedAudibleChartSeconds ?? state?.chartSeconds ?? 0;
      timeline.current?.draw(seconds);
      preview.current?.draw(seconds);
      if (timeLabel.current) timeLabel.current.textContent = `${seconds.toFixed(3)} s`;
      if (seekInput.current) seekInput.current.value = String(state?.chartSeconds ?? 0);
      if (state?.state === 'playing') frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [audioState, snapshot, difficulty, selectedIds]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (editor.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editor.dirty]);

  const pause = useCallback(() => audio.current?.pause(), []);
  const command = useCallback(async (value: EditCommand) => {
    pause();
    await editor.edit(value);
  }, [editor.edit, pause]);

  function report(cause: unknown) { editor.setError(cause instanceof Error ? cause.message : String(cause)); }
  function updateSelection(ids: string[], bpmBeats: string[]) {
    setSelectedIds(ids);
    setSelectedBpmBeats(bpmBeats);
  }
  function seek(seconds: number) { pause(); timeline.current?.locate(seconds); audio.current?.seekChartSeconds(seconds); }

  function scrubTimeline(deltaSeconds: number | null) {
    const transport = audio.current;
    const state = transport?.getSnapshot();
    if (!transport || !state || !chart) return;
    // Source SetTime ignores dragging during playback; UpdateAdsorption on release still runs.
    if (deltaSeconds !== null && state.state === 'playing') return;
    const target = deltaSeconds === null
      ? snapScrubTime(state.chartSeconds, chart.bpms, snapDivision)
      : state.chartSeconds + deltaSeconds;
    const minimum = state.track ? -state.firstOffsetSeconds : -2;
    const maximum = state.track ? state.track.durationSeconds - state.firstOffsetSeconds : maxSeconds;
    const seconds = Math.max(minimum, Math.min(maximum, target));
    timeline.current?.locate(seconds);
    transport.seekChartSeconds(seconds);
  }

  function advanceFastClock(deltaSeconds: number): number {
    const state = audio.current?.getSnapshot();
    if (!state) return 0;
    if (state.state === 'playing') return state.chartSeconds;
    let seconds = state.chartSeconds + deltaSeconds;
    if (state.track) seconds = Math.max(-state.firstOffsetSeconds,
      Math.min(state.track.durationSeconds - state.firstOffsetSeconds, seconds));
    seek(seconds);
    return seconds;
  }

  async function openChart(bytes: Uint8Array, name: string) {
    if (editor.dirty && !confirm('当前版本尚未导出。继续打开会替换当前文档，是否继续？')) return;
    pause();
    try {
      await editor.importBytes(bytes);
      setFilename(name);
      setRecoveryOffer(null);
      setSelectedIds([]);
      setSelectedBpmBeats([]);
      setDifficulty(1);
      audio.current?.seekChartSeconds(0);
    } catch (cause) { report(cause); }
  }

  async function openFiles(files: File[]) {
    const chartFile = files.find((file) => /\.txt$/i.test(file.name));
    if (chartFile) {
      await openChart(await readChartFile(chartFile), chartFile.name);
    }
    const song = files.find((file) => file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(file.name));
    if (song) {
      if (song.size > 128 * 1024 * 1024) { setAudioError('音频文件不能超过 128 MiB。'); return; }
      setAudioBusy(true);
      setAudioError('');
      setWaveform(null);
      const request = ++audioLoadRequest.current;
      const transport = audio.current;
      try {
        const result = await transport?.load(song, song.name);
        if (result?.status === 'rejected') throw result.error;
        if (result?.status === 'loaded') {
          const resultWaveform = await transport!.buildCurrentWaveform();
          if (request === audioLoadRequest.current && transport === audio.current) setWaveform(resultWaveform);
        }
      } catch (cause) { if (request === audioLoadRequest.current && transport === audio.current) setAudioError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (request === audioLoadRequest.current) setAudioBusy(false); }
    }
  }

  async function exportChart() {
    try {
      const result = await editor.exportCandidate();
      download(result.bytes, 'maidata.txt');
      editor.markExported(result);
    } catch (cause) { report(cause); }
  }

  async function restoreCheckpoint(saved: Checkpoint) {
    if (editor.dirty && !editor.workerFailed && !confirm('恢复会替换当前未导出版本，是否继续？')) return;
    pause();
    try {
      await editor.restore(saved);
      createAudio();
      setFilename('已恢复的谱面 · 请重新选择歌曲');
      setRecoveryOffer(null);
      setSelectedIds([]);
      setSelectedBpmBeats([]);
    } catch (cause) { report(cause); }
  }

  function copy() {
    if (!selected.length && !selectedBpms.length) return;
    const notes = selected.map(({ startSeconds: _s, endSeconds: _e, moveStartSeconds: _m, slidePaths: _paths, bpm: _b, isEach: _each, isSlideEach: _slideEach, ...item }) => structuredClone(item));
    const bpms = selectedBpms.map((event) => ({ beat: { ...event.beat }, bpm: event.bpm }));
    const beats = [...notes.map((item) => item.beat), ...bpms.map((event) => event.beat)];
    const origin = beats.reduce((min, beat) => compareRational(beat, min) < 0 ? beat : min, beats[0]);
    clipboard.current = { notes, bpms, origin };
  }

  function beginPaste() {
    if (!editable || !clipboard.current || (!clipboard.current.notes.length && !clipboard.current.bpms.length)) return;
    pause();
    timeline.current?.beginPaste(clipboard.current.notes, clipboard.current.bpms, clipboard.current.origin);
  }

  async function paste() {
    if (!editable || !chart || !clipboard.current) return;
    const cursor = secondsToBeat(Math.max(0, audio.current?.getSnapshot().chartSeconds ?? 0), chart.bpms);
    const target = rational(Math.max(0, Math.round(cursor * snapDivision)), snapDivision);
    const { notes, bpms, origin } = clipboard.current;
    const addNotes = notes.map(({ id: _id, order: _order, sourceRange: _range, ...item }) => ({
      ...item, beat: addRational(target, subtractRational(item.beat, origin)),
    }));
    const shiftedBpms = bpms.map((event) => ({ ...event,
      beat: addRational(target, subtractRational(event.beat, origin)) }));
    const mergedBpms = shiftedBpms.length ? mergeBpmEvents(chart.bpms, shiftedBpms) : undefined;
    if (addNotes.length || mergedBpms) await command({ type: 'edit-events', difficulty, addNotes,
      ...(mergedBpms ? { bpms: mergedBpms } : {}) });
  }

  async function deleteSelection() {
    if (!editable || !chart) return;
    const removeNoteIds = selected.map((item) => item.id);
    const protectedBeat = rationalKey(rational(0));
    const removableBpmBeats = new Set(selectedBpmBeats.filter((key) => key !== protectedBeat));
    const nextBpms = selectedBpmBeats.length
      ? chart.bpms.filter((event) => !removableBpmBeats.has(rationalKey(event.beat)))
      : undefined;
    if (!removeNoteIds.length && !nextBpms) {
      setSelectedIds([]);
      setSelectedBpmBeats([]);
      return;
    }
    if (nextBpms) await command({ type: 'edit-events', difficulty, removeNoteIds, bpms: nextBpms });
    else await command({ type: 'delete', difficulty, ids: removeNoteIds });
    setSelectedIds([]);
    setSelectedBpmBeats([]);
  }

  useEffect(() => {
    const endTabPreview = () => {
      const start = tabPreviewStart.current;
      if (start === null) return;
      tabPreviewStart.current = null;
      seek(start);
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable], [role="menu"]')) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === 'Tab' && !mod && !event.shiftKey && chart && !audioBusy && !editor.busy) {
        if (tabPreviewStart.current !== null) { event.preventDefault(); return; }
        if (event.repeat || audio.current?.getSnapshot().state !== 'paused') return;
        event.preventDefault();
        tabPreviewStart.current = audio.current.getSnapshot().chartSeconds;
        void audio.current.play().catch((cause) => { endTabPreview(); report(cause); });
      }
      else if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
      else if (!mod && (event.key === ',' || event.key === 'Backspace') && chart) {
        event.preventDefault();
        if (audio.current?.getSnapshot().state === 'playing') return;
        const beat = secondsToBeat(Math.max(0, audio.current?.getSnapshot().chartSeconds ?? 0), chart.bpms);
        const next = rational(Math.max(0, Math.round(beat * snapDivision) + (event.key === ',' ? 1 : -1)), snapDivision);
        seek(beatToSeconds(next, chart.bpms) - 0.0001);
      }
      else if (mod && (event.key.toLowerCase() === 'o' || event.key.toLowerCase() === 'p')) {
        event.preventDefault();
        const rates: PlaybackRate[] = [0.5, 1, 2];
        const index = rates.indexOf(audio.current?.getSnapshot().playbackRate ?? 1);
        audio.current?.setPlaybackRate(rates[Math.max(0, Math.min(2, index + (event.key.toLowerCase() === 'o' ? -1 : 1)))]);
      }
      else if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); void exportChart(); }
      else if (mod && event.key.toLowerCase() === 'c') { event.preventDefault(); copy(); }
      else if (mod && event.key.toLowerCase() === 'v') { event.preventDefault(); beginPaste(); }
      else if (mod && event.key.toLowerCase() === 'z' && !editor.busy) {
        event.preventDefault();
        void command({ type: event.shiftKey ? 'redo' : 'undo' }).catch(report);
      } else if (event.key === 'Delete' && editable && (selectedIds.length || selectedBpmBeats.length)) {
        event.preventDefault();
        void deleteSelection().catch(report);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || tabPreviewStart.current === null) return;
      event.preventDefault();
      endTabPreview();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', endTabPreview);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', endTabPreview);
    };
  });

  async function togglePlay() {
    try {
      if (audio.current?.getSnapshot().state === 'playing') pause();
      else if (!editor.busy) await audio.current?.play();
    } catch (cause) { setAudioError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function patchNote(patch: Partial<Pick<Note, 'beat' | 'position' | 'touchArea' | 'duration' | 'modifiers' | 'firework' | 'forceStar' | 'slide'>>) {
    if (note) void command({ type: 'update', difficulty, changes: [{ id: note.id, patch }] }).catch(report);
  }

  function navigateWarning(direction: -1 | 1) {
    if (!chart?.visualChecks?.available || editor.busy || editor.workerFailed) return;
    const target = adjacentWarningSeconds(chart.visualChecks.results, chart.bpms,
      audio.current?.getSnapshot().chartSeconds ?? 0, direction);
    if (target !== null) seek(target);
  }

  const canNavigateWarnings = Boolean(chart?.visualChecks?.available && chart.visualChecks.results.length && !editor.busy && !editor.workerFailed);
  const hasSelection = selected.length > 0 || selectedBpms.length > 0;
  const hasRingSelection = selected.some((item) => item.kind === 'tap' || item.kind === 'hold' || item.kind === 'slide');
  const hasSlideSelection = selected.some((item) => item.kind === 'slide');
  const menuItems: EditContextMenuItem[] = [
    { id: 'undo', label: '撤销', disabled: !snapshot?.canUndo || editor.busy || editor.workerFailed },
    { id: 'redo', label: '重做', disabled: !snapshot?.canRedo || editor.busy || editor.workerFailed },
    { id: 'all', label: '全选', separatorBefore: true, disabled: !chart?.notes.length },
    { id: 'none', label: '取消选择', disabled: !hasSelection },
    { id: 'copy', label: '复制', separatorBefore: true, disabled: !hasSelection },
    { id: 'cut', label: '剪切', disabled: !editable || !hasSelection },
    { id: 'paste', label: '粘贴', disabled: !editable || !(clipboard.current?.notes.length || clipboard.current?.bpms.length) },
    { id: 'delete', label: '删除', disabled: !editable || !hasSelection },
    ...([['mirror-horizontal', '左右镜像'], ['mirror-vertical', '上下镜像'],
      ['rotate-clockwise', '顺转 45°'], ['rotate-counterclockwise', '逆转 45°']] as const)
      .map(([id, label], index) => ({ id, label, separatorBefore: index === 0, disabled: !editable || !selected.length })),
    { id: 'break-on', label: '设为 Break', separatorBefore: true, disabled: !editable || !hasRingSelection },
    { id: 'break-off', label: '取消 Break', disabled: !editable || !hasRingSelection },
    { id: 'path-on', label: '设为路径 Break', disabled: !editable || !hasSlideSelection },
    { id: 'path-off', label: '取消路径 Break', disabled: !editable || !hasSlideSelection },
    { id: 'ex-on', label: '设为 EX', disabled: !editable || !hasRingSelection },
    { id: 'ex-off', label: '取消 EX', disabled: !editable || !hasRingSelection },
    { id: 'next-warning', label: '下一处告警', separatorBefore: true, disabled: !canNavigateWarnings },
    { id: 'previous-warning', label: '上一处告警', disabled: !canNavigateWarnings },
  ];

  async function runMenuAction(id: string) {
    const live = editor.getSnapshot();
    if (!editMenu || !live || live.generation !== editMenu.generation || live.version !== editMenu.version
      || difficulty !== editMenu.difficulty || menuItems.find((item) => item.id === id)?.disabled !== false) return;
    if (id === 'next-warning' || id === 'previous-warning') { navigateWarning(id === 'next-warning' ? 1 : -1); return; }
    if (id === 'all') { setSelectedIds(chart!.notes.map((item) => item.id)); setSelectedBpmBeats([]); return; }
    if (id === 'none') { setSelectedIds([]); setSelectedBpmBeats([]); return; }
    if (id === 'copy') { copy(); return; }
    if (id === 'paste') { beginPaste(); return; }
    if (id === 'undo' || id === 'redo') { await command({ type: id }); return; }
    if (id === 'cut' || id === 'delete') {
      if (id === 'cut') copy();
      await deleteSelection();
      return;
    }
    if (id === 'mirror-horizontal' || id === 'mirror-vertical' || id === 'rotate-clockwise' || id === 'rotate-counterclockwise') {
      await command({ type: 'update', difficulty, changes: transformNotes(selected, id) });
      return;
    }
    const enabled = id.endsWith('-on');
    const changes = selected.flatMap<Extract<EditCommand, { type: 'update' }>['changes'][number]>((item) => {
      if (id.startsWith('path-')) {
        if (!item.slide) return [];
        return [{ id: item.id, patch: { slide: { ...item.slide, slideBreak: enabled,
          ...(item.slide.additionalPaths ? { additionalPaths: item.slide.additionalPaths.map((path) => ({ ...path, slideBreak: enabled })) } : {}),
        } } }];
      }
      if (item.kind === 'touch' || item.kind === 'touchHold') return [];
      return [{ id: item.id, patch: { modifiers: { ...item.modifiers, [id.startsWith('break-') ? 'break' : 'ex']: enabled } } }];
    });
    if (changes.length) await command({ type: 'update', difficulty, changes });
  }

  const maxSeconds = (chart?.notes ?? []).reduce((end, item) => Math.max(end, item.endSeconds + 2), Math.max(5, (audioState?.track?.durationSeconds ?? 0) - (snapshot?.firstSeconds ?? 0)));
  const pausedSeconds = audioState?.chartSeconds ?? 0;

  return <div className="editor-shell" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
    event.preventDefault(); void openFiles(Array.from(event.dataTransfer.files)).catch(report);
  }}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">m</span><div><h1>maijdata</h1><p>谱面工作台</p></div></div>
      <div className="document-heading"><strong>{filename}</strong><span className={editor.dirty ? 'status dirty' : 'status'}>
        {editor.busy ? '正在处理…' : snapshot ? `v${snapshot.version} · ${editor.dirty ? '尚未导出' : editor.hasExported ? '该版本已导出' : '已导入 · 未修改'}` : '本地文件 · 无需上传'}
      </span></div>
      <div className="actions">
        <button onClick={() => void openChart(new TextEncoder().encode(sampleText), '自制验证示例')} disabled={editor.busy}>打开示例</button>
        <button onClick={() => chartInput.current?.click()} disabled={editor.busy}>打开谱面</button>
        <button onClick={() => audioInput.current?.click()}>选择歌曲</button>
        <button className="primary" onClick={() => void exportChart()} disabled={!snapshot || editor.busy || editor.workerFailed}>导出 maidata.txt</button>
      </div>
      <input ref={chartInput} type="file" accept=".txt" hidden aria-label="谱面文件" onChange={(event) => { void openFiles(Array.from(event.target.files ?? [])).catch(report); event.target.value = ''; }} />
      <input ref={audioInput} type="file" accept="audio/*" hidden aria-label="歌曲文件" onChange={(event) => { void openFiles(Array.from(event.target.files ?? [])).catch(report); event.target.value = ''; }} />
    </header>

    {(editor.error || audioError || editor.workerFailed) && <div role="alert" className="notice error">
      <span>{editor.error || audioError}</span>
      {editor.workerFailed && editor.checkpoint && <button onClick={() => void restoreCheckpoint(editor.checkpoint!)}>恢复内存检查点 v{editor.checkpoint.document.version}</button>}
      {editor.originalBytes && <button onClick={() => download(editor.originalBytes!, 'maidata-original.txt')}>下载原稿</button>}
      <button aria-label="关闭提示" onClick={() => { editor.setError(''); setAudioError(''); }}>×</button>
    </div>}

    {storageWarning && <div role="status" className="notice recovery-banner">{storageWarning}</div>}
    {recoveryOffer && recoveryOffer.status !== 'none' && <div className="notice recovery-banner">
      {recoveryOffer.status === 'available' ? <>
        <span>发现本地检查点：v{recoveryOffer.checkpoint.document.version} · {new Date(recoveryOffer.checkpoint.createdAt).toLocaleString()}。仅恢复到该版本，未确认修改及歌曲不在其中。</span>
        <button onClick={() => recoveryOffer.status === 'available' && void restoreCheckpoint(recoveryOffer.checkpoint)}>恢复项目</button>
      </> : <>
        <span>旧恢复数据不兼容：{recoveryOffer.reason}</span>
        {recoveryOffer.originalBytes && <button onClick={() => recoveryOffer.originalBytes && download(recoveryOffer.originalBytes, 'maidata-recovery-original.txt')}>下载恢复原稿</button>}
      </>}
      <button onClick={() => void discardRecovery().then(() => setRecoveryOffer(null)).catch((cause) => setStorageWarning(`无法丢弃恢复数据：${String(cause)}`))}>丢弃检查点</button>
    </div>}

    <main className="workspace">
      <section className="panel timeline-panel">
        <div className="panel-title"><h2>时间轴</h2><span>{chart ? `${chart.notes.length.toLocaleString()} 个音符` : '拖入谱面与歌曲即可开始'}</span></div>
        {snapshot && chart ? <Timeline ref={timeline} snapshot={snapshot} difficulty={difficulty} selectedIds={selectedIds}
          selectedBpmBeats={selectedBpmBeats}
          playheadSeconds={pausedSeconds} tool={tool} ringTool={ringTool} ringModifiers={ringModifiers} ringForceStar={ringForceStar}
          slideOneBeatStart={slideOneBeatStart} slideWifi={slideWifi} slideHead={slideHead} slideBreak={slideBreak}
          onSlidePathRequest={setSlidePathRequest} onEditMenu={setEditMenu} touchFirework={touchFirework}
          touchTool={touchTool} touchArea={touchArea} touchPosition={touchArea === 'C' ? 0 : touchPosition}
          onTouchTimeChange={setTouchTime} waveform={waveform} trackDurationSeconds={audioState?.track?.durationSeconds} snapDivision={snapDivision}
          editingDisabled={editor.workerFailed || editor.documentChanging}
          onCommand={command} getSnapshot={editor.getSnapshot} onSelection={updateSelection} onSeek={seek} onScrub={scrubTimeline}
          onAdvanceFastClock={advanceFastClock} onEditStart={pause} onError={editor.setError} />
          : <div className="empty-state"><div className="empty-ring">♪</div><h3>从一份谱面开始</h3><p>打开 maidata.txt，或使用自制样例体验编辑。</p><p>文件在浏览器本地处理。</p></div>}
      </section>

      <aside className="panel tools-panel">
        <div className="panel-title"><h2>工具与属性</h2></div>
        <div className="tool-content">
          <label>当前难度<select aria-label="当前难度" value={difficulty} disabled={!snapshot} onChange={(event) => { pause(); setDifficulty(Number(event.target.value)); setSelectedIds([]); setSelectedBpmBeats([]); }}>
            {(snapshot?.charts ?? [{ difficulty: 1 }]).map((item) => <option key={item.difficulty} value={item.difficulty}>难度 {item.difficulty}</option>)}
          </select></label>
          {chart && !chart.editable && <p className="notice">此难度只读，导出时保留原文。请查看下方诊断。</p>}
          {chart?.notes.some((note) => note.kind === 'slide') && <p className="notice">已识别 {chart.notes.filter((note) => note.kind === 'slide').length} 个 Slide 音符。支持基础路径及共享头编辑与原皮肤预览；目标原生兼容仍待验证。</p>}
          <div className="tool-buttons" aria-label="编辑工具">{(['select', 'tap', 'hold', 'touch', 'touchHold', 'slide'] as const).map((name) => <button key={name} className={tool === name ? 'active' : ''} disabled={name !== 'select' && !editable} onClick={() => {
            setTool(name);
            if (name === 'tap' || name === 'hold') setRingTool(name);
            if (name === 'slide') setRingTool('slide');
            if (name === 'touch' || name === 'touchHold') setTouchTool(name);
          }}>{name !== 'select' && <ToolIcon kind={name === 'slide' ? 'tap' : name} modifiers={name === 'tap' || name === 'hold' ? ringModifiers : undefined}
            forceStar={name === 'slide' || (name === 'tap' && ringForceStar)}
            onError={editor.setError} />}{{ select: '选择', tap: 'Tap', hold: 'Hold', touch: 'Touch', touchHold: 'Touch Hold', slide: 'Slide' }[name]}</button>)}</div>
          <fieldset>
            <legend>外圈工具属性</legend>
            <div className="form-row">
              <label className="inline-control"><input aria-label="工具 Break" type="checkbox" checked={ringModifiers.break}
                onChange={(event) => setRingModifiers((value) => ({ ...value, break: event.target.checked }))} />Break</label>
              <label className="inline-control"><input aria-label="工具 EX" type="checkbox" checked={ringModifiers.ex}
                onChange={(event) => setRingModifiers((value) => ({ ...value, ex: event.target.checked }))} />EX</label>
              <label className="inline-control"><input aria-label="工具星形 Tap" type="checkbox" checked={ringForceStar}
                onChange={(event) => setRingForceStar(event.target.checked)} />星形 Tap</label>
            </div>
          </fieldset>
          {tool === 'slide' && <fieldset>
            <legend>Slide 工具属性</legend>
            <p className="muted">先点起点。启用一拍起始后，默认等待一拍，再点终点；关闭后依次点击起点、等待结束点和终点。右键逐步回退。</p>
            <label className="inline-control"><input aria-label="Slide 一拍起始" type="checkbox" checked={slideOneBeatStart}
              onChange={(event) => setSlideOneBeatStart(event.target.checked)} />一拍起始等待</label>
            <label className="inline-control"><input aria-label="Slide WiFi" type="checkbox" checked={slideWifi}
              onChange={(event) => setSlideWifi(event.target.checked)} />Wi-Fi（终点自动取对面）</label>
            <div className="form-row">
              <label>Slide 头<select aria-label="Slide 头模板" value={slideHead} onChange={(event) => setSlideHead(event.target.value as NonNullable<Note['slide']>['head'])}>
                <option value="star">星形</option><option value="tap">Tap</option><option value="none">无头</option>
              </select></label>
              <label className="inline-control"><input aria-label="Slide Break" type="checkbox" checked={slideBreak}
                onChange={(event) => setSlideBreak(event.target.checked)} />Slide Break</label>
            </div>
          </fieldset>}
          <label className="inline-control"><input aria-label="工具 Touch 烟花" type="checkbox" checked={touchFirework} onChange={(event) => setTouchFirework(event.target.checked)} />Touch 工具：烟花</label>
          <p className="muted">中键应用工具属性：外圈 Break/EX、Tap 星形、Touch 烟花。Slide 头通过 Slide 工具模板设置。</p>
          {tool !== 'select' && <p className="muted">圆形区域：外圈 {ringTool === 'tap' ? 'Tap' : ringTool === 'hold' ? 'Hold' : 'Slide'} · 内圈 {touchTool === 'touch' ? 'Touch' : 'Touch Hold'}。暂停时按住左键跨区放置，右键跨区删除。</p>}
          {(tool === 'touch' || tool === 'touchHold') && <>
            <p className="muted">{touchTime ? `已选拍点 ${touchTime.numerator / touchTime.denominator}，点击传感器放置。` : '先在 Touch 轨选定时间，再点击传感器。'}</p>
            <TouchSensorPicker area={touchArea} position={touchArea === 'C' ? 0 : touchPosition}
              disabled={!editable || !touchTime} occupied={(chart?.notes ?? []).filter((item) => item.touchArea && touchTime && compareRational(item.beat, touchTime) === 0)
                .map((item) => item.touchArea === 'C' ? 'C' : `${item.touchArea}${item.position}`)}
              onChoose={(area, position) => {
                setTouchArea(area); if (position) setTouchPosition(position);
                timeline.current?.placeTouch(area, position);
              }} />
            <div className="form-row">
              <label>放置 Touch 区域<select aria-label="放置 Touch 区域" value={touchArea} onChange={(event) => setTouchArea(event.target.value as NonNullable<Note['touchArea']>)}>{['A', 'B', 'C', 'D', 'E'].map((area) => <option key={area}>{area}</option>)}</select></label>
              <label>传感器编号<select aria-label="放置 Touch 位置" value={touchArea === 'C' ? 0 : touchPosition} disabled={touchArea === 'C'} onChange={(event) => setTouchPosition(Number(event.target.value))}>
                {touchArea === 'C' ? <option value="0">C</option> : [1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value}>{value}</option>)}
              </select></label>
            </div>
            <button disabled={!editable || !touchTime} onClick={() => timeline.current?.placeTouch(touchArea, touchArea === 'C' ? 0 : touchPosition)}>在选定拍点放置</button>
          </>}
          <label>吸附<select value={snapDivision} onChange={(event) => setSnapDivision(Number(event.target.value))}>{[1, 2, 4, 8, 16].map((value) => <option key={value} value={value}>{value === 1 ? '每拍' : `1/${value} 拍`}</option>)}</select></label>
          {tool !== 'select' && <p className="muted">悬停在编号轨道后按住 ← / →：落点并移到相邻轨道，每次前进一格。Hold 快速放置为零时长；移动鼠标可重新定位。</p>}
          {tool === 'hold' && <p className="muted">依次点击起点和终点；右键取消当前绘制。</p>}
          {tool === 'touchHold' && <p className="muted">先选时间和传感器，再点击 Touch 轨的终点；右键取消。</p>}
          {tool === 'slide' && <p className="muted">单段路径候选支持 `-`、`&lt;`、`&gt;`、`v`、`s`、`z`；Wi-Fi 在终点点击时直接提交。在同拍同轨继续放置可追加共享头路径；连续路线可在路径面板追加段落。</p>}
          <div className="button-grid"><button disabled={!snapshot?.canUndo || editor.busy || editor.workerFailed} onClick={() => void command({ type: 'undo' }).catch(report)}>撤销 ⌘Z</button><button disabled={!snapshot?.canRedo || editor.busy || editor.workerFailed} onClick={() => void command({ type: 'redo' }).catch(report)}>重做 ⇧⌘Z</button><button disabled={!hasSelection} onClick={copy}>复制</button><button disabled={!editable} onClick={() => void paste().catch(report)}>粘贴至播放头</button></div>
          <hr /><h3>{selectedBpmBeats.length ? `选中 ${selected.length} 个音符和 ${selectedBpms.length} 个 BPM 事件` : `选中 ${selected.length} 个音符`}</h3>
          {selected.length > 1 && selected.some((item) => item.touchArea) && <div className="button-grid" aria-label="选择组内音符">
            {selected.filter((item) => item.touchArea).map((item) => <button key={item.id} onClick={() => updateSelection([item.id], [])}>
              选择 {item.touchArea === 'C' ? 'C' : `${item.touchArea}${item.position}`} · {item.startSeconds.toFixed(3)} s
            </button>)}
          </div>}
          {note ? <NoteProperties key={note.id} note={note} disabled={!editable} onChange={patchNote} onError={report} /> : <p className="muted">单击音符或左侧 BPM 标注可选择；拖动框选。0 拍 BPM 会保留。</p>}
          <button className="danger" disabled={!editable || !hasSelection} onClick={() => void deleteSelection().catch(report)}>{selectedBpmBeats.length ? '删除选中事件' : '删除选中音符'}</button>
          <div className="button-grid">{([['mirror-horizontal', '左右镜像'], ['mirror-vertical', '上下镜像'], ['rotate-counterclockwise', '逆转 45°'], ['rotate-clockwise', '顺转 45°']] as const).map(([operation, label]) => <button key={operation} disabled={!editable || !selected.length} onClick={() => { try { void command({ type: 'update', difficulty, changes: transformNotes(selected, operation) }).catch(report); } catch (cause) { report(cause); } }}>{label}</button>)}</div>
          {chart && <VisualChecks checks={chart.visualChecks} bpms={chart.bpms} onSeek={seek} onNavigate={navigateWarning} />}
          <hr /><h3>时间属性</h3>
          <label>谱面偏移 &first（秒）<input aria-label="谱面偏移" type="number" step="0.01" defaultValue={snapshot?.firstSeconds ?? 0} key={`${snapshot?.generation}:${snapshot?.firstSeconds}`} disabled={!snapshot || snapshot.charts.some((item) => !item.editable) || editor.busy} onBlur={(event) => { const seconds = Number(event.target.value); if (seconds !== snapshot?.firstSeconds) void command({ type: 'set-first', seconds }).catch(report); }} /></label>
          <p className="muted">歌曲位置 = 谱面时间 + 偏移。存在只读难度时禁止修改。</p>
          {chart && <BpmProperties chart={chart} disabled={!editable} onCommand={command} onError={report} />}
          {snapshot && <MetadataProperties snapshot={snapshot} difficulty={difficulty} disabled={!snapshot.metadataEditable || editor.busy || editor.workerFailed} onCommand={command} onError={report} />}
          <button onClick={() => setSourceOpen((open) => !open)} disabled={!editor.originalBytes}>{sourceOpen ? '收起原文' : '查看原文'}</button>
          {storedCheckpoint && <p className="muted">本地恢复：v{storedCheckpoint.version} · {new Date(storedCheckpoint.createdAt).toLocaleTimeString()}。这不表示已写回磁盘。</p>}
        </div>
      </aside>

      <section className="panel preview-panel">
        <div className="panel-title"><h2>圆形预览</h2><span>{snapshot ? `v${snapshot.version}` : '—'}</span></div>
        {snapshot ? <CircularPreview ref={preview} snapshot={snapshot} difficulty={difficulty} selectedIds={selectedIds} playheadSeconds={pausedSeconds}
          placing={tool !== 'select'} playing={audioState?.state === 'playing'} editingDisabled={editor.workerFailed || editor.documentChanging}
          onPlaceArea={(key, seconds) => timeline.current?.placeArea(key, seconds)}
          onRemoveArea={(key, seconds) => timeline.current?.removeArea(key, seconds)}
          onApplyAreaTemplate={(key: string, seconds: number) => timeline.current?.applyAreaTemplate(key, seconds)}
          onSelection={(ids) => updateSelection(ids, [])} onError={editor.setError} /> : <div className="preview-empty"><div className="empty-ring">8</div></div>}
        <div className="song-info"><strong>{audioBusy ? '正在解码歌曲…' : audioState?.track?.name ?? '未选择歌曲'}</strong><p>{audioState?.track ? `${audioState.track.durationSeconds.toFixed(1)} 秒 · ${audioState.track.sampleRateHz / 1000} kHz · ${audioState.track.channelCount} 声道` : '可先编辑谱面，以合成音试听。'}</p></div>
        <div className="diagnostics"><h3>诊断与范围</h3>{[...(snapshot?.diagnostics.filter((item) => item.difficulty === undefined) ?? []), ...(chart?.diagnostics ?? [])].map((item, index) => <p key={`${item.code}:${index}`} className="diagnostic">{item.code} · 字符 {item.range.start}–{item.range.end}<br />{item.message}</p>)}<p className="muted">已支持基础 Slide、共享头和单括号连续路线的本地编辑与原皮肤预览；现代逐段括号及未识别路径仍只读，目标原生兼容尚待验证。Touch Hold 进度环也尚待校准。</p></div>
      </section>
    </main>

    {editMenu && <EditContextMenu key={`${editMenu.generation}:${editMenu.version}:${editMenu.x}:${editMenu.y}`}
      position={editMenu} items={menuItems} onClose={() => setEditMenu(null)}
      onAction={(id) => void runMenuAction(id).catch(report)} />}

    {slidePathRequest && <SlidePathPicker request={slidePathRequest}
      onConfirm={(path, start, end, continuations) => timeline.current?.confirmSlide(path, start, end, continuations)} error={editor.error}
      onCancel={() => timeline.current?.cancelSlide()} />}

    {sourceOpen && <section className="source-panel"><div className="panel-title"><h2>导入原文</h2><button onClick={() => editor.originalBytes && void openChart(editor.originalBytes, filename)}>显式重新导入原稿</button><button onClick={() => editor.originalBytes && download(editor.originalBytes, 'maidata-original.txt')}>下载原稿</button></div><pre>{editor.originalBytes ? new TextDecoder().decode(editor.originalBytes) : ''}</pre></section>}

    <footer className="transport">
      <button className="play-button" onClick={() => void togglePlay()} disabled={!snapshot || audioBusy || (editor.busy && audioState?.state !== 'playing')}>{audioState?.state === 'playing' ? '暂停' : '播放'}</button>
      <output ref={timeLabel}>0.000 s</output>
      <input ref={seekInput} className="seek" aria-label="播放位置" type="range" min="-2" max={maxSeconds} step="0.001" defaultValue="0" onChange={(event) => seek(Number(event.target.value))} />
      <select aria-label="播放速度" value={audioState?.playbackRate ?? 1} onChange={(event) => audio.current?.setPlaybackRate(Number(event.target.value) as PlaybackRate)}>{[0.5, 1, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select>
      <label className="inline-control"><input type="checkbox" checked={Boolean(audioState?.loop)} onChange={(event) => { try { audio.current?.setLoop(event.target.checked ? { startChartSeconds: loopStart, endChartSeconds: loopEnd } : null); } catch (cause) { setAudioError(String(cause)); } }} />循环</label>
      <input aria-label="循环起点" className="small-number" type="number" value={loopStart} onChange={(event) => setLoopStart(Number(event.target.value))} /><span>—</span><input aria-label="循环终点" className="small-number" type="number" value={loopEnd} onChange={(event) => setLoopEnd(Number(event.target.value))} />
      <label className="calibration">设备校准 ms<input aria-label="设备校准" type="number" min="-2000" max="2000" step="10" defaultValue="0" onChange={(event) => { try { audio.current?.setOutputCalibrationSeconds(Number(event.target.value) / 1000); } catch (cause) { setAudioError(String(cause)); } }} /></label>
    </footer>
  </div>;
}

function NoteProperties({ note, disabled, onChange, onError }: { note: DisplayNote; disabled: boolean; onChange: (patch: Partial<Pick<Note, 'beat' | 'position' | 'touchArea' | 'duration' | 'modifiers' | 'firework' | 'forceStar' | 'slide'>>) => void; onError: (error: unknown) => void }) {
  const isTouch = note.kind === 'touch' || note.kind === 'touchHold';
  const isHold = note.kind === 'hold' || note.kind === 'touchHold';
  const slide = note.kind === 'slide' ? note.slide : undefined;
  const [selectedPath, setSelectedPath] = useState(0);
  const [routeNote, setRouteNote] = useState<DisplayNote | null>(null);
  const paths = slide ? [slide, ...(slide.additionalPaths ?? [])] : [];
  const pathIndex = Math.min(selectedPath, Math.max(0, paths.length - 1));
  const path = paths[pathIndex];
  const waitSeconds = path ? durationToSeconds(path.wait, note.bpm) : 0;
  const moveSeconds = path ? durationToSeconds(path.move, note.bpm) : 0;
  const updateSlide = (patch: Partial<SlidePathData>) => {
    if (!slide) return;
    if (pathIndex === 0) { onChange({ slide: { ...slide, ...patch } }); return; }
    onChange({ slide: { ...slide, additionalPaths: slide.additionalPaths!.map((item, index) =>
      index === pathIndex - 1 ? { ...item, ...patch } : item) } });
  };
  const removePath = () => {
    if (!slide || paths.length < 2) return;
    const remaining = paths.filter((_, index) => index !== pathIndex);
    const { command, endPosition, slideBreak, wait, move, continuations } = remaining[0];
    onChange({ slide: { head: slide.head, command, endPosition, slideBreak, wait, move, continuations,
      ...(remaining.length > 1 ? { additionalPaths: remaining.slice(1).map(({ command, endPosition, slideBreak, wait, move, continuations }) =>
        ({ command, endPosition, slideBreak, wait, move, continuations })) } : {}) } });
    setSelectedPath(Math.max(0, pathIndex - 1));
  };
  const updateSlideDuration = (field: 'wait' | 'move', seconds: number) => {
    if (!path) return;
    const originalSeconds = field === 'wait' ? waitSeconds : moveSeconds;
    if (seconds === originalSeconds) return;
    if (!Number.isFinite(seconds) || seconds < 0) {
      onError(new RangeError('Slide 时长必须是非负秒数。'));
      return;
    }
    let wait = path.wait;
    let move = path.move;
    if (field === 'wait') wait = { kind: 'seconds', seconds };
    else {
      move = { kind: 'seconds', seconds };
      const waitIsSerializableBeat = wait.kind === 'beatsAtBpm' && wait.division === 4 && wait.beats === 1;
      if (wait.kind !== 'seconds' && !waitIsSerializableBeat) {
        wait = { kind: 'seconds', seconds: waitSeconds };
      }
    }
    updateSlide({ wait, move });
  };
  const updatePosition = (position: number) => {
    if (position === note.position) return;
    if (!slide) { onChange({ position }); return; }
    if (!Number.isInteger(position) || position < 1 || position > 8) {
      onError(new RangeError('Slide 起点位置必须是 1 到 8 的整数。'));
      return;
    }
    const clockwise = (position - note.position + 8) % 8;
    const operation = clockwise <= 4 ? 'rotate-clockwise' : 'rotate-counterclockwise';
    const steps = clockwise <= 4 ? clockwise : 8 - clockwise;
    let transformed: Note = note;
    let patch: Pick<Note, 'position' | 'slide'> | undefined;
    for (let index = 0; index < steps; index += 1) {
      const change = transformNotes([transformed], operation)[0];
      if (!change) return;
      patch = change.patch;
      transformed = { ...transformed, ...change.patch };
    }
    if (patch) onChange(patch);
  };
  return <div className="note-properties" key={`${note.id}:${note.beat.numerator}:${note.position}:${JSON.stringify(slide)}:${pathIndex}`}>
    {isTouch && <label>Touch 区域<select aria-label="音符 Touch 区域" value={note.touchArea} disabled={disabled} onChange={(event) => { const area = event.target.value as NonNullable<Note['touchArea']>; onChange({ touchArea: area, position: area === 'C' ? 0 : note.position || 1 }); }}>{['A', 'B', 'C', 'D', 'E'].map((area) => <option key={area}>{area}</option>)}</select></label>}
    <div className="form-row"><label>{slide ? '起点位置（整体旋转）' : '位置'}<input aria-label="音符位置" type="number" min={note.touchArea === 'C' ? 0 : 1} max="8" defaultValue={note.position} disabled={disabled || note.touchArea === 'C'} onBlur={(event) => { updatePosition(Number(event.target.value)); }} /></label><label>拍点<input aria-label="音符拍点" type="number" min="0" step="0.25" defaultValue={note.beat.numerator / note.beat.denominator} disabled={disabled} onBlur={(event) => { try { const value = Number(event.target.value); if (value !== note.beat.numerator / note.beat.denominator) onChange({ beat: rationalFromNumber(value) }); } catch (cause) { onError(cause); } }} /></label></div>
    <p className="muted">{{ tap: 'Tap', hold: 'Hold', touch: 'Touch', touchHold: 'Touch Hold', slide: 'Slide' }[note.kind]}{isHold ? ` · 持续 ${(note.endSeconds - note.startSeconds).toFixed(3)} 秒` : ''}{slide ? ` · 等待 ${waitSeconds.toFixed(3)} 秒 · 移动 ${moveSeconds.toFixed(3)} 秒` : ''} · {note.startSeconds.toFixed(3)} 秒</p>
    {slide && path && <>
      {paths.length > 1 && <div className="form-row">
        <label>共享头路径<select aria-label="Slide 共享头路径" value={pathIndex} disabled={disabled} onChange={event => setSelectedPath(Number(event.target.value))}>
          {paths.map((item, index) => <option key={index} value={index}>路径 {index + 1} · {item.command}{item.endPosition}</option>)}
        </select></label>
        <button disabled={disabled} onClick={removePath}>删除当前路径</button>
      </div>}
      <div className="form-row">
        <label>{path.continuations?.length ? '首段路径' : '路径'}<select aria-label="Slide 路径" value={path.command} disabled={disabled || Boolean(path.continuations?.length)} onChange={(event) => {
          const command = event.target.value as NonNullable<Note['slide']>['command'];
          const distance = (path.endPosition - note.position + 8) % 8;
          const endPosition = ['w', 's', 'z'].includes(command) ? ((note.position - 1 + 4) % 8) + 1
            : command === 'v' && (distance === 0 || distance === 4) ? note.position % 8 + 1
              : path.endPosition;
          updateSlide({ command, endPosition });
        }}><option value="-">直线 -</option><option value="<">圆弧 &lt;</option><option value=">">圆弧 &gt;</option><option value="v">中心折线 v</option><option value="s">S形 s</option><option value="z">Z形 z</option><option value="w">Wi-Fi w</option></select></label>
        <label>{path.continuations?.length ? '首段终点' : '终点位置'}<input aria-label="Slide 终点位置" type="number" min="1" max="8" step="1" defaultValue={path.endPosition} disabled={disabled || ['w', 's', 'z'].includes(path.command) || Boolean(path.continuations?.length)} onBlur={(event) => { const endPosition = Number(event.target.value); if (endPosition !== path.endPosition) updateSlide({ endPosition }); }} /></label>
      </div>
      {path.command !== 'w' && <div className="form-row">
        <p className="muted">路线：{note.position}{path.command}{path.endPosition}{path.continuations?.map(segment => `${segment.command}${segment.endPosition}`).join('')} · {1 + (path.continuations?.length ?? 0)} 段</p>
        <button disabled={disabled} onClick={() => setRouteNote({ ...note, slide: { ...path, head: slide.head, additionalPaths: undefined }, slidePaths: undefined })}>编辑连续路线</button>
      </div>}
      <div className="form-row">
        <label>Slide 头<select aria-label="Slide 音符头" value={slide.head} disabled={disabled} onChange={(event) => onChange({ slide: { ...slide, head: event.target.value as NonNullable<Note['slide']>['head'] } })}>
          <option value="star">星形</option><option value="tap">Tap</option><option value="none">无头</option>
        </select></label>
        <label className="inline-control"><input aria-label="Slide 路径 Break" type="checkbox" checked={path.slideBreak} disabled={disabled} onChange={(event) => updateSlide({ slideBreak: event.target.checked })} />Slide Break</label>
      </div>
      <div className="form-row">
        <label>等待秒数<input aria-label="Slide 等待秒数" type="number" min="0" step="0.01" defaultValue={waitSeconds} disabled={disabled} onBlur={(event) => updateSlideDuration('wait', Number(event.target.value))} /></label>
        <label>总移动秒数<input aria-label="Slide 移动秒数" type="number" min="0" step="0.01" defaultValue={moveSeconds} disabled={disabled} onBlur={(event) => updateSlideDuration('move', Number(event.target.value))} /></label>
      </div>
      <p className="muted">在同拍同轨重新放置 Slide 可追加路径，共用现有音符头。路径属性只修改当前路径；起点、拍点和头部属性作用于整组。未修改时保留原有时长表达。</p>
    </>}
    {routeNote && <SlidePathPicker request={{ note: routeNote }} editRoute
      onCancel={() => setRouteNote(null)} onConfirm={(command, _start, endPosition, continuations) => {
        updateSlide({ command, endPosition, continuations: continuations?.length ? continuations : undefined });
        setRouteNote(null);
      }} />}
    <div className="form-row"><label className="inline-control"><input type="checkbox" checked={note.modifiers.break} disabled={disabled} onChange={(event) => onChange({ modifiers: { ...note.modifiers, break: event.target.checked } })} />Break</label><label className="inline-control"><input type="checkbox" checked={note.modifiers.ex} disabled={disabled || isTouch} onChange={(event) => onChange({ modifiers: { ...note.modifiers, ex: event.target.checked } })} />EX</label></div>
    {note.kind === 'tap' && <label className="inline-control"><input aria-label="音符星形 Tap" type="checkbox" checked={note.forceStar ?? false} disabled={disabled} onChange={(event) => onChange({ forceStar: event.target.checked })} />星形 Tap</label>}
    {isTouch && <label className="inline-control"><input aria-label="音符烟花" type="checkbox" checked={note.firework ?? false} disabled={disabled} onChange={(event) => onChange({ firework: event.target.checked })} />烟花</label>}
    {isHold && <label>改为固定秒数<input aria-label="Hold 固定秒数" type="number" min="0" step="0.1" defaultValue={note.endSeconds - note.startSeconds} disabled={disabled} onBlur={(event) => { const seconds = Number(event.target.value); if (seconds !== note.endSeconds - note.startSeconds) onChange({ duration: { kind: 'seconds', seconds } }); }} /></label>}
  </div>;
}
