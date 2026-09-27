import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import {
  addRational,
  beatToSeconds,
  bpmAtBeat,
  compareRational,
  compileNote,
  holdDurationSeconds,
  mergeBpmEvents,
  queryVisible,
  rational,
  rationalKey,
  secondsToBeat,
  subtractRational,
  transformNotes,
} from '../../../../packages/chart-core/src/index.js';
import type {
  BpmEvent,
  DisplayChart,
  DisplayNote,
  DisplaySlideSegment,
  DisplaySnapshot,
  EditCommand,
  HoldDuration,
  Note,
  Rational,
  SlideData,
  SlideSegmentData,
} from '../../../../packages/chart-core/src/types.js';
import type { WaveformPyramid } from '../audio/waveform.js';
import { coreSkinKeys, loadSkinImages } from '../skin/assets.js';
import { drawNoteGlyph, drawSkinPartsGlyph } from '../skin/canvas.js';
import { iconFrame } from '../skin/composition.js';
import { slideHeadParts } from '../skin/slide-head.js';
import { displaySlidePaths } from '../skin/display-slide-paths.js';
import { drawTouchFireworkMarker } from '../skin/touch-firework.js';
import { fastPlacementStep } from './fast-placement.js';
import { beginSlidePlacement, advanceSlidePlacement, rewindSlidePlacement, finishSlidePlacement, type SlidePlacement, type SlidePlacementSettings } from './slide-placement.js';
import { groupWarningMarkers, type WarningMarker } from '../checks/warning-markers';
import { warningMessages } from '../checks/messages';
import { drawWarningTrack, hitWarning, WARNING_TRACK_WIDTH, type VisibleWarning } from './warning-track';
import './Timeline.css';

const TOP = 52;
const BOTTOM = 22;
const LABEL_WIDTH = 40;
const PLAYHEAD_FROM_BOTTOM = 200;
const MIN_SCALE = 24;
const MAX_SCALE = 384;
const DEFAULT_SCALE = 300;
const LANE_COUNT = 8;
const LANE_ORDER = [8, 7, 6, 5, 4, 3, 2, 1] as const;
type TouchArea = NonNullable<Note['touchArea']>;
type PlaceTool = Note['kind'];

export interface SlidePathRequest {
  note: DisplayNote;
}

export interface EditMenuRequest {
  x: number;
  y: number;
  generation: string;
  version: number;
  difficulty: number;
}

export interface TimelineHandle {
  draw(chartSeconds: number): void;
  locate(chartSeconds: number): void;
  placeTouch(area: TouchArea, position: number): void;
  placeArea(key: string, chartSeconds: number): void;
  removeArea(key: string, chartSeconds: number): void;
  applyAreaTemplate(key: string, chartSeconds: number): void;
  confirmSlide(command: NonNullable<Note['slide']>['command'], startPosition?: number, endPosition?: number, continuations?: SlideSegmentData[]): void;
  cancelSlide(): void;
  beginPaste(notes: Note[], bpms: BpmEvent[], origin: Rational): void;
}

export interface TimelineProps {
  snapshot: DisplaySnapshot | null;
  difficulty: number;
  tool: 'select' | PlaceTool;
  ringTool: 'tap' | 'hold' | 'slide';
  ringModifiers: Note['modifiers'];
  ringForceStar: boolean;
  slideOneBeatStart: boolean;
  slideWifi: boolean;
  slideHead: NonNullable<Note['slide']>['head'];
  slideBreak: boolean;
  onSlidePathRequest: (request: SlidePathRequest | null) => void;
  onEditMenu: (request: EditMenuRequest | null) => void;
  touchTool: 'touch' | 'touchHold';
  touchFirework: boolean;
  touchArea: TouchArea;
  touchPosition: number;
  selectedIds: string[];
  selectedBpmBeats: string[];
  playheadSeconds?: number;
  waveform?: WaveformPyramid | null;
  trackDurationSeconds?: number;
  snapDivision?: number;
  editingDisabled?: boolean;
  /** Synchronous Worker-owned snapshot; null means a document replacement is in flight. */
  getSnapshot: () => DisplaySnapshot | null;
  onCommand: (command: EditCommand) => Promise<void>;
  onSelection: (ids: string[], bpmBeats: string[]) => void;
  onTouchTimeChange: (beat: Rational | null) => void;
  onSeek: (chartSeconds: number) => void;
  /** Incremental middle drag; null applies the release-time beat snap without changing playback state. */
  onScrub: (deltaSeconds: number | null) => void;
  onAdvanceFastClock: (deltaSeconds: number) => number;
  onEditStart?: () => void;
  onError?: (message: string) => void;
}

interface Viewport {
  /** Seconds mapped to the playhead reference line. */
  viewSeconds: number;
  pixelsPerSecond: number;
}

interface LaneRect {
  position: number;
  left: number;
  right: number;
  center: number;
}

interface Geometry {
  width: number;
  height: number;
  gridLeft: number;
  gridRight: number;
  ringRight: number;
  gridWidth: number;
  gridTop: number;
  gridBottom: number;
  laneWidth: number;
  laneOrder: readonly number[];
  lanes: LaneRect[];
  touchTrackLeft: number;
  touchTrackWidth: number;
  touchTrackCenter: number;
  playheadY: number;
}

interface Point {
  x: number;
  y: number;
  chartSeconds: number;
  beat: number;
  snappedBeat: Rational;
  lane: number;
  touchTrack: boolean;
}

type HoldEdge = 'start' | 'end';
type Gesture =
  | { kind: 'place'; pointerId: number; start: Point; current: Point; noteKind: PlaceTool }
  | { kind: 'paste'; pointerId: number; start: Point; current: Point }
  | { kind: 'touch-time'; pointerId: number; start: Point; current: Point }
  | { kind: 'box'; pointerId: number; start: Point; current: Point; additive: boolean }
  | {
      kind: 'move'; pointerId: number; start: Point; current: Point; notes: DisplayNote[];
      edge: HoldEdge | null; deltaBeat: Rational; deltaLane: number; moved: boolean;
    }
  | { kind: 'pan'; pointerId: number; start: Point; lastY: number; scale: number; moved: boolean; templateId?: string };

interface PendingHold {
  kind: 'hold' | 'touchHold';
  beat: Rational;
  position: number;
  touchArea?: TouchArea;
  generation: string;
  difficulty: number;
  epoch: number;
}

interface ActionContext {
  generation: string;
  difficulty: number;
  epoch: number;
}

interface DocumentContext extends ActionContext {
  version: number;
}

interface PendingPaste {
  notes: Note[];
  bpms: BpmEvent[];
  origin: Rational;
  context: DocumentContext;
}

interface RightClickGesture {
  pointerId: number;
  sequence: number;
  context: DocumentContext | null;
  blank: boolean;
  moved: boolean;
  startX: number;
  startY: number;
}

type AreaTarget = { kind: 'ring'; position: number }
  | { kind: 'touch'; area: TouchArea; position: number };
type AreaIntent = {
  kind: 'place' | 'remove' | 'template';
  target: AreaTarget;
  beat: Rational;
  context: ActionContext;
  familyTool: PlaceTool;
  modifiers: Note['modifiers'];
  firework: boolean;
  forceStar: boolean;
  slideOneBeatStart: boolean;
  slideWifi: boolean;
  slideSettings: SlidePlacementSettings;
};

interface PaintProps {
  snapshot: DisplaySnapshot | null;
  difficulty: number;
  selectedIds: string[];
  selectedBpmBeats: string[];
  tool: 'select' | PlaceTool;
  ringTool: 'tap' | 'hold' | 'slide';
  ringModifiers: Note['modifiers'];
  ringForceStar: boolean;
  slideHead: NonNullable<Note['slide']>['head'];
  slideBreak: boolean;
  slideWifi: boolean;
  touchTool: 'touch' | 'touchHold';
  touchFirework: boolean;
  touchArea: TouchArea;
  touchPosition: number;
  waveform?: WaveformPyramid | null;
  trackDurationSeconds?: number;
  snapDivision?: number;
}

