import { Application, Graphics, Text } from 'pixi.js';
import { forwardRef, useEffect, useImperativeHandle, useRef, type PointerEvent } from 'react';
import { queryVisible } from '../../../../packages/chart-core/src/index.js';
import type { DisplayChart, DisplayNote, DisplaySnapshot } from '../../../../packages/chart-core/src/types.js';
import sceneParameters from '../skin/parameters.json';
import { notePlacement, ringRadius, touchPositions } from '../skin/composition.js';
import { noteFrame } from '../skin/note-state.js';
import { PixiNoteLayer, preloadNoteTextures, noteSpriteEntry, type NoteSpriteEntry } from '../skin/pixi.js';
import { slideHeadEntry } from '../skin/slide-head.js';
import { PixiSlideLayer, preloadSlideTextures } from '../skin/pixi-slide.js';
import { nearestPlaceArea, previewTransform, type PlaceArea } from './place-area.js';
import './CircularPreview.css';

const LOOK_AHEAD_SECONDS = 2.5;
const LANE_COUNT = 8;
const TOUCH_AREA_COLORS: Record<NonNullable<DisplayNote['touchArea']>, number> = {
  A: 0xf0c978,
  B: 0x7ed6c1,
  C: 0xc7a7f2,
  D: 0xf29c7d,
  E: 0x94b5f2,
};

export interface CircularPreviewHandle {
  draw(chartSeconds: number): void;
}

export interface CircularPreviewProps {
  snapshot: DisplaySnapshot | null;
  difficulty: number;
  selectedIds: string[];
  playheadSeconds?: number;
  placing?: boolean;
  playing?: boolean;
  editingDisabled?: boolean;
  onPlaceArea?: (key: string, chartSeconds: number) => void;
  onApplyAreaTemplate?: (key: string, chartSeconds: number) => void;
  onRemoveArea?: (key: string, chartSeconds: number) => void;
  onSelection?: (ids: string[]) => void;
  onError?: (message: string) => void;
}

interface PreviewResources {
  app: Application;
  board: Graphics;
  selection: Graphics;
  pointer: Graphics;
  skin: PixiNoteLayer;
  slides: PixiSlideLayer;
  skinReady: boolean;
  skinSnapshot: DisplaySnapshot | null;
  skinDifficulty: number;
  skinRequest: number;
  dispose: () => void;
  labels: Text[];
  centerLabel: Text;
  touchLabels: Map<string, Text>;
  width: number;
  height: number;
}

