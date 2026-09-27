import { Application, Graphics } from 'pixi.js';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { DisplayNote, Note, SlideSegmentData } from '../../../../packages/chart-core/src/types.js';
import { compileNote, rational } from '../../../../packages/chart-core/src/index.js';
import { previewTransform } from '../preview/place-area.js';
import { PixiNoteLayer, type SkinSpriteEntry } from '../skin/pixi.js';
import { PixiSlideLayer, preloadSlideTextures } from '../skin/pixi-slide.js';
import { iconFrame, notePlacement, ringRadius } from '../skin/composition.js';
import { slideHeadParts } from '../skin/slide-head.js';
import { resolvePath } from '../skin/slide-path.js';
import { selectSlideFromPath } from '../skin/slide-paint.js';
import parameters from '../skin/parameters.json';
import type { SlidePathRequest } from '../timeline/Timeline.js';
import './SlidePathPicker.css';

type SlidePathCommand = Exclude<NonNullable<Note['slide']>['command'], 'w'>;

interface SlidePathPickerProps {
  request: SlidePathRequest;
  onConfirm: (command: SlidePathCommand, start?: number, end?: number, continuations?: SlideSegmentData[]) => void;
  editRoute?: boolean;
  onCancel: () => void;
  error?: string;
}

interface PreviewResources {
  app: Application;
  board: Graphics;
  stroke: Graphics;
  paths: PixiSlideLayer;
  heads: PixiNoteLayer;
  width: number;
  height: number;
  texturesReady: boolean;
}

type PaintPoint = readonly [number, number];
interface PaintGesture { pointerId: number; press: PaintPoint; start: number | null; points: PaintPoint[] }
// Source reference layout: 590 UI units across, mapped to a 10-unit drawing plane.
const PAINT_START_DISTANCE = 20 / 590 * 10;