export const Timeline = forwardRef<TimelineHandle, TimelineProps>(function Timeline(props, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const warningTooltip = useRef<HTMLDivElement | null>(null);
  const warningCache = useRef<{ chart: DisplayChart | null; markers: WarningMarker[] }>({ chart: null, markers: [] });
  const visibleWarnings = useRef<VisibleWarning[]>([]);
  const latestProps = useRef(props);
  latestProps.current = props;
  const viewport = useRef<Viewport>({ viewSeconds: 0, pixelsPerSecond: DEFAULT_SCALE });
  const viewportGeneration = useRef<string | null>(null);
  const previousDifficulty = useRef(props.difficulty);
  const previousTool = useRef(props.tool);
  const gesture = useRef<Gesture | null>(null);
  const pendingRingHold = useRef<PendingHold | null>(null);
  const pendingTouchHold = useRef<PendingHold | null>(null);
  const pendingSlide = useRef<{ state: SlidePlacement; context: ActionContext } | null>(null);
  const pendingPaste = useRef<PendingPaste | null>(null);
  const rightClickGesture = useRef<RightClickGesture | null>(null);
  const pointerSequence = useRef(0);
  const observedDocument = useRef({ generation: props.snapshot?.generation ?? null,
    version: props.snapshot?.version ?? null, difficulty: props.difficulty });
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  const queuedInputCount = useRef(0);
  const actionEpoch = useRef(0);
  const selectedTouchBeat = useRef<Rational | null>(null);
  const hoverPoint = useRef<Point | null>(null);
  const fastCursor = useRef<Point | null>(null);
  const fastKeys = useRef(new Set<string>());
  const fastFrame = useRef(0);
  const lastFastAt = useRef(-Infinity);
  const fastStep = useRef<(direction: 'left' | 'right') => boolean>(() => false);
  const fastEligible = useRef<() => boolean>(() => false);
  const lastChartSeconds = useRef(0);
  const followOffsetSeconds = useRef(0);
  const skinImages = useRef<Map<string, HTMLImageElement> | null>(null);

  const repaint = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const geometry = getGeometry(width, height);
    canvas.dataset.viewSeconds = String(viewport.current.viewSeconds);
    canvas.dataset.pixelsPerSecond = String(viewport.current.pixelsPerSecond);
    canvas.dataset.playheadY = String(geometry.playheadY);
    canvas.dataset.gridLeft = String(geometry.gridLeft);
    canvas.dataset.trackWidth = String(geometry.gridWidth);
    canvas.dataset.laneWidth = String(geometry.laneWidth);
    canvas.dataset.laneOrder = geometry.laneOrder.join(',');
    canvas.dataset.laneCenters = geometry.lanes.map((lane) => lane.center).join(',');
    canvas.dataset.touchTrackLeft = String(geometry.touchTrackLeft);
    canvas.dataset.touchTrackWidth = String(geometry.touchTrackWidth);
    canvas.dataset.touchTrackCenter = String(geometry.touchTrackCenter);
    const chart = latestChart(latestProps.current);
    if (fastCursor.current && chart) {
      const seconds = Math.max(0, secondsAtY(fastCursor.current.y, geometry, viewport.current));
      const beat = secondsToBeat(seconds, chart.bpms);
      fastCursor.current = { ...fastCursor.current, chartSeconds: seconds, beat,
        snappedBeat: snapBeat(beat, validDivision(latestProps.current.snapDivision)) };
    }
    canvas.dataset.fastLane = fastCursor.current ? String(fastCursor.current.lane) : '';
    canvas.dataset.fastBeat = fastCursor.current
      ? String(fastCursor.current.snappedBeat.numerator / fastCursor.current.snappedBeat.denominator) : '';
    canvas.dataset.slidePhase = !pendingSlide.current ? '' : pendingSlide.current.state.endBeat ? 'path'
      : pendingSlide.current.state.moveBeat ? 'end' : 'prepare';
    paintTimeline(context, width, height, latestProps.current, viewport.current, lastChartSeconds.current,
      gesture.current, pendingRingHold.current, pendingTouchHold.current, hoverPoint.current, fastCursor.current,
      skinImages.current, geometry, pendingSlide.current?.state ?? null, pendingPaste.current);
    const renderedChart = currentChart(latestProps.current);
    if (warningCache.current.chart !== renderedChart) {
      warningCache.current = { chart: renderedChart, markers: renderedChart ? groupWarningMarkers(renderedChart) : [] };
    }
    visibleWarnings.current = drawWarningTrack(context, warningCache.current.markers, skinImages.current, viewport.current, geometry);
    canvas.dataset.warningTrackCenter = String(geometry.gridLeft - WARNING_TRACK_WIDTH / 2);
    canvas.dataset.warningCount = String(warningCache.current.markers.length);
    if (canvas.hasAttribute('data-measure-warnings')) canvas.dataset.warningMarkers = JSON.stringify(visibleWarnings.current);
    const point = hoverPoint.current;
    const hovered = point && !gesture.current && point.y >= geometry.gridTop && point.y <= geometry.gridBottom
      ? hitWarning(visibleWarnings.current, point.x, point.y) : null;
    const tooltip = warningTooltip.current;
    if (tooltip) {
      tooltip.hidden = !hovered;
      if (hovered) {
        const marker = hovered.marker;
        const contentKey = `${marker.key}:${marker.codes.join(',')}`;
        if (tooltip.dataset.contentKey !== contentKey) {
          tooltip.dataset.contentKey = contentKey;
          tooltip.replaceChildren(...marker.codes.map((code) => {
            const line = document.createElement('div');
            const bad = [0, 1, 5, 7, 8].includes(code);
            line.style.color = bad ? '#FF6767' : '#FDFF45';
            line.textContent = `[${bad ? '冲突' : '警告'}] ${warningMessages[code]}`;
            return line;
          }));
        }
        tooltip.style.left = `${Math.min(hovered.x + 17, Math.max(4, width - tooltip.offsetWidth - 4))}px`;
        tooltip.style.top = `${Math.max(geometry.gridTop, Math.min(hovered.y - tooltip.offsetHeight / 2, geometry.gridBottom - tooltip.offsetHeight))}px`;
      }
    }
  };

  const stopFastPlacement = () => {
    fastKeys.current.clear();
    cancelAnimationFrame(fastFrame.current);
    fastFrame.current = 0;
    fastCursor.current = null;
    lastFastAt.current = -Infinity;
  };

  const captureContext = (): ActionContext | null => {
    const current = latestProps.current;
    const snapshot = latestSnapshot(current);
    const chart = snapshot?.charts.find((item) => item.difficulty === current.difficulty);
    if (!snapshot || !chart?.editable) return null;
    return { generation: snapshot.generation, difficulty: current.difficulty, epoch: actionEpoch.current };
  };

  const captureDocumentContext = (): DocumentContext | null => {
    const current = latestProps.current;
    const snapshot = latestSnapshot(current);
    if (!snapshot || !snapshot.charts.some((item) => item.difficulty === current.difficulty)) return null;
    return { generation: snapshot.generation, version: snapshot.version,
      difficulty: current.difficulty, epoch: actionEpoch.current };
  };

  const documentContextIsCurrent = (context: DocumentContext): boolean => {
    const current = latestProps.current;
    const snapshot = latestSnapshot(current);
    return Boolean(snapshot && snapshot.generation === context.generation && snapshot.version === context.version
      && current.difficulty === context.difficulty && actionEpoch.current === context.epoch
      && snapshot.charts.some((item) => item.difficulty === context.difficulty));
  };

  const clearPendingPaste = () => {
    pendingPaste.current = null;
    if (gesture.current?.kind === 'paste') gesture.current = null;
  };

  const pointInGrid = (point: Point, geometry: Geometry): boolean => point.x >= geometry.gridLeft
    && point.x <= geometry.gridRight && point.y >= geometry.gridTop && point.y <= geometry.gridBottom;

  const contextIsCurrent = (context: ActionContext): boolean => {
    const current = latestProps.current;
    const snapshot = latestSnapshot(current);
    return Boolean(snapshot && snapshot.generation === context.generation
      && current.difficulty === context.difficulty && actionEpoch.current === context.epoch
      && snapshot.charts.find((item) => item.difficulty === context.difficulty)?.editable);
  };

  const enqueueInputAction = (context: ActionContext, action: () => void | Promise<void>) => {
    queuedInputCount.current += 1;
    inputQueue.current = inputQueue.current.then(async () => {
      if (!contextIsCurrent(context)) return;
      await action();
    }).catch((cause: unknown) => {
      latestProps.current.onError?.(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      queuedInputCount.current = queuedInputCount.current - 1;
    });
  };

  const addInContext = async (context: ActionContext, note: Omit<Note, 'id' | 'order'>) => {
    const current = latestProps.current;
    const chart = latestChart(current);
    if (!contextIsCurrent(context) || !chart || hasDuplicateAdd(chart, note)) return;
    current.onEditStart?.();
    await current.onCommand({ type: 'add', difficulty: context.difficulty, notes: [note] });
  };

  const commitPaste = (pending: PendingPaste, beat: Rational) => {
    enqueueInputAction(pending.context, async () => {
      if (pendingPaste.current !== pending) return;
      if (!documentContextIsCurrent(pending.context)) {
        clearPendingPaste();
        repaint();
        return;
      }
      const current = latestProps.current;
      const chart = latestChart(current);
      if (!chart?.editable || current.editingDisabled) {
        clearPendingPaste();
        repaint();
        return;
      }
      const beforeIds = new Set(chart.notes.map((note) => note.id));
      const notes = pending.notes.map(({ id: _id, order: _order, sourceRange: _range, ...note }) => ({
        ...note,
        beat: addRational(beat, subtractRational(note.beat, pending.origin)),
      }));
      const shiftedBpms = shiftedPasteBpms(pending, beat);
      const bpms = shiftedBpms.length ? mergeBpmEvents(chart.bpms, shiftedBpms) : undefined;
      const pastedBpmKeys = [...new Set(shiftedBpms.map((event) => rationalKey(event.beat)))];
      pendingPaste.current = null;
      current.onEditStart?.();
      repaint();
      await current.onCommand({ type: 'edit-events', difficulty: pending.context.difficulty, addNotes: notes,
        ...(bpms ? { bpms } : {}) });
      const after = latestSnapshot(latestProps.current);
      if (!after || after.generation !== pending.context.generation
        || latestProps.current.difficulty !== pending.context.difficulty
        || actionEpoch.current !== pending.context.epoch) return;
      const inserted = after.charts.find((item) => item.difficulty === pending.context.difficulty)
        ?.notes.filter((note) => !beforeIds.has(note.id)).map((note) => note.id) ?? [];
      const afterChart = after.charts.find((item) => item.difficulty === pending.context.difficulty);
      const liveBpmKeys = new Set(afterChart?.bpms.map((event) => rationalKey(event.beat)));
      latestProps.current.onSelection(inserted, pastedBpmKeys.filter((key) => liveBpmKeys?.has(key)));
    });
  };

  const clearSlide = () => {
    pendingSlide.current = null;
    latestProps.current.onSlidePathRequest(null);
    repaint();
  };

  const slideSettings = () => ({ head: latestProps.current.slideHead, slideBreak: latestProps.current.slideBreak,
    modifiers: { ...latestProps.current.ringModifiers } });

  const addSlidePath = async (context: ActionContext, note: Omit<Note, 'id' | 'order'>) => {
    const chart = latestChart(latestProps.current);
    if (!contextIsCurrent(context) || !chart || !note.slide) return;
    const heads = chart.notes.filter(item => item.kind === 'slide' && item.position === note.position
      && compareRational(item.beat, note.beat) === 0);
    if (heads.length > 1) throw new Error('此处有多个独立 Slide 头，请先移动或删除多余的头，再追加路径。');
    const existing = heads[0];
    if (!existing?.slide) { await addInContext(context, note); return; }
    const { head: _head, additionalPaths: _paths, ...path } = note.slide;
    await latestProps.current.onCommand({ type: 'update', difficulty: context.difficulty,
      changes: [{ id: existing.id, patch: { slide: { ...existing.slide,
        additionalPaths: [...(existing.slide.additionalPaths ?? []), path] } } }] });
  };

  const confirmSlide = (command: NonNullable<Note['slide']>['command'], startPosition?: number, endPosition?: number, continuations?: SlideSegmentData[]) => {
    const pending = pendingSlide.current;
    if (!pending?.state.endBeat) return;
    const settings = slideSettings();
    enqueueInputAction(pending.context, async () => {
      if (pendingSlide.current !== pending) return;
      const chart = latestChart(latestProps.current);
      if (!chart) return;
      const state = { ...pending.state, startPosition: startPosition ?? pending.state.startPosition,
        endPosition: endPosition ?? pending.state.endPosition };
      const note = finishSlidePlacement(state, command, settings, chart.bpms);
      if (continuations?.length) note.slide!.continuations = continuations;
      await addSlidePath(pending.context, note);
      clearSlide();
    });
  };

  const placeSlide = async (context: ActionContext, beat: Rational, position: number, oneBeatStart: boolean, wifi: boolean, settings: SlidePlacementSettings) => {
    const current = latestProps.current;
    const chart = latestChart(current);
    if (!chart) return;
    let pending = pendingSlide.current;
    if (!pending) {
      current.onEditStart?.();
      pendingSlide.current = { state: beginSlidePlacement(beat, position, oneBeatStart), context };
    } else {
      if (pending.state.endBeat) return;
      pending = { ...pending, state: advanceSlidePlacement(pending.state, beat, position) };
      pendingSlide.current = pending;
      if (pending.state.endBeat) {
        const note = finishSlidePlacement(pending.state, wifi ? 'w' : '<', settings, chart.bpms);
        if (wifi) {
          await addSlidePath(context, note);
          clearSlide();
        } else current.onSlidePathRequest({ note: displaySlide(note, chart.bpms) });
      }
    }
    repaint();
  };

  const applyTemplate = async (context: ActionContext, id: string, modifiers: Note['modifiers'], firework: boolean, forceStar: boolean, slideHead: SlideData['head']) => {
    const current = latestProps.current;
    if (current.editingDisabled) return;
    const note = latestChart(current)?.notes.find((item) => item.id === id);
    if (!note) return;
    if (note.kind === 'slide' && note.slide) {
      if (note.modifiers.break === modifiers.break && note.modifiers.ex === modifiers.ex && note.slide.head === slideHead) return;
      await current.onCommand({ type: 'update', difficulty: context.difficulty,
        changes: [{ id, patch: { modifiers, slide: { ...note.slide, head: slideHead } } }] });
      return;
    }
    const touch = note.kind === 'touch' || note.kind === 'touchHold';
    if (touch ? (note.firework ?? false) === firework
      : note.modifiers.break === modifiers.break && note.modifiers.ex === modifiers.ex
        && (note.kind !== 'tap' || (note.forceStar ?? false) === forceStar)) return;
    await current.onCommand({ type: 'update', difficulty: context.difficulty,
      changes: [{ id, patch: touch ? { firework } : note.kind === 'tap' ? { modifiers, forceStar } : { modifiers } }] });
  };

  fastEligible.current = () => {
    const current = latestProps.current;
    const point = fastCursor.current ?? hoverPoint.current;
    const canvas = canvasRef.current;
    if (!canvas || !point || point.touchTrack || current.tool === 'select' || current.ringTool === 'slide'
      || current.editingDisabled || gesture.current || pendingRingHold.current || pendingSlide.current
      || pendingPaste.current || queuedInputCount.current || document.activeElement?.closest('[role="menu"]')) return false;
    const geometry = getGeometry(canvas.clientWidth, canvas.clientHeight);
    return Boolean(latestChart(current)?.editable && point.x >= geometry.gridLeft && point.x < geometry.ringRight
      && point.y >= geometry.gridTop && point.y <= geometry.gridBottom);
  };

  fastStep.current = (direction) => {
    if (!fastEligible.current()) return false;
    const current = latestProps.current;
    const chart = latestChart(current)!;
    const context = captureContext();
    if (!context) return false;
    const originalPoint = fastCursor.current ?? hoverPoint.current!;
    const geometry = getGeometry(canvasRef.current!.clientWidth, canvasRef.current!.clientHeight);
    const hoverSeconds = Math.max(0, secondsAtY(originalPoint.y, geometry, viewport.current));
    const point = { ...originalPoint,
      snappedBeat: snapBeat(secondsToBeat(hoverSeconds, chart.bpms), validDivision(current.snapDivision)) };
    const clock = lastChartSeconds.current;
    const step = fastPlacementStep({
      position: point.lane, beat: point.snappedBeat, bpms: chart.bpms,
      snapDivision: validDivision(current.snapDivision), laneOrder: LANE_ORDER, direction,
      playheadSeconds: clock,
    });
    if (!step) return false;
    const kind = current.ringTool;
    if (kind === 'slide') return false;
    enqueueInputAction(context, async () => {
      // A successful edit pauses immediately; a duplicate leaves playback running.
      const edit = addInContext(context, {
        kind, beat: step.beat, position: step.position,
        ...(kind === 'hold' ? { duration: { kind: 'short' as const } } : {}),
        modifiers: current.ringModifiers,
        ...(kind === 'tap' ? { forceStar: current.ringForceStar } : {}),
      });
      const offset = followOffsetSeconds.current;
      const seconds = current.onAdvanceFastClock(step.nextChartSeconds - clock);
      followOffsetSeconds.current = offset;
      viewport.current.viewSeconds = seconds + offset;
      lastChartSeconds.current = seconds;
      // The browser cannot warp the system pointer. Keep its Y and move a visible logical cursor.
      fastCursor.current = { ...point, lane: step.nextPosition,
        x: geometry.lanes.find((lane) => lane.position === step.nextPosition)!.center };
      repaint();
      await edit;
    });
    return true;
  };

  useEffect(() => {
    const isField = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('input, textarea, select, [contenteditable], [role="menu"]'));
    const tick = (now: number) => {
      if (!fastKeys.current.size) { fastFrame.current = 0; return; }
      if (now - lastFastAt.current > 200
        && fastStep.current(fastKeys.current.has('ArrowLeft') ? 'left' : 'right')) lastFastAt.current = now;
      fastFrame.current = requestAnimationFrame(tick);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (isField(event.target)) return;
      if (fastEligible.current()) event.preventDefault();
      if (event.repeat) return;
      fastKeys.current.add(event.key);
      if (!fastFrame.current) tick(performance.now());
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!fastKeys.current.delete(event.key)) return;
      lastFastAt.current = -Infinity;
      if (!fastKeys.current.size) {
        cancelAnimationFrame(fastFrame.current);
        fastFrame.current = 0;
      }
    };
    const stopKeys = () => {
      stopFastPlacement();
      repaint();
    };
    const cancel = () => {
      pointerSequence.current += 1;
      rightClickGesture.current = null;
      latestProps.current.onEditMenu(null);
      stopKeys();
    };
    const onFocus = (event: FocusEvent) => { if (isField(event.target)) stopKeys(); };
    const onVisibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', cancel);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopFastPlacement();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    stopFastPlacement();
    repaint();
  }, [props.snapshot?.generation, props.difficulty, props.tool, props.snapDivision, props.editingDisabled]);

  useEffect(() => {
    const snapshot = latestSnapshot(latestProps.current);
    const next = { generation: snapshot?.generation ?? null, version: snapshot?.version ?? null,
      difficulty: latestProps.current.difficulty };
    const previous = observedDocument.current;
    const changed = previous.generation !== next.generation || previous.version !== next.version
      || previous.difficulty !== next.difficulty;
    observedDocument.current = next;
    if (changed) {
      pointerSequence.current += 1;
      rightClickGesture.current = null;
      latestProps.current.onEditMenu(null);
    }
    const paste = pendingPaste.current;
    if (paste && (paste.context.generation !== next.generation || paste.context.version !== next.version
      || paste.context.difficulty !== next.difficulty)) {
      clearPendingPaste();
      repaint();
    }
  }, [props.snapshot?.generation, props.snapshot?.version, props.difficulty, props.editingDisabled]);

  const executeAreaIntent = async (intent: AreaIntent) => {
    if (!contextIsCurrent(intent.context)) return;
    const current = latestProps.current;
    const chart = latestChart(current);
    if (!chart?.editable) return;
    if (intent.kind === 'template') {
      const candidate = findAreaRemovalCandidate(chart, intent.target, intent.beat);
      if (candidate) await applyTemplate(intent.context, candidate.id, intent.modifiers, intent.firework, intent.forceStar, intent.slideSettings.head);
      return;
    }
    if (intent.kind === 'remove') {
      const candidate = findAreaRemovalCandidate(chart, intent.target, intent.beat);
      if (candidate) await current.onCommand({ type: 'delete', difficulty: intent.context.difficulty, ids: [candidate.id] });
      return;
    }

    if (intent.target.kind === 'ring') {
      const pending = pendingRingHold.current;
      if (pending && pending.generation === intent.context.generation
        && pending.difficulty === intent.context.difficulty && pending.epoch === intent.context.epoch) {
        pendingRingHold.current = null;
        const [startBeat, endBeat] = orderedBeats(pending.beat, intent.beat);
        await addInContext(intent.context, {
          kind: 'hold', beat: startBeat, position: pending.position,
          duration: durationBetweenBeats(startBeat, endBeat, chart.bpms),
          modifiers: intent.modifiers,
        });
        repaint();
        return;
      }
      if (pendingSlide.current || intent.familyTool === 'slide') {
        await placeSlide(intent.context, intent.beat, intent.target.position, intent.slideOneBeatStart, intent.slideWifi, intent.slideSettings);
      } else if (intent.familyTool === 'hold') {
        const note = { kind: 'hold' as const, beat: intent.beat, position: intent.target.position,
          duration: { kind: 'short' as const }, modifiers: { break: false, ex: false } };
        if (!hasDuplicateAdd(chart, note)) {
          current.onEditStart?.();
          pendingRingHold.current = { kind: 'hold', beat: intent.beat, position: intent.target.position,
            generation: intent.context.generation, difficulty: intent.context.difficulty, epoch: intent.context.epoch };
        }
      } else {
        await addInContext(intent.context, {
          kind: 'tap', beat: intent.beat, position: intent.target.position,
          modifiers: intent.modifiers, forceStar: intent.forceStar,
        });
      }
      repaint();
      return;
    }

    if (pendingTouchHold.current) return;
    if (intent.familyTool === 'touchHold') {
      const note = { kind: 'touchHold' as const, beat: intent.beat, position: intent.target.position,
        touchArea: intent.target.area, modifiers: { break: false, ex: false } };
      if (!hasDuplicateAdd(chart, note)) {
        current.onEditStart?.();
        pendingTouchHold.current = { kind: 'touchHold', beat: intent.beat, position: intent.target.position,
          touchArea: intent.target.area, generation: intent.context.generation,
          difficulty: intent.context.difficulty, epoch: intent.context.epoch };
      }
    } else {
      await addInContext(intent.context, {
        kind: 'touch', beat: intent.beat, position: intent.target.position,
        touchArea: intent.target.area, firework: intent.firework, modifiers: { break: false, ex: false },
      });
    }
    repaint();
  };

  const queueAreaIntent = (kind: AreaIntent['kind'], key: string, chartSeconds: number) => {
    const target = parseAreaKey(key);
    const current = latestProps.current;
    const snapshot = latestSnapshot(current);
    const chart = snapshot?.charts.find((item) => item.difficulty === current.difficulty);
    const context = captureContext();
    if (!target || !chart || !snapshot || !context) return;
    const beat = beatAtChartSeconds(chartSeconds, chart, validDivision(current.snapDivision));
    if (!beat) return;
    const familyTool = target.kind === 'ring' ? current.ringTool : current.touchTool;
    const intent: AreaIntent = {
      kind, target, beat, context, familyTool, modifiers: { ...current.ringModifiers }, firework: current.touchFirework,
      forceStar: current.ringForceStar,
      slideOneBeatStart: current.slideOneBeatStart, slideWifi: current.slideWifi,
      slideSettings: slideSettings(),
    };
    enqueueInputAction(context, () => executeAreaIntent(intent));
  };

  const queueTouchTimeIntent = (point: Point) => {
    const context = captureContext();
    if (!context) return;
    const endpoint = point.snappedBeat;
    const firework = latestProps.current.touchFirework;
    enqueueInputAction(context, async () => {
      const current = latestProps.current;
      const chart = latestChart(current);
      const pending = pendingTouchHold.current;
      if (pending && pending.generation === context.generation
        && pending.difficulty === context.difficulty && pending.epoch === context.epoch) {
        pendingTouchHold.current = null;
        if (chart) {
          const [startBeat, endBeat] = orderedBeats(pending.beat, endpoint);
          await addInContext(context, {
            kind: 'touchHold', beat: startBeat, position: pending.position,
            touchArea: pending.touchArea!, firework, duration: durationBetweenBeats(startBeat, endBeat, chart.bpms),
            modifiers: { break: false, ex: false },
          });
        }
      } else {
        selectedTouchBeat.current = endpoint;
        current.onTouchTimeChange(endpoint);
      }
      repaint();
    });
  };

  const beginPaste = (notes: Note[], bpms: BpmEvent[], origin: Rational) => {
    const current = latestProps.current;
    const context = captureDocumentContext();
    const chart = latestChart(current);
    if (!context || !chart?.editable || current.editingDisabled || (!notes.length && !bpms.length)) return;
    pointerSequence.current += 1;
    rightClickGesture.current = null;
    current.onEditMenu(null);
    gesture.current = null;
    pendingRingHold.current = null;
    pendingTouchHold.current = null;
    pendingSlide.current = null;
    current.onSlidePathRequest(null);
    selectedTouchBeat.current = null;
    current.onTouchTimeChange(null);
    stopFastPlacement();
    pendingPaste.current = {
      notes: structuredClone(notes),
      bpms: structuredClone(bpms),
      origin: structuredClone(origin),
      context,
    };
    repaint();
  };

  useImperativeHandle(ref, () => ({
    draw(chartSeconds: number) {
      lastChartSeconds.current = chartSeconds;
      viewport.current.viewSeconds = chartSeconds + followOffsetSeconds.current;
      repaint();
    },
    locate(chartSeconds: number) {
      followOffsetSeconds.current = 0;
      lastChartSeconds.current = chartSeconds;
      viewport.current.viewSeconds = chartSeconds;
      repaint();
    },
    placeTouch(area, position) {
      const current = latestProps.current;
      const beat = selectedTouchBeat.current;
      const context = captureContext();
      if (beat === null || !context) return;
      if (area !== 'C' && (!Number.isInteger(position) || position < 1 || position > 8)) return;
      if (area === 'C' && position !== 0) return;
      const touchTool = current.touchTool;
      const firework = current.touchFirework;
      enqueueInputAction(context, async () => {
        const chart = latestChart(latestProps.current);
        if (!chart?.editable || pendingTouchHold.current) return;
        if (touchTool === 'touch') {
          await addInContext(context, { kind: 'touch', beat, position, touchArea: area, firework,
            modifiers: { break: false, ex: false } });
        } else {
          const note = { kind: 'touchHold' as const, beat, position, touchArea: area, firework,
            modifiers: { break: false, ex: false } };
          if (!hasDuplicateAdd(chart, note)) {
            latestProps.current.onEditStart?.();
            pendingTouchHold.current = { kind: 'touchHold', beat, position, touchArea: area,
              generation: context.generation, difficulty: context.difficulty, epoch: context.epoch };
          }
        }
        repaint();
      });
    },
    placeArea(key, chartSeconds) {
      queueAreaIntent('place', key, chartSeconds);
    },
    removeArea(key, chartSeconds) {
      queueAreaIntent('remove', key, chartSeconds);
    },
    applyAreaTemplate(key, chartSeconds) {
      queueAreaIntent('template', key, chartSeconds);
    },
    confirmSlide,
    cancelSlide: clearSlide,
    beginPaste,
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => { stopFastPlacement(); repaint(); });
    observer.observe(canvas);
    repaint();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadSkinImages([...coreSkinKeys, 'star.base', 'star.each', 'star.break', 'star.ex',
      'star.double.base', 'star.double.each', 'star.double.break', 'star.double.ex', 'check.bad', 'check.warning']).then((images) => {
      if (cancelled) return;
      skinImages.current = images;
      repaint();
    }).catch((cause: unknown) => {
      if (cancelled) return;
      latestProps.current.onError?.(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const generation = props.snapshot?.generation ?? null;
    let clearTouchTime = false;
    if (generation !== viewportGeneration.current) {
      viewportGeneration.current = generation;
      viewport.current.viewSeconds = 0;
      followOffsetSeconds.current = 0;
      actionEpoch.current += 1;
      pendingRingHold.current = null;
      pendingTouchHold.current = null;
      clearSlide();
      gesture.current = null;
      clearTouchTime = true;
    }
    if (props.difficulty !== previousDifficulty.current) {
      previousDifficulty.current = props.difficulty;
      actionEpoch.current += 1;
      pendingRingHold.current = null;
      pendingTouchHold.current = null;
      clearSlide();
      gesture.current = null;
      clearTouchTime = true;
    }
    if (props.tool !== previousTool.current) {
      previousTool.current = props.tool;
      gesture.current = null;
      clearTouchTime = true;
    }
    if (clearTouchTime) {
      selectedTouchBeat.current = null;
      props.onTouchTimeChange(null);
    }
    if (props.playheadSeconds !== undefined) {
      lastChartSeconds.current = props.playheadSeconds;
      viewport.current.viewSeconds = props.playheadSeconds + followOffsetSeconds.current;
    }
    repaint();
  }, [props.snapshot, props.difficulty, props.selectedIds, props.selectedBpmBeats, props.waveform, props.trackDurationSeconds,
    props.playheadSeconds, props.tool, props.ringTool, props.ringModifiers, props.ringForceStar, props.touchTool, props.touchFirework,
    props.slideHead, props.slideBreak, props.slideWifi, props.slideOneBeatStart, props.touchArea, props.touchPosition, props.snapDivision]);

  const pointAt = (clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    const current = latestProps.current;
    const view = viewport.current;
    const geometry = getGeometry(bounds.width, bounds.height);
    const chartSeconds = Math.max(0, secondsAtY(y, geometry, view));
    const chart = latestChart(current);
    const beat = chart && chartSeconds > 0 ? secondsToBeat(chartSeconds, chart.bpms) : 0;
    const touchTrack = x >= geometry.touchTrackLeft && x <= geometry.gridRight;
    const lane = laneAtX(x, geometry);
    return {
      x, y, chartSeconds, beat,
      snappedBeat: snapBeat(beat, validDivision(current.snapDivision)),
      lane, touchTrack,
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    pointerSequence.current += 1;
    rightClickGesture.current = null;
    latestProps.current.onEditMenu(null);
    fastCursor.current = null;
    const current = latestProps.current;
    const point = pointAt(event.clientX, event.clientY);
    const chart = latestChart(current);
    const canvas = canvasRef.current!;

    // The source marker only opens a hover bar; it is not an edit or seek target.
    if (event.button !== 1 && hitWarning(visibleWarnings.current, point.x, point.y)) {
      event.preventDefault();
      return;
    }

    if (event.button === 2) {
      event.preventDefault();
      gesture.current = null;
      canvas.setPointerCapture(event.pointerId);
      if (pendingPaste.current) {
        clearPendingPaste();
        repaint();
        return;
      }
      const documentContext = captureDocumentContext();
      const view = { ...viewport.current };
      const geometry = getGeometry(canvas.clientWidth, canvas.clientHeight);
      const priorityPending = Boolean(pendingSlide.current || pendingRingHold.current || pendingTouchHold.current);
      const hit = chart && hitTest(chart, point, view, geometry);
      const sequence = pointerSequence.current;
      const rightClick: RightClickGesture = {
        pointerId: event.pointerId, sequence, context: documentContext,
        blank: Boolean(documentContext && !priorityPending && !hit && pointInGrid(point, geometry)),
        moved: false, startX: point.x, startY: point.y,
      };
      rightClickGesture.current = rightClick;
      const context = captureContext();
      if (!context) return;
      enqueueInputAction(context, async () => {
        if (pendingSlide.current) {
          rightClick.blank = false;
          const state = rewindSlidePlacement(pendingSlide.current.state, latestProps.current.slideOneBeatStart);
          if (state) pendingSlide.current = { ...pendingSlide.current, state };
          else clearSlide();
        } else if (pendingRingHold.current || pendingTouchHold.current) {
          rightClick.blank = false;
          pendingRingHold.current = null;
          pendingTouchHold.current = null;
        } else {
          const current = latestProps.current;
          const currentChart = latestChart(current);
          const currentHit = currentChart && hitTest(currentChart, point, view, geometry);
          if (currentHit) {
            rightClick.blank = false;
            const ids = currentHit.notes.map((note) => note.id);
            await current.onCommand({ type: 'delete', difficulty: context.difficulty, ids });
            current.onSelection(latestProps.current.selectedIds.filter((id) => !ids.includes(id)), latestProps.current.selectedBpmBeats);
          }
        }
        repaint();
      });
      return;
    }

    if (pendingPaste.current) {
      if (event.button === 0) {
        canvas.setPointerCapture(event.pointerId);
        gesture.current = { kind: 'paste', pointerId: event.pointerId, start: point, current: point };
        hoverPoint.current = point;
        repaint();
      } else {
        clearPendingPaste();
        repaint();
      }
      return;
    }

    if (event.button === 1) {
      event.preventDefault();
      const hit = chart && hitTest(chart, point, viewport.current, getGeometry(canvas.clientWidth, canvas.clientHeight));
      canvas.setPointerCapture(event.pointerId);
      gesture.current = {
        kind: 'pan', pointerId: event.pointerId, start: point,
        lastY: point.y, scale: viewport.current.pixelsPerSecond,
        moved: false, templateId: hit?.notes.length === 1 ? hit.notes[0].id : undefined,
      };
      return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    if (!point.touchTrack && !pendingTouchHold.current) {
      selectedTouchBeat.current = null;
      current.onTouchTimeChange(null);
    }

    if (chart?.editable && point.touchTrack
      && (pendingTouchHold.current || queuedInputCount.current > 0
        || (current.tool === 'touch' || current.tool === 'touchHold'))) {
      gesture.current = { kind: 'touch-time', pointerId: event.pointerId, start: point, current: point };
      hoverPoint.current = point;
      repaint();
      return;
    }

    if (current.tool !== 'select' && chart?.editable) {
      const geometry = getGeometry(canvas.clientWidth, canvas.clientHeight);
      const isTouch = current.tool === 'touch' || current.tool === 'touchHold';
      if (isTouch) {
        if (!point.touchTrack || point.y < geometry.gridTop || point.y > geometry.gridBottom) return;
        gesture.current = { kind: 'touch-time', pointerId: event.pointerId, start: point, current: point };
        hoverPoint.current = point;
        repaint();
        return;
      }
      if (point.touchTrack || point.x < geometry.gridLeft || point.x >= geometry.ringRight
        || point.y < geometry.gridTop || point.y > geometry.gridBottom) return;
      if (pendingRingHold.current) {
        gesture.current = { kind: 'place', pointerId: event.pointerId, start: point, current: point, noteKind: 'hold' };
      } else {
        current.onEditStart?.();
        gesture.current = { kind: 'place', pointerId: event.pointerId, start: point, current: point,
          noteKind: pendingSlide.current ? 'slide' : current.tool as 'tap' | 'hold' | 'slide' };
      }
      hoverPoint.current = point;
      repaint();
      return;
    }

    if (current.tool === 'select' && chart) {
      const bpmHit = hitBpmEvent(chart, point, viewport.current, getGeometry(canvas.clientWidth, canvas.clientHeight));
      if (bpmHit) {
        const key = rationalKey(bpmHit.beat);
        const bpmBeats = event.shiftKey
          ? current.selectedBpmBeats.includes(key)
            ? current.selectedBpmBeats.filter((item) => item !== key)
            : [...current.selectedBpmBeats, key]
          : [key];
        current.onSelection(event.shiftKey ? current.selectedIds : [], bpmBeats);
        hoverPoint.current = point;
        repaint();
        return;
      }
    }

    const hit = chart ? hitTest(chart, point, viewport.current, getGeometry(canvas.clientWidth, canvas.clientHeight)) : null;
    if (hit) {
      let ids: string[];
      if (event.shiftKey) {
        const groupIds = hit.notes.map((note) => note.id);
        const removeGroup = groupIds.some((id) => current.selectedIds.includes(id));
        ids = removeGroup
          ? current.selectedIds.filter((id) => !groupIds.includes(id))
          : [...current.selectedIds, ...groupIds];
        ids = [...new Set(ids)];
      } else {
        const groupIds = hit.notes.map((note) => note.id);
        ids = groupIds.every((id) => current.selectedIds.includes(id)) ? current.selectedIds : groupIds;
      }
      current.onSelection(ids, event.shiftKey ? current.selectedBpmBeats : []);
      if (chart?.editable && !event.shiftKey && hit.notes.some((note) => ids.includes(note.id))) {
        const notes = hit.notes.length > 1 ? hit.notes : chart.notes.filter((note) => ids.includes(note.id));
        current.onEditStart?.();
        gesture.current = {
          kind: 'move', pointerId: event.pointerId, start: point, current: point, notes,
          edge: notes.length === 1 ? hit.edge : null,
          deltaBeat: rational(0), deltaLane: 0, moved: false,
        };
      }
    } else {
      gesture.current = {
        kind: 'box', pointerId: event.pointerId, start: point, current: point,
        additive: event.ctrlKey || event.metaKey,
      };
    }
    hoverPoint.current = point;
    repaint();
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const rightClick = rightClickGesture.current;
    if (rightClick?.pointerId === event.pointerId) {
      const point = pointAt(event.clientX, event.clientY);
      rightClick.moved ||= Math.hypot(point.x - rightClick.startX, point.y - rightClick.startY) > 3;
    }
    fastCursor.current = null;
    const point = pointAt(event.clientX, event.clientY);
    hoverPoint.current = point;
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) {
      repaint();
      return;
    }
    if (active.kind === 'place' || active.kind === 'paste' || active.kind === 'touch-time' || active.kind === 'box') {
      gesture.current = { ...active, current: point };
    } else if (active.kind === 'pan') {
      active.moved ||= Math.hypot(point.x - active.start.x, point.y - active.start.y) >= 5;
      if (!active.moved) return;
      const deltaSeconds = (point.y - active.lastY) / active.scale;
      active.lastY = point.y;
      latestProps.current.onScrub(deltaSeconds);
    } else {
      const delta = subtractRational(point.snappedBeat, active.start.snappedBeat);
      gesture.current = {
        ...active,
        current: point,
        deltaBeat: delta,
        deltaLane: point.lane - active.start.lane,
        moved: active.moved || Math.hypot(point.x - active.start.x, point.y - active.start.y) > 3,
      };
    }
    repaint();
  };

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) {
      const rightClick = rightClickGesture.current;
      rightClickGesture.current = null;
      if (!rightClick || !rightClick.blank || rightClick.pointerId !== event.pointerId
        || rightClick.moved || rightClick.sequence !== pointerSequence.current || !rightClick.context) return;
      const { clientX, clientY } = event;
      const finishMenuRequest = () => {
        if (rightClick.sequence !== pointerSequence.current || !rightClick.blank || rightClick.moved
          || gesture.current || pendingPaste.current || pendingSlide.current || pendingRingHold.current || pendingTouchHold.current
          || !documentContextIsCurrent(rightClick.context!)) return;
        const canvas = canvasRef.current;
        const chart = latestChart(latestProps.current);
        if (!canvas || !chart) return;
        const point = pointAt(clientX, clientY);
        const geometry = getGeometry(canvas.clientWidth, canvas.clientHeight);
        if (!pointInGrid(point, geometry) || hitTest(chart, point, viewport.current, geometry)) return;
        latestProps.current.onEditMenu({ x: clientX, y: clientY,
          generation: rightClick.context!.generation, version: rightClick.context!.version,
          difficulty: rightClick.context!.difficulty });
      };
      void (async () => {
        let observed: Promise<void>;
        do {
          observed = inputQueue.current;
          await observed;
        } while (observed !== inputQueue.current);
        finishMenuRequest();
      })();
      return;
    }
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = pointAt(event.clientX, event.clientY);
    const current = latestProps.current;
    const chart = latestChart(current);
    gesture.current = null;
    hoverPoint.current = point;

    if (active.kind === 'paste') {
      const pending = pendingPaste.current;
      const geometry = getGeometry(canvasRef.current!.clientWidth, canvasRef.current!.clientHeight);
      if (!pending) { repaint(); return; }
      if (!documentContextIsCurrent(pending.context) || !chart?.editable || current.editingDisabled) {
        clearPendingPaste();
        repaint();
        return;
      }
      if (pointInGrid(point, geometry)) commitPaste(pending, point.snappedBeat);
      repaint();
      return;
    }

    if (active.kind === 'pan') {
      if (active.moved) {
        current.onScrub(null);
        repaint();
        return;
      }
      const context = captureContext();
      const hit = chart && hitTest(chart, point, viewport.current, getGeometry(canvasRef.current!.clientWidth, canvasRef.current!.clientHeight));
      if (!active.moved && context && active.templateId && hit?.notes.some((note) => note.id === active.templateId)) {
        const modifiers = { ...current.ringModifiers };
        const firework = current.touchFirework;
        const forceStar = current.ringForceStar;
        const slideHead = current.slideHead;
        enqueueInputAction(context, () => {
          if (!pendingRingHold.current && !pendingTouchHold.current && !pendingSlide.current) return applyTemplate(context, active.templateId!, modifiers, firework, forceStar, slideHead);
        });
      }
      repaint();
      return;
    }
    if (active.kind === 'touch-time') {
      const geometry = getGeometry(canvasRef.current!.clientWidth, canvasRef.current!.clientHeight);
      if (point.touchTrack && point.y >= geometry.gridTop && point.y <= geometry.gridBottom) {
        queueTouchTimeIntent(point);
      } else {
        selectedTouchBeat.current = null;
        current.onTouchTimeChange(null);
      }
      repaint();
      return;
    }
    if (active.kind === 'place') {
      const context = captureContext();
      if (!context) return;
      const selectedKind = active.noteKind;
      const modifiers = { ...current.ringModifiers };
      const forceStar = current.ringForceStar;
      const oneBeatStart = current.slideOneBeatStart, wifi = current.slideWifi;
      const settings = slideSettings();
      enqueueInputAction(context, async () => {
        const chart = latestChart(latestProps.current);
        if (!chart?.editable || !contextIsCurrent(context)) return;
        const pending = pendingRingHold.current;
        if (pending && pending.generation === context.generation
          && pending.difficulty === context.difficulty && pending.epoch === context.epoch) {
          pendingRingHold.current = null;
          const [startBeat, endBeat] = orderedBeats(pending.beat, point.snappedBeat);
          await addInContext(context, {
            kind: 'hold', beat: startBeat, position: pending.position,
            duration: durationBetweenBeats(startBeat, endBeat, chart.bpms),
            modifiers,
          });
        } else if (pendingSlide.current || selectedKind === 'slide') {
          await placeSlide(context, point.snappedBeat, point.lane, oneBeatStart, wifi, settings);
        } else if (selectedKind === 'hold') {
          const note = { kind: 'hold' as const, beat: point.snappedBeat, position: point.lane,
            duration: { kind: 'short' as const }, modifiers: { break: false, ex: false } };
          if (!hasDuplicateAdd(chart, note)) {
            latestProps.current.onEditStart?.();
            pendingRingHold.current = { kind: 'hold', beat: point.snappedBeat, position: point.lane,
              generation: context.generation, difficulty: context.difficulty, epoch: context.epoch };
          }
        } else {
          await addInContext(context, { kind: 'tap', beat: point.snappedBeat, position: point.lane,
            modifiers, forceStar });
        }
        repaint();
      });
      repaint();
      return;
    }

    if (active.kind === 'box') {
      if (Math.hypot(point.x - active.start.x, point.y - active.start.y) <= 3) {
        current.onSelection([], []);
        seekTo(point.chartSeconds);
      } else if (chart) {
        const left = Math.min(active.start.x, point.x);
        const right = Math.max(active.start.x, point.x);
        const top = Math.min(active.start.y, point.y);
        const bottom = Math.max(active.start.y, point.y);
        const geometry = getGeometry(canvasRef.current!.clientWidth, canvasRef.current!.clientHeight);
        const ids = chart.notes.filter((note) => {
          const rect = noteRect(note, viewport.current, geometry);
          return rect.x2 >= left && rect.x1 <= right && rect.y2 >= top && rect.y1 <= bottom;
        }).map((note) => note.id);
        const bpmBeats = left <= LABEL_WIDTH
          ? chart.bpms.filter((event) => {
            const y = bpmLabelCenterY(event.beat, chart.bpms, geometry, viewport.current);
            return y >= top - 7 && y <= bottom + 7;
          }).map((event) => rationalKey(event.beat))
          : [];
        current.onSelection(
          active.additive ? [...new Set([...current.selectedIds, ...ids])] : ids,
          active.additive ? [...new Set([...current.selectedBpmBeats, ...bpmBeats])] : [...new Set(bpmBeats)],
        );
      }
      repaint();
      return;
    }

    const delta = subtractRational(point.snappedBeat, active.start.snappedBeat);
    const deltaLane = point.lane - active.start.lane;
    const didMove = active.moved || Math.hypot(point.x - active.start.x, point.y - active.start.y) > 3;
    if (!chart?.editable || !didMove) {
      repaint();
      return;
    }
    const context = captureContext();
    if (!context) return;
    enqueueInputAction(context, async () => {
      const current = latestProps.current;
      const chart = latestChart(current);
      if (!chart) return;
      const ids = new Set(active.notes.map((note) => note.id));
      const changes = chart.notes.filter((note) => ids.has(note.id)).flatMap((note) => {
        const patch = movedNotePatch(note, active.edge, point, delta, deltaLane, chart.bpms);
        return patch ? [{ id: note.id, patch }] : [];
      });
      if (changes.length) await current.onCommand({ type: 'update', difficulty: context.difficulty, changes });
    });
    repaint();
  };

  const handlePointerCancel = (event: PointerEvent<HTMLCanvasElement>) => {
    pointerSequence.current += 1;
    rightClickGesture.current = null;
    latestProps.current.onEditMenu(null);
    if (gesture.current?.pointerId === event.pointerId) {
      gesture.current = null;
      repaint();
    }
  };

  const handleWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    pointerSequence.current += 1;
    rightClickGesture.current = null;
    latestProps.current.onEditMenu(null);
    event.preventDefault();
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    const y = event.clientY - bounds.top;
    const view = viewport.current;
    if (event.ctrlKey || event.metaKey) {
      const oldScale = view.pixelsPerSecond;
      const anchorSeconds = secondsAtY(y, getGeometry(bounds.width, bounds.height), view);
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale * Math.exp(-event.deltaY * 0.001)));
      view.pixelsPerSecond = nextScale;
      const geometry = getGeometry(bounds.width, bounds.height);
      view.viewSeconds = anchorSeconds - (geometry.playheadY - y) / nextScale;
    } else {
      const delta = event.deltaY || event.deltaX;
      const current = latestProps.current;
      const chart = currentChart(current);
      if (!chart || !delta) return;
      const division = validDivision(current.snapDivision);
      const beat = secondsToBeat(Math.max(0, lastChartSeconds.current), chart.bpms);
      const steps = event.shiftKey ? 4 * division : 1;
      const target = rational(Math.max(0, Math.round(beat * division) - Math.sign(delta) * steps), division);
      seekTo(beatToSeconds(target, chart.bpms) - 0.0001);
      return;
    }
    view.viewSeconds = clampView(view.viewSeconds, latestProps.current);
    followOffsetSeconds.current = view.viewSeconds - lastChartSeconds.current;
    repaint();
  };

  const zoomAtPlayhead = (factor: number) => {
    const oldScale = viewport.current.pixelsPerSecond;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, oldScale * factor));
    const chartSeconds = viewport.current.viewSeconds;
    viewport.current.pixelsPerSecond = nextScale;
    viewport.current.viewSeconds = chartSeconds;
    repaint();
  };

  const goToStart = () => {
    viewport.current.viewSeconds = 0;
    followOffsetSeconds.current = -lastChartSeconds.current;
    repaint();
  };

  const seekTo = (seconds: number) => {
    followOffsetSeconds.current = 0;
    viewport.current.viewSeconds = seconds;
    repaint();
    latestProps.current.onSeek(seconds);
  };

  return (
    <div className="timeline-surface" data-testid="timeline-panel" onContextMenu={(event) => event.preventDefault()}>
      <div className="timeline-toolbar">
        <span>{props.snapshot ? `难度 ${props.difficulty}` : '尚未载入谱面'}</span>
        <span>{currentChart(props)?.editable ? '可编辑' : '只读'}</span>
        <div className="timeline-zoom-controls">
          <button type="button" aria-label="缩小时间轴" onClick={(event) => {
            event.stopPropagation(); zoomAtPlayhead(1 / 1.25);
          }}>−</button>
          <button type="button" aria-label="放大时间轴" onClick={(event) => {
            event.stopPropagation(); zoomAtPlayhead(1.25);
          }}>＋</button>
          <button type="button" aria-label="定位到曲首" onClick={(event) => {
            event.stopPropagation(); goToStart();
          }}>曲首</button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="timeline-canvas"
        tabIndex={0}
        aria-label="谱面时间轴，未来时间朝上"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => {
          fastCursor.current = null;
          if (!gesture.current) { hoverPoint.current = null; repaint(); }
        }}
        onWheel={handleWheel}
        onDoubleClick={(event) => {
          const point = pointAt(event.clientX, event.clientY);
          if (hitWarning(visibleWarnings.current, point.x, point.y)) return;
          seekTo(point.chartSeconds);
        }}
      />
      <div ref={warningTooltip} className="timeline-warning-tooltip" role="tooltip" hidden />
      {!currentChart(props)?.editable && props.snapshot && <div className="timeline-readonly-note">当前难度只读</div>}
    </div>
  );
});