export const CircularPreview = forwardRef<CircularPreviewHandle, CircularPreviewProps>(function CircularPreview(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const resourcesRef = useRef<PreviewResources | null>(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const lastChartSeconds = useRef(props.playheadSeconds ?? 0);
  const hoverArea = useRef<PlaceArea | null>(null);
  const stroke = useRef<{ pointerId: number; button: number; lastArea: string | null } | null>(null);

  const canEdit = () => {
    const current = latestProps.current;
    return Boolean(resourcesRef.current && currentChart(current)?.editable && !current.playing && !current.editingDisabled
      && lastChartSeconds.current >= -0.002);
  };

  const repaint = () => {
    const resources = resourcesRef.current;
    if (!resources) return;
    if (skinReadyFor(resources, latestProps.current)) drawPreviewNotes(resources, latestProps.current, lastChartSeconds.current);
    else {
      resources.selection.clear();
      for (const label of resources.touchLabels.values()) label.visible = false;
    }
    resources.pointer.clear();
    const area = hoverArea.current;
    if (area && canEdit()) {
      const transform = previewTransform(resources.width, resources.height);
      const x = transform.x + area.position[0] * transform.scale;
      const y = transform.y - area.position[1] * transform.scale;
      resources.pointer.circle(x, y, 10).stroke({ color: 0xffe6a4, width: 2 });
      resources.pointer.moveTo(x - 4, y).lineTo(x + 4, y).moveTo(x, y - 4).lineTo(x, y + 4)
        .stroke({ color: 0xffe6a4, width: 1 });
    }
    hostRef.current?.setAttribute('data-place-area', area && canEdit() ? area.key : '');
    resources.app.render();
    const host = hostRef.current;
    if (host?.hasAttribute('data-measure-slides')) {
      const count = String(resources.slides.visibleStripCount);
      if (host.dataset.slideStrips !== count) host.dataset.slideStrips = count;
    }
  };

  const setSkinReady = (ready: boolean) => {
    panelRef.current?.setAttribute('data-skin-ready', String(ready));
  };

  const updateTimeStatus = () => {
    if (!statusRef.current) return;
    statusRef.current.textContent = latestProps.current.snapshot
      ? `谱面时间 ${lastChartSeconds.current.toFixed(2)} s`
      : '尚未载入谱面';
  };

  const refreshSkin = (resources: PreviewResources) => {
    const request = ++resources.skinRequest;
    const current = latestProps.current;
    const chart = currentChart(current);
    updateTimeStatus();
    resources.skinReady = false;
    setSkinReady(false);
    resources.selection.clear();
    resources.skin.render([], resources.width / 2, resources.height / 2 + 4, 1);
    resources.slides.render([], 0, resources.width / 2, resources.height / 2 + 4, 1);
    if (!chart) {
      resources.skinReady = true;
      resources.skinSnapshot = current.snapshot;
      resources.skinDifficulty = current.difficulty;
      setSkinReady(true);
      repaint();
      return;
    }
    void Promise.all([preloadNoteTextures(chart.notes), preloadSlideTextures(chart.notes)]).then(() => {
      if (resourcesRef.current !== resources || resources.skinRequest !== request) return;
      resources.skinReady = true;
      resources.skinSnapshot = current.snapshot;
      resources.skinDifficulty = current.difficulty;
      setSkinReady(true);
      repaint();
    }).catch((cause: unknown) => {
      if (resourcesRef.current !== resources || resources.skinRequest !== request) return;
      resources.skinReady = false;
      setSkinReady(false);
      resources.dispose();
      resourcesRef.current = null;
      latestProps.current.onError?.(`圆形预览皮肤加载失败：${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };

  useImperativeHandle(ref, () => ({
    draw(chartSeconds: number) {
      lastChartSeconds.current = chartSeconds;
      updateTimeStatus();
      repaint();
    },
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let initialized = false;
    let destroyed = false;
    let slideLayer: PixiSlideLayer | null = null;
    const application = new Application();
    const destroyApplication = () => {
      if (!initialized || destroyed) return;
      destroyed = true;
      slideLayer?.destroy();
      application.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
    };

    void application.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      autoStart: false,
      antialias: true,
      backgroundColor: 0x10141d,
      preference: 'webgl',
    }).then(() => {
      initialized = true;
      if (cancelled) {
        destroyApplication();
        return;
      }
      application.ticker.stop();
      host.appendChild(application.canvas);
      const board = new Graphics();
      const selection = new Graphics();
      const pointer = new Graphics();
      const skin = new PixiNoteLayer();
      const slides = new PixiSlideLayer();
      slideLayer = slides;
      application.stage.addChild(board, slides.container, skin.container, selection);
      const labels = Array.from({ length: LANE_COUNT }, (_, index) => {
        const label = new Text({
          text: String(index + 1),
          style: { fill: '#c5d0dd', fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: '600' },
        });
        label.anchor.set(0.5);
        application.stage.addChild(label);
        return label;
      });
      const centerLabel = new Text({
        text: 'C',
        style: { fill: '#c7a7f2', fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: '700' },
      });
      centerLabel.anchor.set(0.5);
      application.stage.addChild(centerLabel);
      const touchLabels = new Map<string, Text>();
      for (const area of ['A', 'B', 'D', 'E'] as const) {
        for (let position = 1; position <= LANE_COUNT; position += 1) {
          const label = new Text({
            text: `${area}${position}`,
            style: { fill: `#${TOUCH_AREA_COLORS[area].toString(16).padStart(6, '0')}`, fontFamily: 'ui-monospace, monospace', fontSize: 8, fontWeight: '700' },
          });
          label.anchor.set(0.5);
          label.visible = false;
          touchLabels.set(`${area}${position}`, label);
          application.stage.addChild(label);
        }
      }
      const resources: PreviewResources = {
        app: application, board, selection, pointer, skin, slides, skinReady: false, skinRequest: 0, dispose: destroyApplication,
        skinSnapshot: null, skinDifficulty: latestProps.current.difficulty,
        labels, centerLabel, touchLabels,
        width: Math.max(1, host.clientWidth), height: Math.max(1, host.clientHeight),
      };
      application.stage.addChild(pointer);
      resourcesRef.current = resources;
      paintBoard(resources);
      refreshSkin(resources);
      repaint();
    }).catch((cause: unknown) => {
      resourcesRef.current?.dispose();
      resourcesRef.current = null;
      if (!cancelled) latestProps.current.onError?.(`圆形预览启动失败：${cause instanceof Error ? cause.message : String(cause)}`);
    });

    const observer = new ResizeObserver(() => {
      const resources = resourcesRef.current;
      if (!resources) return;
      resources.width = Math.max(1, host.clientWidth);
      resources.height = Math.max(1, host.clientHeight);
      resources.app.renderer.resize(resources.width, resources.height);
      paintBoard(resources);
      repaint();
    });
    observer.observe(host);

    return () => {
      cancelled = true;
      observer.disconnect();
      resourcesRef.current = null;
      destroyApplication();
    };
  }, []);

  useEffect(() => {
    const resources = resourcesRef.current;
    if (resources) refreshSkin(resources);
  }, [props.snapshot, props.difficulty]);

  useEffect(() => {
    lastChartSeconds.current = props.playheadSeconds ?? lastChartSeconds.current;
    updateTimeStatus();
    repaint();
  }, [props.selectedIds, props.playheadSeconds]);

  const endStroke = () => {
    const active = stroke.current;
    stroke.current = null;
    if (active && hostRef.current?.hasPointerCapture(active.pointerId)) hostRef.current.releasePointerCapture(active.pointerId);
  };

  useEffect(() => {
    endStroke();
    hoverArea.current = null;
    repaint();
  }, [props.snapshot?.generation, props.difficulty, props.placing, props.playing, props.editingDisabled]);

  useEffect(() => {
    const cancel = () => { endStroke(); hoverArea.current = null; repaint(); };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', cancel);
    };
  }, []);

  const areaAt = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = hostRef.current?.getBoundingClientRect();
    if (!bounds || !canEdit()) return null;
    const transform = previewTransform(bounds.width, bounds.height);
    return nearestPlaceArea((event.clientX - bounds.left - transform.x) / transform.scale,
      -(event.clientY - bounds.top - transform.y) / transform.scale);
  };

  const applyArea = (area: PlaceArea | null) => {
    const active = stroke.current;
    if (!active || !area || !canEdit() || active.lastArea === area.key) return;
    active.lastArea = area.key;
    const callback = active.button === 2 ? latestProps.current.onRemoveArea : latestProps.current.onPlaceArea;
    callback?.(area.key, lastChartSeconds.current);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = stroke.current;
    if (active && active.pointerId !== event.pointerId) return;
    hoverArea.current = areaAt(event);
    if (active?.pointerId === event.pointerId) {
      if (!(event.buttons & (active.button === 2 ? 2 : 1))) endStroke();
      else applyArea(hoverArea.current);
    }
    repaint();
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    if (event.button === 1) {
      if (!canEdit() || stroke.current) return;
      event.preventDefault();
      hoverArea.current = areaAt(event);
      if (hoverArea.current) latestProps.current.onApplyAreaTemplate?.(hoverArea.current.key, lastChartSeconds.current);
      repaint();
      return;
    }
    if (event.button === 2 || latestProps.current.placing) {
      if (!canEdit() || stroke.current) return;
      event.preventDefault();
      hostRef.current?.setPointerCapture(event.pointerId);
      stroke.current = { pointerId: event.pointerId, button: event.button, lastArea: null };
      hoverArea.current = areaAt(event);
      applyArea(hoverArea.current);
      repaint();
      return;
    }
    const chart = currentChart(latestProps.current);
    const resources = resourcesRef.current;
    const callback = latestProps.current.onSelection;
    if (!chart || !resources || !callback || !skinReadyFor(resources, latestProps.current)) return;
    const bounds = hostRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const centerX = resources.width / 2;
    const centerY = resources.height / 2 + 4;
    const radius = Math.min(resources.width, resources.height) * 0.36;
    const unitScale = radius / ringRadius;
    const candidates = previewEntries(chart, lastChartSeconds.current);
    let closest: { id: string; distance: number } | null = null;
    for (const entry of candidates) {
      const markerX = centerX + entry.placement.x * unitScale;
      const markerY = centerY + entry.placement.y * unitScale;
      const distance = Math.hypot(markerX - x, markerY - y);
      if (distance <= 20 && (!closest || distance < closest.distance)) closest = { id: entry.note.id, distance };
    }
    callback(closest ? [closest.id] : []);
  };

  return (
    <div ref={panelRef} className="circular-preview-panel" data-testid="circular-preview" data-skin-ready="false">
      <div ref={statusRef} className="circular-preview-status" aria-hidden="true">
        {props.snapshot ? `谱面时间 ${lastChartSeconds.current.toFixed(2)} s` : '尚未载入谱面'}
      </div>
      <div ref={hostRef} className="circular-preview-canvas" aria-label="圆形谱面预览"
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          if (stroke.current?.pointerId === event.pointerId && stroke.current.button === event.button) endStroke();
        }}
        onPointerCancel={(event) => {
          if (stroke.current?.pointerId !== event.pointerId) return;
          endStroke(); hoverArea.current = null; repaint();
        }}
        onLostPointerCapture={(event) => { if (stroke.current?.pointerId === event.pointerId) endStroke(); }}
        onPointerLeave={(event) => {
          if (stroke.current && stroke.current.pointerId !== event.pointerId) return;
          hoverArea.current = null; repaint();
        }}
        onContextMenu={(event) => event.preventDefault()} />
    </div>
  );
});

