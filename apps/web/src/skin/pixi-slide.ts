import { Container } from 'pixi.js';
import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { ringSkinKey } from './assets.js';
import { iconFrame } from './composition.js';
import { loadSkinTexture, PixiNoteLayer, type SkinSpriteEntry } from './pixi.js';
import { PixiSlideStrips, type SlideStripEntry } from './pixi-slide-strips.js';
import { composeSlide } from './slide-composition.js';
import { slideHeadEntry, slideHeadParts } from './slide-head.js';
import { displaySlidePaths } from './display-slide-paths.js';
import { orderSlideStripGroups, type SlideStripGroup } from './slide-strip-order.js';
import parameters from './slide-parameters.json';

export async function preloadSlideTextures(notes: readonly DisplayNote[]): Promise<void> {
  const keys = new Set<string>();
  for (const note of notes) {
    if (note.kind !== 'slide') continue;
    for (const part of slideHeadParts(note, iconFrame)) keys.add(part.key);
    keys.add(ringSkinKey('star', Boolean(note.isSlideEach), note.slide!.slideBreak));
    for (const path of displaySlidePaths(note)) {
      const composition = composeSlide(path, path.moveStartSeconds ?? path.startSeconds);
      for (const part of composition.parts) keys.add(part.key);
      for (const strip of composition.strips) keys.add(strip.key);
    }
  }
  await Promise.all([...keys].map(loadSkinTexture));
}

/** Renders each shared-head path independently; editing remains controlled by Chart Core. */
export class PixiSlideLayer {
  readonly container = new Container();
  private readonly strips = new PixiSlideStrips();
  private readonly arrows = new PixiNoteLayer();
  private readonly stars = new PixiNoteLayer();
  private readonly heads = new PixiNoteLayer();

  constructor() {
    // Source SortingGroups: Wi-Fi 2, line 3, moving stars 4, heads 5.
    this.container.addChild(this.arrows.container, this.strips.container, this.stars.container, this.heads.container);
  }

  render(notes: readonly DisplayNote[], nowSeconds: number, centerX: number, centerY: number, unitScale: number, includeHeads = true): void {
    const stripGroups: SlideStripGroup<SlideStripEntry>[] = [];
    const arrows: SkinSpriteEntry[] = [];
    const stars: SkinSpriteEntry[] = [];
    const heads: SkinSpriteEntry[] = [];
    const slideNotes = notes.filter((note) => note.kind === 'slide');
    const orderedNotes = [...slideNotes]
      .sort((a, b) => (b.moveStartSeconds ?? b.startSeconds) - (a.moveStartSeconds ?? a.startSeconds));
    for (const note of orderedNotes) {
      const head = includeHeads ? slideHeadEntry(note, nowSeconds) : null;
      if (head) heads.push(head);
    }
    const orderedPaths = slideNotes.flatMap((note) => displaySlidePaths(note)
      .map((path, pathIndex) => ({ note, path, pathIndex })));
    for (const { note, path, pathIndex } of orderedPaths) {
      const composition = composeSlide(path, nowSeconds);
      if (!composition.visible) continue;
      const placement = { x: 0, y: 0, rotation: 0, scale: 1 };
      const layerId = path.id;
      const arrowParts = composition.parts.filter((part) => part.key.startsWith('wifi.'));
      const starParts = composition.parts.filter((part) => part.key.startsWith('star.'));
      if (arrowParts.length) arrows.push({ id: layerId, parts: arrowParts, placement, depth: path.moveStartSeconds });
      if (starParts.length) {
        const depth = (path.moveStartSeconds ?? path.startSeconds) / 100
          + (composition.activeSegmentIndex ?? 0) * 0.001;
        stars.push({ id: layerId, parts: starParts, placement, depth });
      }
      const stripsBySegment = new Map<number, SlideStripEntry[]>();
      composition.strips.forEach((strip) => {
        const line = parameters.slideLine.lines[strip.rendererIndex].parameters;
        const points = Array.from({ length: strip.positions.length / 2 }, (_, index) => ({
          x: strip.positions[index * 2], y: strip.positions[index * 2 + 1],
        }));
        const routeId = pathIndex === 0 ? note.id : `${note.id}:path:${pathIndex}`;
        const stripId = strip.segmentIndex === 0
          ? `${routeId}:${strip.rendererIndex}`
          : `${routeId}:segment:${strip.segmentIndex}:${strip.rendererIndex}`;
        const entries = stripsBySegment.get(strip.segmentIndex) ?? [];
        entries.push({ id: stripId, key: strip.key,
          rendererIndex: strip.rendererIndex,
          points, alpha: strip.alpha,
          width: line.widthMultiplier * line.widthCurve.m_Curve[0].value,
          textureScale: strip.textureScale.map((scale, index) => scale * strip.material.textureScale[index]),
          textureOffset: strip.material.textureOffset,
        });
        stripsBySegment.set(strip.segmentIndex, entries);
      });
      for (const [segmentIndex, entries] of stripsBySegment) {
        stripGroups.push({
          depth: (path.moveStartSeconds ?? path.startSeconds) / 100 + segmentIndex * 0.001,
          strips: entries,
        });
      }
    }
    this.arrows.renderParts(arrows, centerX, centerY, unitScale);
    this.stars.renderParts(stars, centerX, centerY, unitScale);
    this.heads.renderParts(heads, centerX, centerY, unitScale);
    this.strips.render(orderSlideStripGroups(stripGroups), centerX, centerY, unitScale);
  }

  /** Existing visible meshes only; queried by opt-in performance measurements. */
  get visibleStripCount(): number {
    return this.strips.container.children.reduce((count, mesh) => count + Number(mesh.visible && mesh.alpha > 0), 0);
  }

  destroy(): void {
    this.arrows.destroy();
    this.stars.destroy();
    this.heads.destroy();
    this.strips.destroy();
    this.container.destroy();
  }
}