function currentChart(props: Pick<TimelineProps, 'snapshot' | 'difficulty'>): DisplayChart | null {
  return props.snapshot?.charts.find((chart) => chart.difficulty === props.difficulty) ?? null;
}

function latestSnapshot(props: TimelineProps): DisplaySnapshot | null {
  return props.getSnapshot();
}

function latestChart(props: TimelineProps): DisplayChart | null {
  return latestSnapshot(props)?.charts.find((chart) => chart.difficulty === props.difficulty) ?? null;
}

function parseAreaKey(key: string): AreaTarget | null {
  if (/^[1-8]$/.test(key)) return { kind: 'ring', position: Number(key) };
  if (key === 'C') return { kind: 'touch', area: 'C', position: 0 };
  const match = /^([ABDE])([1-8])$/.exec(key);
  return match ? { kind: 'touch', area: match[1] as TouchArea, position: Number(match[2]) } : null;
}

function beatAtChartSeconds(seconds: number, chart: DisplayChart, division: number): Rational | null {
  if (!Number.isFinite(seconds)) return null;
  return snapBeat(secondsToBeat(Math.max(0, seconds), chart.bpms), division);
}

function hasDuplicateAdd(chart: DisplayChart, note: Omit<Note, 'id' | 'order'>): boolean {
  if (note.touchArea) return hasTouchAtSensor(chart, note.beat, note.touchArea, note.position);
  return chart.notes.some((existing) => !existing.touchArea && existing.kind === note.kind
    && existing.position === note.position && compareRational(existing.beat, note.beat) === 0);
}