function currentChart(props: Pick<CircularPreviewProps, 'snapshot' | 'difficulty'>): DisplayChart | null {
  return props.snapshot?.charts.find((chart) => chart.difficulty === props.difficulty) ?? null;
}

function skinReadyFor(resources: PreviewResources, props: CircularPreviewProps): boolean {
  return resources.skinReady && resources.skinSnapshot === props.snapshot && resources.skinDifficulty === props.difficulty;
}

function visibleNotes(chart: DisplayChart, chartSeconds: number): DisplayNote[] {
  const start = Math.max(0, chartSeconds - 0.2);
  const end = Math.max(start, chartSeconds + LOOK_AHEAD_SECONDS);
  return queryVisible(chart, start, end);
}

function previewEntries(chart: DisplayChart, chartSeconds: number): NoteSpriteEntry[] {
  return visibleNotes(chart, chartSeconds).flatMap((note) => {
    if (note.kind === 'slide') return [];
    const frame = noteFrame(note, chartSeconds);
    return frame.visible ? [{ note, frame, placement: notePlacement(note, frame) }] : [];
  });
}

function paintBoard(resources: PreviewResources): void {
  const { board, labels, centerLabel, width, height } = resources;
  board.clear();
  const centerX = width / 2;
  const centerY = height / 2 + 4;
  const size = Math.min(width, height);
  const radius = size * 0.36;
  const unitScale = radius / ringRadius;
  board.circle(centerX, centerY, size * 0.47).fill({ color: 0x141b26 });
  board.circle(centerX, centerY, radius + 2).fill({ color: 0x1a2532 }).stroke({ color: 0x48576a, width: 1.5 });
  board.circle(centerX, centerY, radius * 0.54).fill({ color: 0x10141d }).stroke({ color: 0x273647, width: 1 });
  board.circle(centerX, centerY, radius * 0.18).fill({ color: 0x17212d }).stroke({ color: 0x34465b, width: 1 });
  for (const area of ['B', 'E', 'A', 'D'] as const) {
    for (let position = 1; position <= LANE_COUNT; position += 1) {
      const source = touchPositions[`${area}${position}`];
      board.circle(centerX + source[0] * unitScale, centerY - source[1] * unitScale, Math.max(2, size * 0.009))
        .fill({ color: TOUCH_AREA_COLORS[area], alpha: 0.28 });
    }
  }
  for (let lane = 0; lane < LANE_COUNT; lane += 1) {
    const position = sceneParameters.tracks[lane].position;
    const x = centerX + position[0] * unitScale;
    const y = centerY - position[1] * unitScale;
    const inner = radius * 0.54;
    const outer = radius + 1;
    const trackLength = Math.hypot(position[0], position[1]);
    const ux = position[0] / trackLength;
    const uy = -position[1] / trackLength;
    board.moveTo(centerX + ux * inner, centerY + uy * inner)
      .lineTo(centerX + ux * outer, centerY + uy * outer)
      .stroke({ color: 0x344256, width: 1 });
    board.circle(x, y, Math.max(4, size * 0.018))
      .fill({ color: 0xe9d59b, alpha: 0.82 });
    const labelRadius = radius + size * 0.075;
    labels[lane].position.set(centerX + ux * labelRadius, centerY + uy * labelRadius);
    labels[lane].alpha = 0.85;
  }
  centerLabel.position.set(centerX, centerY);
  centerLabel.alpha = 0.9;
}