export function SlidePathPicker({ request, onConfirm, onCancel, error, editRoute = false }: SlidePathPickerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const resourcesRef = useRef<PreviewResources | null>(null);
  const firstCandidateRef = useRef<HTMLButtonElement | null>(null);
  const repaintRef = useRef<() => void>(() => {});
  const latestPreview = useRef<DisplayNote | null>(null);
  const painting = useRef<PaintGesture | null>(null);
  const [paintMessage, setPaintMessage] = useState('');
  const [chainMode, setChainMode] = useState(editRoute);
  const [segments, setSegments] = useState<SlideSegmentData[]>(() => editRoute && request.note.slide && request.note.slide.command !== 'w'
    ? [{ command: request.note.slide.command, endPosition: request.note.slide.endPosition }, ...(request.note.slide.continuations ?? [])] : []);
  const [nextEnd, setNextEnd] = useState(request.note.slide?.endPosition ?? 5);
  const nextStart = segments.at(-1)?.endPosition ?? request.note.position;
  const candidateNote = useMemo(() => chainMode ? { ...request.note, position: nextStart,
    slide: { ...request.note.slide!, endPosition: nextEnd, continuations: undefined, additionalPaths: undefined } } : request.note,
  [chainMode, request.note, nextStart, nextEnd]);
  const candidates = useMemo(() => pathCandidates(candidateNote), [candidateNote]);
  const [previewCommand, setPreviewCommand] = useState<SlidePathCommand | null>(candidates[0] ?? null);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const previewNotes = useMemo(() => candidates.map((command) => previewNote(candidateNote, command)), [candidates, candidateNote]);
  const currentNote = useMemo(() => {
    if (!chainMode) return previewCommand ? previewNotes.find((note) => note.slide?.command === previewCommand) ?? null : null;
    const shown = [...segments, ...(previewCommand && candidates.includes(previewCommand) ? [{ command: previewCommand, endPosition: nextEnd }] : [])];
    if (!shown.length) return null;
    return compileNote({ ...request.note, beat: rational(2), slide: { ...request.note.slide!, ...shown[0],
      additionalPaths: undefined, continuations: shown.slice(1), wait: { kind: 'seconds', seconds: 0.25 },
      move: { kind: 'seconds', seconds: 1 } } }, [{ beat: rational(0), bpm: 120 }]);
  }, [chainMode, segments, previewCommand, nextEnd, request.note, previewNotes, candidates]);
  const acceptPath = (command: SlidePathCommand, start = candidateNote.position, end = candidateNote.slide!.endPosition) => {
    if (!chainMode) { onConfirm(command, start, end); return; }
    if (start !== nextStart) { setPaintMessage(`下一段必须从轨道 ${nextStart} 开始。`); return; }
    if (segments.length >= 64) { setPaintMessage('一条连续路线最多 64 段。'); return; }
    setSegments([...segments, { command, endPosition: end }]);
    setPreviewCommand(null);
    setPaintMessage('');
  };
  const confirmRoute = () => {
    if (segments.length) onConfirm(segments[0].command, request.note.position, segments[0].endPosition, segments.slice(1));
  };
  const undoSegment = () => { if (!painting.current) { setSegments(segments.slice(0, -1)); setPreviewCommand(null); } };
  latestPreview.current = currentNote;

  useEffect(() => {
    setPreviewCommand(chainMode ? null : candidates[0] ?? null);
  }, [request.note, candidates, chainMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let initialized = false;
    let destroyed = false;
    let resources: PreviewResources | null = null;
    const app = new Application();
    const destroyApplication = () => {
      if (!initialized || destroyed) return;
      destroyed = true;
      resources?.paths.destroy();
      resources?.heads.destroy();
      app.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
    };

    const repaint = () => {
      if (!resources || resourcesRef.current !== resources) return;
      const { width, height, stroke } = resources;
      const transform = previewTransform(width, height);
      resources.board.clear();
      resources.board.circle(transform.x, transform.y, Math.min(width, height) * 0.47).fill({ color: 0x141b26 });
      resources.board.circle(transform.x, transform.y, ringRadius * transform.scale)
        .stroke({ color: 0x556a80, width: 2 });
      resources.board.circle(transform.x, transform.y, ringRadius * transform.scale * 0.54)
        .stroke({ color: 0x34465b, width: 1 });
      stroke.clear();
      const points = painting.current?.points ?? [];
      points.forEach(([x, y], index) => {
        if (index === 0) stroke.moveTo(transform.x + x * transform.scale, transform.y - y * transform.scale);
        else stroke.lineTo(transform.x + x * transform.scale, transform.y - y * transform.scale);
      });
      if (points.length > 1) stroke.stroke({ color: 0xffffff, width: 2 });
      const note = latestPreview.current;
      if (!resources.texturesReady) {
        resources.app.render();
        return;
      }
      if (note?.slide) {
        resources.paths.render([note], note.moveStartSeconds!, transform.x, transform.y, transform.scale, false);
        const parts = slideHeadParts(note, iconFrame);
        const head: SkinSpriteEntry[] = parts.length ? [{
          id: `${note.id}:picker-head`, parts, placement: notePlacement(note, iconFrame),
        }] : [];
        resources.heads.renderParts(head, transform.x, transform.y, transform.scale);
      } else {
        resources.paths.render([], 0, transform.x, transform.y, transform.scale, false);
        resources.heads.renderParts([], transform.x, transform.y, transform.scale);
      }
      resources.app.render();
    };
    repaintRef.current = repaint;
    setPreviewReady(false);
    setPreviewError('');

    void app.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      autoStart: false,
      antialias: true,
      backgroundColor: 0x10141d,
      preference: 'webgl',
    }).then(async () => {
      initialized = true;
      if (cancelled) { destroyApplication(); return; }
      app.ticker.stop();
      host.appendChild(app.canvas);
      const board = new Graphics();
      const stroke = new Graphics();
      const paths = new PixiSlideLayer();
      const heads = new PixiNoteLayer();
      app.stage.addChild(board, paths.container, heads.container, stroke);
      resources = {
        app, board, paths, heads, stroke,
        width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight),
        texturesReady: false,
      };
      resourcesRef.current = resources;
      await preloadSlideTextures(previewNotes);
      if (cancelled || resourcesRef.current !== resources) return;
      resources.texturesReady = true;
      setPreviewReady(true);
      repaint();
    }).catch((cause: unknown) => {
      if (resourcesRef.current === resources) resourcesRef.current = null;
      if (!cancelled) setPreviewError(cause instanceof Error ? cause.message : String(cause));
      destroyApplication();
    });

    const observer = new ResizeObserver(() => {
      if (!resources) return;
      resources.width = Math.max(1, host.clientWidth);
      resources.height = Math.max(1, host.clientHeight);
      resources.app.renderer.resize(resources.width, resources.height);
      repaint();
    });
    observer.observe(host);

    return () => {
      cancelled = true;
      observer.disconnect();
      repaintRef.current = () => {};
      resourcesRef.current = null;
      destroyApplication();
    };
  }, [request.note]);

  useEffect(() => { repaintRef.current(); }, [currentNote, previewReady]);
  useEffect(() => { firstCandidateRef.current?.focus(); }, [request.note]);
  useEffect(() => {
    const cancelGesture = () => { painting.current = null; repaintRef.current(); };
    window.addEventListener('blur', cancelGesture);
    return () => window.removeEventListener('blur', cancelGesture);
  }, []);

  const paintPoint = (event: PointerEvent<HTMLDivElement>): PaintPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const transform = previewTransform(bounds.width, bounds.height);
    return [(event.clientX - bounds.left - transform.x) / transform.scale,
      -(event.clientY - bounds.top - transform.y) / transform.scale];
  };
  const beginPaint = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !previewReady) return;
    const point = paintPoint(event);
    const radius = Math.hypot(...point);
    if (radius <= 10 / 3 || radius >= 5) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    painting.current = { pointerId: event.pointerId, press: point, start: null, points: [] };
    setPaintMessage('');
  };
  const movePaint = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = painting.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = paintPoint(event);
    if (gesture.start === null) {
      if (Math.hypot(point[0] - gesture.press[0], point[1] - gesture.press[1]) <= PAINT_START_DISTANCE) return;
      gesture.start = nearestTrack(point);
      if (chainMode && gesture.start !== nextStart) {
        painting.current = null;
        setPaintMessage(`下一段必须从轨道 ${nextStart} 开始。`);
        return;
      }
      gesture.points = [trackPoint(gesture.start)];
      setPreviewCommand(null);
    } else {
      const previous = gesture.points.at(-1)!;
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 0.03) return;
      gesture.points.push(point);
    }
    repaintRef.current();
  };
  const endPaint = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = painting.current;
    if (!gesture || gesture.pointerId !== event.pointerId || event.button !== 0) return;
    painting.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture.start !== null) {
      const end = nearestTrack(paintPoint(event));
      gesture.points.push(trackPoint(end));
      const match = selectSlideFromPath(gesture.points, gesture.start, end);
      if (match?.supported) acceptPath(match.command as SlidePathCommand, gesture.start, end);
      else setPaintMessage(match ? `识别为 ${gesture.start}${match.command}${match.middle ?? ''}${end}，该路径尚未开放编辑。请重新绘制，或使用原起终点的候选按钮。`
        : '未找到路径候选，请重新绘制。');
    }
    repaintRef.current();
  };
  const cancelPaint = () => { painting.current = null; repaintRef.current(); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        painting.current = null;
        onCancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (!painting.current) { if (chainMode) confirmRoute(); else if (previewCommand) acceptPath(previewCommand); }
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => event.stopImmediatePropagation();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [onCancel, onConfirm, previewCommand, chainMode, segments, candidateNote]);

  const clearPreview = (event: MouseEvent) => {
    event.preventDefault();
    if (painting.current && painting.current.start !== null) return;
    if (previewCommand) setPreviewCommand(null);
    else if (chainMode) undoSegment();
  };

  return <div className="slide-picker-backdrop" onContextMenu={clearPreview}>
    <section ref={dialogRef} className="slide-picker" role="dialog" aria-modal="true" aria-labelledby="slide-picker-title">
      <header className="slide-picker-header">
        <div><h2 id="slide-picker-title">{chainMode ? '编辑连续路线' : '选择 Slide 路径'}</h2><p>起点 {request.note.position} → {chainMode ? `下一段起点 ${nextStart}` : `终点 ${request.note.slide?.endPosition ?? '—'}`}</p></div>
        <button aria-label="取消 Slide 路径选择" onClick={onCancel}>×</button>
      </header>
      <p className="muted">{chainMode ? '每次手绘或点击候选追加一段。各段首尾相接，共用当前等待和总移动时长；右键先清除候选预览，再撤回末段；Enter 保存整条路线，Esc 放弃草稿。' : '从外圈按住拖画路径，松开后匹配并提交；手绘可重新确定起终点。也可悬停预览、点击候选提交。Enter 确认，Esc 取消。'}</p>
      {!editRoute && <label className="inline-control"><input aria-label="连续路线模式" type="checkbox" checked={chainMode} onChange={event => { setChainMode(event.target.checked); setSegments([]); }} />连续路线</label>}
      {chainMode && <div className="slide-route-controls">
        <output aria-label="连续路线草稿">{request.note.position}{segments.map(segment => `${segment.command}${segment.endPosition}`).join('')} · {segments.length} 段</output>
        <label>下一段终点<select aria-label="下一段终点" value={nextEnd} onChange={event => setNextEnd(Number(event.target.value))}>{[1,2,3,4,5,6,7,8].map(lane => <option key={lane}>{lane}</option>)}</select></label>
        <button disabled={!segments.length} onClick={undoSegment}>撤回末段</button>
      </div>}
      <div ref={hostRef} className="slide-picker-preview" data-preview-ready={previewReady} data-skin-ready={previewReady} aria-label="Slide 原皮肤路径预览"
        onPointerDown={beginPaint} onPointerMove={movePaint} onPointerUp={endPaint}
        onPointerCancel={cancelPaint} onLostPointerCapture={cancelPaint}>
        <div className="slide-picker-tracks" aria-hidden="true">{parameters.tracks.map((track, index) =>
          <span key={index} style={{ left: `${50 + track.position[0] / ringRadius * 41}%`,
            top: `calc(${50 - track.position[1] / ringRadius * 41}% + 4px)` }}>{index + 1}</span>)}</div>
        {!previewReady && !previewError && <span className="slide-picker-status">正在载入原皮肤…</span>}
        {previewError && <span className="slide-picker-status error">路径预览加载失败：{previewError}</span>}
        {!candidates.length && <span className="slide-picker-status error">该起终点没有可用的单段路径。</span>}
      </div>
      {(paintMessage || error) && <p className="slide-picker-message" role="status">{paintMessage || error}</p>}
      <div className="slide-picker-paths" aria-label="可用路径">
        {candidates.map((command, index) => <button key={command} ref={index === 0 ? firstCandidateRef : undefined}
          className={previewCommand === command ? 'selected' : ''} aria-pressed={previewCommand === command}
          onMouseEnter={() => setPreviewCommand(command)} onFocus={() => setPreviewCommand(command)}
          onClick={() => acceptPath(command)}>{({ '-': '直线 -', '<': '圆弧 <', '>': '圆弧 >', v: '中心折线 v', s: 'S形 s', z: 'Z形 z' })[command]}</button>)}
      </div>
      <footer className="slide-picker-actions">
        <button onClick={() => chainMode ? confirmRoute() : previewCommand && acceptPath(previewCommand)} disabled={chainMode ? !segments.length : !previewCommand}>{chainMode ? '保存整条路线' : '确认当前路径'}</button>
        <button onClick={onCancel}>取消放置</button>
      </footer>
    </section>
  </div>;
}