function areaRemovalPriority(
  note: DisplayNote,
  area: AreaTarget,
  beat: Rational,
  chart: DisplayChart,
): number | null {
  if (area.kind === 'ring') {
    if (note.touchArea || note.position !== area.position) return null;
    if (note.kind === 'tap') return compareRational(note.beat, beat) === 0 ? 0 : null;
    if (note.kind === 'slide') return compareRational(note.beat, beat) === 0 ? 2 : null;
    if (note.kind !== 'hold' || compareRational(note.beat, beat) > 0) return null;
    return beatToSeconds(beat, chart.bpms) <= note.endSeconds + 1e-9 ? 1 : null;
  }
  if (note.touchArea !== area.area || note.position !== area.position) return null;
  if (note.kind === 'touch') return compareRational(note.beat, beat) === 0 ? 0 : null;
  if (note.kind !== 'touchHold' || compareRational(note.beat, beat) > 0) return null;
  return beatToSeconds(beat, chart.bpms) <= note.endSeconds + 1e-9 ? 1 : null;
}

function findAreaRemovalCandidate(
  chart: DisplayChart,
  area: AreaTarget,
  beat: Rational,
): DisplayNote | null {
  let candidate: DisplayNote | null = null;
  let priority = Infinity;
  for (const note of chart.notes) {
    const next = areaRemovalPriority(note, area, beat, chart);
    if (next !== null && next < priority) { candidate = note; priority = next; }
  }
  return candidate;
}