function drawPreviewNotes(
  resources: PreviewResources,
  props: CircularPreviewProps,
  chartSeconds: number,
): void {
  const { width, height, skin, slides, selection, touchLabels } = resources;
  const chart = currentChart(props);
  for (const label of touchLabels.values()) label.visible = false;
  if (!chart) {
    skin.render([], width / 2, height / 2 + 4, 1);
    slides.render([], chartSeconds, width / 2, height / 2 + 4, 1);
    selection.clear();
    return;
  }
  const centerX = width / 2;
  const centerY = height / 2 + 4;
  const radius = Math.min(width, height) * 0.36;
  const unitScale = radius / ringRadius;
  const entries = previewEntries(chart, chartSeconds);
  const visible = visibleNotes(chart, chartSeconds);
  const heads = visible.flatMap((note) => {
    if (note.kind !== 'slide') return [];
    const head = slideHeadEntry(note, chartSeconds);
    return head ? [head] : [];
  });
  skin.renderParts([...entries.map(noteSpriteEntry), ...heads], centerX, centerY, unitScale);
  slides.render(visible, chartSeconds, centerX, centerY, unitScale, false);
  selection.clear();
  for (const { note, placement } of entries) {
    const x = centerX + placement.x * unitScale;
    const y = centerY + placement.y * unitScale;
    if (props.selectedIds.includes(note.id)) {
      selection.circle(x, y, 16).stroke({ color: 0xffdf86, width: 2.5, alpha: 0.96 });
    }
    if (note.touchArea && note.touchArea !== 'C') {
      const label = touchLabels.get(`${note.touchArea}${note.position}`);
      if (label) {
        label.position.set(x + 11, y - 10);
        label.visible = true;
      }
    }
  }
}