function trackPoint(track: number): PaintPoint {
  const point = parameters.tracks[track - 1].position;
  return [point[0], point[1]];
}

function nearestTrack(point: PaintPoint): number {
  let nearest = 1;
  let distance = Infinity;
  parameters.tracks.forEach((track, index) => {
    const next = Math.hypot(track.position[0] - point[0], track.position[1] - point[1]);
    if (next <= distance) { nearest = index + 1; distance = next; }
  });
  return nearest;
}

function pathCandidates(note: DisplayNote): SlidePathCommand[] {
  if (note.kind !== 'slide' || !note.slide) return [];
  const distance = (note.slide.endPosition - note.position + 8) % 8;
  return (['-', '<', '>', 'v', 's', 'z'] as const).filter((command) => {
    if (command === '-' && (distance < 2 || distance > 6)) return false;
    try { resolvePath(command, note.position, note.slide!.endPosition); return true; }
    catch { return false; }
  });
}

function previewNote(note: DisplayNote, command: SlidePathCommand): DisplayNote {
  if (note.kind !== 'slide' || !note.slide) return note;
  return compileNote({ ...note, beat: rational(2), slide: { ...note.slide, command,
    additionalPaths: undefined, continuations: undefined, wait: { kind: 'seconds', seconds: 0.25 },
    move: { kind: 'seconds', seconds: 1 } } }, [{ beat: rational(0), bpm: 120 }]);
}