function validDivision(value: number | undefined): number {
  return Number.isInteger(value) && value! > 0 && value! <= 64 ? value! : 4;
}

function snapBeat(beat: number, division: number): Rational {
  return rational(Math.max(0, Math.round(beat * division)), division);
}

function orderedBeats(left: Rational, right: Rational): [Rational, Rational] {
  return compareRational(left, right) <= 0 ? [left, right] : [right, left];
}

function durationBetweenBeats(start: Rational, end: Rational, bpms: readonly BpmEvent[]): HoldDuration {
  const startBpm = bpmAtBeat(start, bpms);
  const crossesBpm = bpms.some((event) => compareRational(event.beat, start) > 0
    && compareRational(event.beat, end) < 0 && event.bpm !== startBpm);
  if (crossesBpm) {
    return { kind: 'seconds', seconds: beatToSeconds(end, bpms) - beatToSeconds(start, bpms) };
  }
  const beats = subtractRational(end, start);
  return { kind: 'beatsAtStartBpm', division: beats.denominator * 4, beats: beats.numerator };
}

function chartEndSeconds(chart: DisplayChart): number {
  let end = beatToSeconds(chart.endBeat, chart.bpms);
  for (const note of chart.notes) end = Math.max(end, note.endSeconds);
  return end;
}

function clampView(seconds: number, props: Pick<TimelineProps, 'snapshot' | 'difficulty' | 'trackDurationSeconds'>): number {
  const chart = currentChart(props);
  if (!chart) return Math.max(-30, Math.min(30, seconds));
  const end = Math.max(chartEndSeconds(chart), (props.trackDurationSeconds ?? 0) - (props.snapshot?.firstSeconds ?? 0));
  return Math.max(-30, Math.min(end + 30, seconds));
}

function getGeometry(width: number, height: number): Geometry {
  const gridLeft = LABEL_WIDTH + WARNING_TRACK_WIDTH;
  const localLanePitchUnits = 45;
  const localTouchWidthUnits = 47;
  const totalTrackUnits = LANE_COUNT * localLanePitchUnits + localTouchWidthUnits;
  const gridRight = Math.max(gridLeft + totalTrackUnits / localLanePitchUnits * 12, width - 8);
  const gridWidth = gridRight - gridLeft;
  const laneWidth = gridWidth * localLanePitchUnits / totalTrackUnits;
  const ringRight = gridLeft + LANE_COUNT * laneWidth;
  const touchTrackWidth = laneWidth * localTouchWidthUnits / localLanePitchUnits;
  const touchTrackLeft = ringRight;
  const touchTrackCenter = touchTrackLeft + touchTrackWidth / 2;
  const gridTop = TOP;
  const gridBottom = Math.max(gridTop + 24, height - BOTTOM);
  const playheadY = Math.max(gridTop + 8, Math.min(gridBottom - 8, height - PLAYHEAD_FROM_BOTTOM));
  const lanes = LANE_ORDER.map((position, order) => {
    const left = gridLeft + order * laneWidth;
    return { position, left, right: left + laneWidth, center: left + laneWidth / 2 };
  });
  return {
    width, height, gridLeft, gridRight, ringRight, gridWidth, gridTop, gridBottom, laneWidth,
    laneOrder: LANE_ORDER, lanes, touchTrackLeft, touchTrackWidth, touchTrackCenter, playheadY,
  };
}

function laneAtX(x: number, geometry: Geometry): number {
  const order = Math.max(0, Math.min(LANE_COUNT - 1,
    Math.floor((x - geometry.gridLeft) / geometry.laneWidth)));
  return geometry.laneOrder[order];
}

function laneForPosition(position: number, geometry: Geometry): LaneRect {
  return geometry.lanes.find((lane) => lane.position === position) ?? geometry.lanes[0];
}

function secondsAtY(y: number, geometry: Geometry, viewport: Viewport): number {
  return viewport.viewSeconds + (geometry.playheadY - y) / viewport.pixelsPerSecond;
}

function yAtSeconds(seconds: number, geometry: Geometry, viewport: Viewport): number {
  return geometry.playheadY - (seconds - viewport.viewSeconds) * viewport.pixelsPerSecond;
}

interface NoteRect {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  headY: number;
  tailY: number;
  centerX: number;
  size: number;
  hold: boolean;
}

function noteRect(note: DisplayNote, viewport: Viewport, geometry: Geometry): NoteRect {
  const lane = note.touchArea ? null : laneForPosition(note.position, geometry);
  const centerX = note.touchArea ? geometry.touchTrackCenter : lane!.center;
  const trackWidth = note.touchArea ? geometry.touchTrackWidth : geometry.laneWidth;
  const size = Math.min(24, Math.max(12, trackWidth * 0.48));
  const headY = yAtSeconds(note.startSeconds, geometry, viewport);
  const hold = note.kind === 'hold' || note.kind === 'touchHold';
  const tailY = hold ? yAtSeconds(note.endSeconds, geometry, viewport) : headY;
  const x1 = centerX - size / 2;
  const x2 = centerX + size / 2;
  return {
    x1, x2,
    y1: Math.min(headY, tailY) - size / 2,
    y2: Math.max(headY, tailY) + size / 2,
    headY, tailY, centerX, size, hold,
  };
}

function touchGroup(notes: readonly DisplayNote[], beat: Rational): DisplayNote[] {
  return notes.filter((note) => note.touchArea && compareRational(note.beat, beat) === 0);
}

function hasTouchAtSensor(chart: DisplayChart, beat: Rational, area: TouchArea, position: number): boolean {
  return chart.notes.some((note) => note.touchArea === area && note.position === position
    && compareRational(note.beat, beat) === 0);
}

function hitTest(chart: DisplayChart, point: Point, viewport: Viewport, geometry: Geometry): { note: DisplayNote; notes: DisplayNote[]; edge: HoldEdge | null } | null {
  const time = secondsAtY(point.y, geometry, viewport);
  const paddingSeconds = 16 / viewport.pixelsPerSecond;
  const notes = queryVisible(chart, Math.max(0, time - paddingSeconds), Math.max(0, time + paddingSeconds));
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const note = notes[index];
    if (Boolean(note.touchArea) !== point.touchTrack) continue;
    if (!note.touchArea && note.position !== point.lane) continue;
    const rect = noteRect(note, viewport, geometry);
    if (point.x < rect.x1 - 5 || point.x > rect.x2 + 5 || point.y < rect.y1 - 5 || point.y > rect.y2 + 5) continue;
    let edge: HoldEdge | null = null;
    if (rect.hold && !note.touchArea) {
      const headDistance = Math.abs(point.y - rect.headY);
      const tailDistance = Math.abs(point.y - rect.tailY);
      if (Math.min(headDistance, tailDistance) <= Math.max(8, rect.size * 0.7))
        edge = headDistance <= tailDistance ? 'start' : 'end';
    }
    const group = note.touchArea ? touchGroup(chart.notes, note.beat) : [note];
    return { note, notes: group, edge };
  }
  return null;
}

function hitBpmEvent(chart: DisplayChart, point: Point, viewport: Viewport, geometry: Geometry): BpmEvent | null {
  if (point.x < 0 || point.x > LABEL_WIDTH || point.y < geometry.gridTop || point.y > geometry.gridBottom) return null;
  let nearest: BpmEvent | null = null;
  let distance = 8;
  for (const event of chart.bpms) {
    const y = bpmLabelCenterY(event.beat, chart.bpms, geometry, viewport);
    const delta = Math.abs(y - point.y);
    if (delta <= distance) { nearest = event; distance = delta; }
  }
  return nearest;
}

function isHold(note: DisplayNote): boolean {
  return note.kind === 'hold' || note.kind === 'touchHold';
}

function movedNotePatch(
  note: DisplayNote,
  edge: HoldEdge | null,
  point: Point,
  deltaBeat: Rational,
  deltaLane: number,
  bpms: readonly BpmEvent[],
): Partial<Pick<Note, 'beat' | 'position' | 'duration' | 'slide'>> | null {
  let beat = note.beat;
  let duration = note.duration;
  const nextPosition = note.touchArea ? note.position : Math.max(1, Math.min(LANE_COUNT, note.position + deltaLane));
  if (isHold(note) && edge) {
    if (edge === 'start') {
      beat = point.snappedBeat;
      duration = note.duration;
    } else {
      const [start, end] = orderedBeats(note.beat, point.snappedBeat);
      beat = start;
      duration = durationBetweenBeats(start, end, bpms);
    }
  } else {
    beat = addRational(note.beat, deltaBeat);
    if (beat.numerator < 0) beat = rational(0);
  }
  if (compareRational(beat, note.beat) === 0 && nextPosition === note.position && durationEqual(duration, note.duration)) return null;
  let slide = note.slide;
  if (note.kind === 'slide' && nextPosition !== note.position) {
    let rotated: Note = note;
    const direction = nextPosition > note.position ? 'rotate-clockwise' : 'rotate-counterclockwise';
    for (let step = 0; step < Math.abs(nextPosition - note.position); step++) {
      rotated = { ...rotated, ...transformNotes([rotated], direction)[0].patch };
    }
    slide = rotated.slide;
  }
  return {
    ...(compareRational(beat, note.beat) !== 0 ? { beat } : {}),
    ...(nextPosition !== note.position ? { position: nextPosition } : {}),
    ...(duration && !durationEqual(duration, note.duration) ? { duration } : {}),
    ...(slide !== note.slide ? { slide } : {}),
  };
}

function durationEqual(left: HoldDuration | undefined, right: HoldDuration | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'short': return true;
    case 'seconds': return right.kind === 'seconds' && left.seconds === right.seconds;
    case 'beatsAtStartBpm': return right.kind === 'beatsAtStartBpm' && left.division === right.division && left.beats === right.beats;
    case 'beatsAtBpm': return right.kind === 'beatsAtBpm' && left.bpm === right.bpm && left.division === right.division && left.beats === right.beats;
  }
}

function previewMove(note: DisplayNote, gesture: Gesture, chart: DisplayChart): DisplayNote {
  if (gesture.kind !== 'move') return note;
  const patch = movedNotePatch(note, gesture.edge, gesture.current, gesture.deltaBeat, gesture.deltaLane, chart.bpms);
  if (!patch) return note;
  if (note.kind === 'slide') return displaySlide({ ...note, ...patch }, chart.bpms);
  const beat = patch.beat ?? note.beat;
  const position = patch.position ?? note.position;
  const duration = patch.duration ?? note.duration;
  const bpm = bpmAtBeat(beat, chart.bpms);
  const startSeconds = beatToSeconds(beat, chart.bpms);
  const length = isHold(note) ? holdDurationSeconds(duration ?? { kind: 'short' }, bpm) : 0;
  return { ...note, ...patch, beat, position, bpm, startSeconds, endSeconds: startSeconds + length };
}

function displaySlide(note: Omit<Note, 'id' | 'order'> & Partial<Pick<Note, 'id' | 'order'>>, bpms: readonly BpmEvent[]): DisplayNote {
  return compileNote({ ...note, id: note.id ?? '$slide-placement', order: note.order ?? 0 }, bpms);
}

function previewPastedNotes(paste: PendingPaste, hover: Point, bpms: readonly BpmEvent[]): DisplayNote[] {
  const previewBpms = paste.bpms.length ? mergeBpmEvents(bpms, shiftedPasteBpms(paste, hover.snappedBeat)) : bpms;
  return paste.notes.map(({ sourceRange: _range, ...note }, index) => compileNote({
    ...note,
    id: `$paste-preview-${index}`,
    order: index,
    beat: addRational(hover.snappedBeat, subtractRational(note.beat, paste.origin)),
  }, previewBpms));
}

function shiftedPasteBpms(paste: PendingPaste, target: Rational): BpmEvent[] {
  return paste.bpms.map((event) => ({
    beat: addRational(target, subtractRational(event.beat, paste.origin)),
    bpm: event.bpm,
  }));
}

function createPlacementPreview(pending: PendingHold, endpoint: Point, chart: DisplayChart): DisplayNote {
  const [startBeat, endBeat] = orderedBeats(pending.beat, endpoint.snappedBeat);
  const bpm = bpmAtBeat(startBeat, chart.bpms);
  const startSeconds = beatToSeconds(startBeat, chart.bpms);
  const duration = durationBetweenBeats(startBeat, endBeat, chart.bpms);
  const endSeconds = beatToSeconds(endBeat, chart.bpms);
  const kind = pending.kind;
  const touchArea = kind === 'touchHold' ? pending.touchArea : undefined;
  return {
    id: '$placement', kind, beat: startBeat,
    position: touchArea === 'C' ? 0 : pending.position,
    ...(touchArea ? { touchArea } : {}),
    order: 0, modifiers: { break: false, ex: false }, duration,
    bpm, startSeconds, endSeconds,
  };
}

function paintTimeline(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  props: PaintProps,
  viewport: Viewport,
  chartSeconds: number,
  gesture: Gesture | null,
  pendingRing: PendingHold | null,
  pendingTouch: PendingHold | null,
  hover: Point | null,
  fastCursor: Point | null,
  images: Map<string, HTMLImageElement> | null,
  geometry: Geometry,
  pendingSlide: SlidePlacement | null,
  pendingPaste: PendingPaste | null,
): void {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#10141d';
  context.fillRect(0, 0, width, height);
  const chart = currentChart(props);
  const topSeconds = secondsAtY(geometry.gridTop, geometry, viewport);
  const bottomSeconds = secondsAtY(geometry.gridBottom, geometry, viewport);
  const viewStart = Math.max(0, Math.min(topSeconds, bottomSeconds));
  const viewEnd = Math.max(viewStart, Math.max(topSeconds, bottomSeconds));

  drawWaveform(context, props.waveform ?? null, props.snapshot?.firstSeconds ?? 0, viewport, geometry);
  drawTrackBackground(context, geometry);
  if (chart) drawGrid(context, chart, viewStart, viewEnd, viewport, geometry, props.snapDivision, props.selectedBpmBeats);

  if (chart) {
    context.save();
    context.beginPath();
    context.rect(geometry.gridLeft, geometry.gridTop, geometry.gridWidth, geometry.gridBottom - geometry.gridTop);
    context.clip();
    const notes = queryVisible(chart, viewStart, viewEnd);
    const touchGroups = new Map<string, DisplayNote[]>();
    const slides: DisplayNote[] = [];
    for (const note of notes) {
      if (note.kind === 'slide') {
        slides.push(note);
        continue;
      }
      if (note.touchArea) {
        const beat = rational(note.beat.numerator, note.beat.denominator);
        const key = `${beat.numerator}/${beat.denominator}`;
        const group = touchGroups.get(key) ?? [];
        group.push(note);
        touchGroups.set(key, group);
        continue;
      }
      const ghost = gesture?.kind === 'move' && gesture.notes.some((item) => item.id === note.id)
        ? previewMove(note, gesture, chart)
        : note;
      drawNote(context, ghost, viewport, geometry, props.selectedIds.includes(note.id), ghost !== note, images);
    }
    for (const group of touchGroups.values()) {
      const moved = gesture?.kind === 'move'
        ? group.map((note) => gesture.notes.some((item) => item.id === note.id)
          ? previewMove(note, gesture, chart) : note)
        : group;
      const selected = group.some((note) => props.selectedIds.includes(note.id));
      const ghost = moved.some((note, index) => note !== group[index]);
      drawTouchGroup(context, moved, viewport, geometry, selected, ghost, images);
    }
    for (const note of slides) {
      const moved = gesture?.kind === 'move' && gesture.notes.some(item => item.id === note.id)
        ? previewMove(note, gesture, chart) : note;
      drawSlideGuide(context, moved, viewport, geometry, images, props.selectedIds.includes(note.id));
    }

    if (pendingSlide) {
      if (pendingSlide.moveBeat) {
        const endBeat = pendingSlide.endBeat ?? (hover && compareRational(hover.snappedBeat, pendingSlide.moveBeat) >= 0
          ? hover.snappedBeat : pendingSlide.moveBeat);
        const draft = finishSlidePlacement({ ...pendingSlide, endBeat,
          endPosition: pendingSlide.endPosition ?? hover?.lane ?? pendingSlide.startPosition }, props.slideWifi ? 'w' : '<', {
          head: props.slideHead, slideBreak: props.slideBreak, modifiers: props.ringModifiers,
        }, chart.bpms);
        drawSlideGuide(context, displaySlide(draft, chart.bpms), viewport, geometry, images, true);
      } else {
        const startSeconds = beatToSeconds(pendingSlide.hitBeat, chart.bpms);
        drawNote(context, { id: '$slide-hit', order: 0, kind: 'tap', beat: pendingSlide.hitBeat,
          position: pendingSlide.startPosition, forceStar: props.slideHead !== 'tap', modifiers: props.ringModifiers,
          startSeconds, endSeconds: startSeconds, bpm: bpmAtBeat(pendingSlide.hitBeat, chart.bpms) },
        viewport, geometry, true, true, images);
      }
    }

    if (pendingPaste && hover && hover.x >= geometry.gridLeft && hover.x <= geometry.gridRight
      && hover.y >= geometry.gridTop && hover.y <= geometry.gridBottom) {
      if (pendingPaste.bpms.length) drawPastedBpmGhosts(context, pendingPaste, hover, chart.bpms, viewport, geometry);
      const pasted = previewPastedNotes(pendingPaste, hover, chart.bpms);
      const touchGroups = new Map<string, DisplayNote[]>();
      for (const note of pasted) {
        if (note.kind === 'slide') {
          drawSlideGuide(context, note, viewport, geometry, images, true);
        } else if (note.touchArea) {
          const key = `${note.beat.numerator}/${note.beat.denominator}`;
          const group = touchGroups.get(key) ?? [];
          group.push(note);
          touchGroups.set(key, group);
        } else {
          drawNote(context, note, viewport, geometry, false, true, images);
        }
      }
      for (const group of touchGroups.values()) drawTouchGroup(context, group, viewport, geometry, false, true, images);
    }

    if (fastCursor && !pendingRing) {
      const bpm = bpmAtBeat(fastCursor.snappedBeat, chart.bpms);
      const seconds = beatToSeconds(fastCursor.snappedBeat, chart.bpms);
      drawNote(context, {
        id: '$fast-pointer', kind: props.ringTool, beat: fastCursor.snappedBeat,
        position: fastCursor.lane, order: 0, modifiers: props.ringModifiers,
        forceStar: props.ringTool === 'tap' && props.ringForceStar,
        ...(props.ringTool === 'hold' ? { duration: { kind: 'short' as const } } : {}),
        bpm, startSeconds: seconds, endSeconds: seconds,
      }, viewport, geometry, true, true, images);
    }

    const pending = hover?.touchTrack ? pendingTouch : pendingRing;
    if (pending && hover) {
      const preview = createPlacementPreview(pending, hover, chart);
      if (pending.kind === 'hold') preview.modifiers = props.ringModifiers;
      else preview.firework = props.touchFirework;
      drawNote(context, preview, viewport, geometry, true, true, images, 'pointer');
    } else if (props.tool === 'touch' && hover?.touchTrack) {
      const touchArea = props.touchArea;
      const beat = hover.snappedBeat;
      const bpm = bpmAtBeat(beat, chart.bpms);
      const startSeconds = beatToSeconds(beat, chart.bpms);
      drawNote(context, {
        id: '$touch-pointer', kind: 'touch', beat, firework: props.touchFirework,
        position: touchArea === 'C' ? 0 : props.touchPosition,
        touchArea,
        order: 0, modifiers: { break: false, ex: false }, bpm, startSeconds, endSeconds: startSeconds,
      }, viewport, geometry, false, true, images, 'pointer');
    } else if (gesture?.kind === 'place' && gesture.noteKind !== 'hold' && gesture.noteKind !== 'touchHold' && gesture.noteKind !== 'slide') {
      const point = gesture.current;
      const beat = point.snappedBeat;
      const bpm = bpmAtBeat(beat, chart.bpms);
      const startSeconds = beatToSeconds(beat, chart.bpms);
      drawNote(context, {
        id: '$placement', kind: gesture.noteKind, beat,
        forceStar: gesture.noteKind === 'tap' && props.ringForceStar,
        position: point.lane,
        order: 0, modifiers: props.ringModifiers, bpm, startSeconds, endSeconds: startSeconds,
      }, viewport, geometry, true, true, images);
    }
    context.restore();
  }

  if (gesture?.kind === 'box') drawSelectionBox(context, gesture);

  const playheadY = yAtSeconds(chartSeconds, geometry, viewport);
  if (playheadY >= geometry.gridTop && playheadY <= geometry.gridBottom) {
    context.strokeStyle = '#ff656c';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(geometry.gridLeft, Math.round(playheadY) + 0.5);
    context.lineTo(geometry.gridRight, Math.round(playheadY) + 0.5);
    context.stroke();
    context.fillStyle = '#ff656c';
    context.beginPath();
    context.moveTo(geometry.gridLeft - 1, playheadY - 5);
    context.lineTo(geometry.gridLeft + 6, playheadY);
    context.lineTo(geometry.gridLeft - 1, playheadY + 5);
    context.closePath();
    context.fill();
  }

  context.fillStyle = '#8998ad';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.font = '9px ui-monospace, SFMono-Regular, monospace';
  context.fillText(`${viewport.pixelsPerSecond.toFixed(0)} px/s`, width - 8, height - 9);
  context.fillStyle = '#9ba9bd';
  context.textAlign = 'left';
  context.font = '9px ui-monospace, SFMono-Regular, monospace';
  const referenceY = geometry.playheadY;
  context.fillText(`${viewport.viewSeconds.toFixed(2)}s`, 3, referenceY - 10);
  if (pendingPaste) {
    context.font = '11px ui-sans-serif, sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    const label = '粘贴预览：左键确认，右键取消';
    const x = geometry.gridLeft + 8;
    const y = height - 10;
    const textWidth = context.measureText(label).width;
    context.fillStyle = 'rgba(20, 28, 41, .94)';
    context.fillRect(x - 5, y - 10, textWidth + 10, 20);
    context.strokeStyle = '#63e4d0';
    context.strokeRect(x - 4.5, y - 9.5, textWidth + 9, 19);
    context.fillStyle = '#dce8f0';
    context.fillText(label, x, y);
  }
}

function drawTrackBackground(context: CanvasRenderingContext2D, geometry: Geometry): void {
  const { gridLeft, gridRight, ringRight, gridTop, gridBottom } = geometry;
  for (const lane of geometry.lanes) {
    context.fillStyle = lane.position % 2 === 0 ? '#151c28' : '#121924';
    context.fillRect(lane.left, gridTop, geometry.laneWidth, gridBottom - gridTop);
    context.strokeStyle = '#293547';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(Math.round(lane.left) + 0.5, gridTop);
    context.lineTo(Math.round(lane.left) + 0.5, gridBottom);
    context.stroke();
    context.fillStyle = '#8a99ad';
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.font = '10px ui-monospace, SFMono-Regular, monospace';
    context.fillText(String(lane.position), lane.center, gridTop - 5);
  }
  context.strokeStyle = '#425064';
  context.beginPath();
  context.moveTo(ringRight + 0.5, gridTop);
  context.lineTo(ringRight + 0.5, gridBottom);
  context.stroke();

  context.fillStyle = 'rgba(199, 167, 242, .10)';
  context.fillRect(geometry.touchTrackLeft, gridTop, geometry.touchTrackWidth, gridBottom - gridTop);
  context.fillStyle = '#c7a7f2';
  context.textAlign = 'center';
  context.textBaseline = 'bottom';
  context.font = 'bold 10px ui-monospace, SFMono-Regular, monospace';
  context.fillText('Touch', geometry.touchTrackCenter, gridTop - 5);

  context.strokeStyle = '#344154';
  context.beginPath();
  context.moveTo(gridLeft, gridTop + 0.5);
  context.lineTo(gridRight, gridTop + 0.5);
  context.moveTo(gridLeft, gridBottom - 0.5);
  context.lineTo(gridRight, gridBottom - 0.5);
  context.stroke();
}

function drawGrid(
  context: CanvasRenderingContext2D,
  chart: DisplayChart,
  viewStart: number,
  viewEnd: number,
  viewport: Viewport,
  geometry: Geometry,
  snapDivision: number | undefined,
  selectedBpmBeats: readonly string[],
): void {
  const division = validDivision(snapDivision);
  const firstBeat = Math.floor(secondsToBeat(viewStart, chart.bpms) * division) / division;
  const lastBeat = secondsToBeat(viewEnd, chart.bpms);
  const startIndex = Math.floor(firstBeat * division);
  const endIndex = Math.ceil(lastBeat * division);
  const gridCount = Math.min(1200, Math.max(0, endIndex - startIndex + 1));
  context.font = '9px ui-monospace, SFMono-Regular, monospace';
  context.textBaseline = 'middle';
  for (let index = 0; index < gridCount; index += 1) {
    const beat = rational(index + startIndex, division);
    const y = yAtSeconds(beatToSeconds(beat, chart.bpms), geometry, viewport);
    if (y < geometry.gridTop - 1 || y > geometry.gridBottom + 1) continue;
    const wholeBeat = beat.denominator === 1;
    context.strokeStyle = wholeBeat ? '#384556' : '#202a39';
    context.lineWidth = wholeBeat ? 1 : 0.65;
    context.beginPath();
    context.moveTo(geometry.gridLeft, Math.round(y) + 0.5);
    context.lineTo(geometry.gridRight, Math.round(y) + 0.5);
    context.stroke();
    if (wholeBeat) {
      context.fillStyle = '#8290a4';
      context.textAlign = 'right';
      context.fillText(String(beat.numerator), LABEL_WIDTH - 5, y);
    }
  }
  for (const bpm of chart.bpms) {
    const lineY = yAtSeconds(beatToSeconds(bpm.beat, chart.bpms), geometry, viewport);
    const labelY = lineY - 7;
    if (lineY >= geometry.gridTop && lineY <= geometry.gridBottom) {
      const label = String(bpm.bpm);
      const labelWidth = context.measureText(label).width;
      if (selectedBpmBeats.includes(rationalKey(bpm.beat))) {
        context.fillStyle = 'rgba(99, 228, 208, .28)';
        context.fillRect(LABEL_WIDTH - labelWidth - 8, labelY - 7, labelWidth + 6, 14);
        context.strokeStyle = '#63e4d0';
        context.lineWidth = 1;
        context.strokeRect(LABEL_WIDTH - labelWidth - 8.5, labelY - 7.5, labelWidth + 7, 15);
      }
      context.fillStyle = '#c58bf2';
      context.fillRect(geometry.gridLeft, lineY, geometry.gridWidth, 1);
      context.fillStyle = '#bd91e2';
      context.textAlign = 'right';
      context.fillText(label, LABEL_WIDTH - 5, labelY);
    }
  }
}

function bpmLabelCenterY(beat: Rational, bpms: readonly BpmEvent[], geometry: Geometry, viewport: Viewport): number {
  return yAtSeconds(beatToSeconds(beat, bpms), geometry, viewport) - 7;
}

function drawPastedBpmGhosts(
  context: CanvasRenderingContext2D,
  paste: PendingPaste,
  hover: Point,
  bpms: readonly BpmEvent[],
  viewport: Viewport,
  geometry: Geometry,
): void {
  const incoming = new Map<string, BpmEvent>();
  for (const event of shiftedPasteBpms(paste, hover.snappedBeat)) incoming.set(rationalKey(event.beat), event);
  const prospectiveBpms = mergeBpmEvents(bpms, [...incoming.values()]);
  context.save();
  context.strokeStyle = '#63e4d0';
  context.fillStyle = '#83f3de';
  context.lineWidth = 1.5;
  context.setLineDash([4, 3]);
  context.font = 'bold 9px ui-monospace, SFMono-Regular, monospace';
  context.textAlign = 'left';
  context.textBaseline = 'bottom';
  for (const event of incoming.values()) {
    const y = yAtSeconds(beatToSeconds(event.beat, prospectiveBpms), geometry, viewport);
    if (y < geometry.gridTop || y > geometry.gridBottom) continue;
    context.beginPath();
    context.moveTo(geometry.gridLeft, y);
    context.lineTo(geometry.gridRight, y);
    context.stroke();
    context.fillText(`${event.bpm} BPM`, geometry.gridLeft + 3, y - 3);
  }
  context.restore();
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  waveform: WaveformPyramid | null,
  firstSeconds: number,
  viewport: Viewport,
  geometry: Geometry,
): void {
  const waveLeft = 3;
  const waveRight = Math.max(waveLeft + 8, LABEL_WIDTH - 20);
  const centerX = (waveLeft + waveRight) / 2;
  context.strokeStyle = '#203541';
  context.beginPath();
  context.moveTo(centerX, geometry.gridTop);
  context.lineTo(centerX, geometry.gridBottom);
  context.stroke();
  if (!waveform?.levels.length || !waveform.sampleRateHz) return;

  let chosen = waveform.levels[0];
  for (const level of waveform.levels) {
    const pixelSpan = level.samplesPerBin / waveform.sampleRateHz * viewport.pixelsPerSecond;
    if (pixelSpan <= 1.5) chosen = level;
    else break;
  }
  const visibleStartSong = Math.max(0, secondsAtY(geometry.gridBottom, geometry, viewport) + firstSeconds);
  const visibleEndSong = Math.max(visibleStartSong, secondsAtY(geometry.gridTop, geometry, viewport) + firstSeconds);
  const startBin = Math.max(0, Math.floor(visibleStartSong * waveform.sampleRateHz / chosen.samplesPerBin));
  const endBin = Math.min(chosen.min[0].length, Math.ceil(visibleEndSong * waveform.sampleRateHz / chosen.samplesPerBin));
  const amplitude = Math.max(2, (waveRight - waveLeft) * 0.44);
  for (let channel = 0; channel < chosen.min.length; channel += 1) {
    context.strokeStyle = channel === 0 ? '#4f91a8' : '#467d91';
    context.lineWidth = 1;
    context.beginPath();
    for (let bin = startBin; bin < endBin; bin += 1) {
      const songSeconds = bin * chosen.samplesPerBin / waveform.sampleRateHz;
      const chartSeconds = songSeconds - firstSeconds;
      const y = yAtSeconds(chartSeconds, geometry, viewport);
      const low = centerX - chosen.max[channel][bin] * amplitude;
      const high = centerX - chosen.min[channel][bin] * amplitude;
      context.moveTo(low, y);
      context.lineTo(high, y);
    }
    context.stroke();
  }
}

function drawNote(
  context: CanvasRenderingContext2D,
  note: DisplayNote,
  viewport: Viewport,
  geometry: Geometry,
  selected: boolean,
  ghost: boolean,
  images: Map<string, HTMLImageElement> | null,
  marker: 'timeline' | 'pointer' | false = 'timeline',
): void {
  if (note.kind === 'slide') return;
  const rect = noteRect(note, viewport, geometry);
  if (marker && note.touchArea && note.firework && images) {
    drawTouchFireworkMarker(context, images, rect.centerX, rect.headY, rect.size,
      note.kind === 'touchHold' ? 'touchHold' : 'touch', marker, ghost && marker !== 'pointer' ? 0.65 : 1);
  }
  context.save();
  context.globalAlpha = ghost ? 0.65 : 1;
  if (rect.hold) {
    context.strokeStyle = selected ? '#f4c45e' : note.modifiers.break ? '#ff8c69' : '#aebbd0';
    context.lineWidth = Math.max(3, rect.size * 0.36);
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(rect.centerX, rect.headY);
    context.lineTo(rect.centerX, rect.tailY);
    context.stroke();
    if (selected) {
      context.strokeStyle = '#fff0bd';
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(rect.centerX, rect.headY);
      context.lineTo(rect.centerX, rect.tailY);
      context.stroke();
    }
  }
  if (selected) {
    context.strokeStyle = '#fff0bd';
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(rect.centerX, rect.headY, rect.size * 0.72, rect.size * 0.72, 0, 0, Math.PI * 2);
    context.stroke();
    if (rect.hold && Math.abs(rect.tailY - rect.headY) > 2) {
      context.beginPath();
      context.ellipse(rect.centerX, rect.tailY, rect.size * 0.58, rect.size * 0.58, 0, 0, Math.PI * 2);
      context.stroke();
    }
  }
  if (images) {
    // Static skin glyphs carry the target's shape, break/EX treatment, and Hold slices.
    drawNoteGlyph(context, note, rect.centerX, rect.headY, rect.size, images);
  }
  context.restore();
}

function drawSlideGuide(
  context: CanvasRenderingContext2D,
  note: DisplayNote,
  viewport: Viewport,
  geometry: Geometry,
  images: Map<string, HTMLImageElement> | null,
  selected = false,
): void {
  const paths = displaySlidePaths(note);
  paths.forEach((path, index) => drawSingleSlideGuide(context, path, viewport, geometry, images, selected, index === 0, note));
}

function drawSingleSlideGuide(
  context: CanvasRenderingContext2D,
  note: DisplayNote & { segments?: DisplaySlideSegment[] },
  viewport: Viewport,
  geometry: Geometry,
  images: Map<string, HTMLImageElement> | null,
  selected: boolean,
  drawHead: boolean,
  headNote: DisplayNote,
): void {
  const slide = note.slide;
  if (!slide || note.moveStartSeconds === undefined) return;
  const startX = laneForPosition(note.position, geometry).center;
  const endX = laneForPosition(slide.endPosition, geometry).center;
  const headY = yAtSeconds(note.startSeconds, geometry, viewport);
  const moveY = yAtSeconds(note.moveStartSeconds, geometry, viewport);
  const endY = yAtSeconds(note.endSeconds, geometry, viewport);

  // Timeline-only duration guides: the original SlideEdit path sprite is not reproduced here.
  context.save();
  context.lineCap = 'round';
  context.lineWidth = Math.max(2, Math.min(4, geometry.laneWidth * 0.07));
  context.strokeStyle = selected ? '#fff0bd' : slide.slideBreak ? '#ff9d79' : '#78bce9';
  context.globalAlpha = 0.58;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(startX, headY);
  context.lineTo(startX, moveY);
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 0.8;
  context.beginPath();
  context.moveTo(startX, moveY);
  if (note.segments?.length) {
    for (const segment of note.segments) {
      context.lineTo(laneForPosition(segment.endPosition, geometry).center,
        yAtSeconds(segment.endSeconds, geometry, viewport));
    }
  } else context.lineTo(endX, endY);
  context.stroke();
  context.restore();

  if (drawHead && (selected || slide.head === 'none')) {
    context.save();
    context.strokeStyle = selected ? '#fff0bd' : '#78bce9';
    context.lineWidth = selected ? 2 : 1;
    context.strokeRect(startX - 16, headY - 16, 32, 32);
    context.restore();
  }

  if (drawHead && images && slide.head !== 'none') {
    const size = Math.min(24, Math.max(12, geometry.laneWidth * 0.48));
    drawSkinPartsGlyph(context, slideHeadParts(headNote, iconFrame), startX, headY, size, images);
  }
}

function drawTouchGroup(
  context: CanvasRenderingContext2D,
  group: readonly DisplayNote[],
  viewport: Viewport,
  geometry: Geometry,
  selected: boolean,
  ghost: boolean,
  images: Map<string, HTMLImageElement> | null,
): void {
  const aggregateModifiers = {
    break: group.some((note) => note.modifiers.break),
    ex: group.some((note) => note.modifiers.ex),
  };
  const aggregateEach = group.some((note) => note.isEach);
  const touch = group.find((note) => note.kind === 'touch');
  if (images && group.some((note) => note.firework)) {
    const representative = touch ?? group[0];
    const rect = noteRect(representative, viewport, geometry);
    drawTouchFireworkMarker(context, images, rect.centerX, rect.headY, rect.size,
      representative.kind === 'touchHold' ? 'touchHold' : 'touch', 'timeline', ghost ? 0.65 : 1);
  }
  if (touch) drawNote(context, { ...touch, modifiers: aggregateModifiers, isEach: aggregateEach }, viewport, geometry, selected, ghost, images, false);
  const longestHold = group.filter((note) => note.kind === 'touchHold')
    .reduce<DisplayNote | undefined>((longest, note) => !longest || note.endSeconds > longest.endSeconds ? note : longest, undefined);
  if (longestHold) drawNote(context, { ...longestHold, modifiers: aggregateModifiers, isEach: aggregateEach }, viewport, geometry, selected, ghost, images, false);
}

function drawSelectionBox(context: CanvasRenderingContext2D, gesture: Extract<Gesture, { kind: 'box' }>): void {
  context.strokeStyle = '#75c6f1';
  context.fillStyle = 'rgba(72, 156, 205, .12)';
  const x = Math.min(gesture.start.x, gesture.current.x);
  const y = Math.min(gesture.start.y, gesture.current.y);
  const width = Math.abs(gesture.current.x - gesture.start.x);
  const height = Math.abs(gesture.current.y - gesture.start.y);
  context.fillRect(x, y, width, height);
  context.strokeRect(x + 0.5, y + 0.5, width, height);
}
