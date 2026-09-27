import type { DisplayNote, Note } from '../../../../packages/chart-core/src/types.js';
import parameters from './parameters.json';
import slideParameters from './slide-parameters.json';
import { ringSkinKey } from './assets.js';

export interface FrameState {
  distance: number; scale: number; alpha: number; length: number;
  endpointVisible: boolean; touchSpread: number; progress: number;
}
export interface SkinPart {
  key: string;
  x: number; y: number; rotation: number; scaleX: number; scaleY: number;
  width: number; height: number; anchorX: number; anchorY: number;
  alpha: number; tint: number;
  /** Left, top, right, bottom, in source pixels. */
  borders?: [number, number, number, number];
  progress?: number;
}
interface Transform { position: number[]; rotation: number[]; scale: number[] }
interface SpriteParameters {
  rect: { x: number; y: number; width: number; height: number };
  pivot: number[]; border: number[]; ppu: number;
}
interface Renderer {
  role: string; sprite: SpriteParameters; size: number[]; mode: number; order: number;
  color: number[]; transforms: Transform[];
}
export interface Prefab { sprites: Record<string, SpriteParameters | null>; renderers: Renderer[] }
const prefabs = parameters.prefabs as Record<Exclude<Note['kind'], 'slide'>, Prefab>;
export const ringRadius = Math.hypot(...parameters.tracks[0].position.slice(0, 2));
export const touchPositions: Record<string, number[]> = parameters.touchPositions;
export const noteSortingOrder = (kind: Exclude<Note['kind'], 'slide'>): number =>
  parameters.prefabs[kind].sortingGroups[0].sortingOrder;
const angle = (q: number[]) => 2 * Math.atan2(q[2], q[3]);
const color = (rgb: number[]) => (Math.round(rgb[0] * 255) << 16) | (Math.round(rgb[1] * 255) << 8) | Math.round(rgb[2] * 255);

/** Result uses screen Y-down coordinates, in original scene units. */
export function notePlacement(note: DisplayNote, frame: FrameState) {
  if (note.touchArea) {
    const point = touchPositions[note.touchArea === 'C' ? 'C' : `${note.touchArea}${note.position}`];
    return { x: point[0], y: -point[1], rotation: 0, scale: 1 };
  }
  const track = parameters.tracks[note.position - 1];
  const rotation = angle(track.rotation);
  const distance = Math.min(3.6, Math.max(0, frame.distance));
  return { x: track.position[0] - Math.sin(rotation) * distance,
    y: -track.position[1] - Math.cos(rotation) * distance, rotation: -rotation, scale: frame.scale };
}

/** Same serialized Sprite composition is consumed by Canvas and Pixi. */
export function composeNote(note: DisplayNote, frame: FrameState): SkinPart[] {
  // Slide heads and paths have separate source prefabs.
  if (note.kind === 'slide') return [];
  if (note.kind === 'tap' && note.forceStar) return composePrefab(note, frame, slideParameters.head as Prefab, 'star');
  return composePrefab(note, frame, prefabs[note.kind]);
}

/** Shared source transform and Sprite rules, including the separate Slide head prefab. */
export function composePrefab(note: DisplayNote, frame: FrameState, prefab: Prefab, ringFamily?: 'star' | 'star.double'): SkinPart[] {
  const parts: (SkinPart & { order: number })[] = [];
  const isEach = Boolean(note.isEach);
  for (const renderer of prefab.renderers) {
    const role = renderer.role;
    if (role === 'exModel' && !note.modifiers.ex) continue;
    if (role === 'endPoint' && !frame.endpointVisible) continue;
    let key: string;
    let sprite = renderer.sprite;
    let alpha = frame.alpha;
    let tint = color(renderer.color);
    if (role === 'noteModel') {
      key = ringSkinKey(ringFamily ?? note.kind as 'tap' | 'hold', isEach, note.modifiers.break);
      sprite = prefab.sprites[note.modifiers.break ? 'breakSprite' : isEach ? 'multiSprite' : 'singleSprite']!;
    } else if (role === 'exModel') {
      key = `${ringFamily ?? note.kind}.ex`;
      tint = color(note.modifiers.break ? [1, 0.69, 0.23] : isEach ? [1, 1, 0.35]
        : ringFamily?.startsWith('star') ? [0.22, 0.71, 0.92] : [0.95, 0.69, 0.86]);
    } else if (role === 'endPoint') {
      key = `hold.end.${note.modifiers.break ? 'break' : isEach ? 'each' : 'base'}`;
      sprite = prefab.sprites[note.modifiers.break ? 'breakEndPoint' : isEach ? 'multiEndPoint' : 'singleEndPoint']!;
    } else if (role === 'centerModel') {
      key = `touch.point.${note.kind === 'touch' && isEach ? 'each' : 'base'}`;
      if (note.kind === 'touch') sprite = prefab.sprites[isEach ? 'centerMultiSprite' : 'centerSingleSprite']!;
    } else if (role.startsWith('triangleModels.')) {
      key = note.kind === 'touchHold' ? `touchhold.${role.split('.')[1]}` : `touch.${isEach ? 'each' : 'base'}`;
      if (note.kind === 'touch') sprite = prefab.sprites[isEach ? 'multiSprite' : 'singleSprite']!;
    } else {
      key = 'touchhold.border';
      alpha = 1; // TouchMono.SetAlpha updates center and triangles only.
    }

    let x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1;
    renderer.transforms.forEach((transform, index) => {
      let [tx, ty] = transform.position;
      if (index === renderer.transforms.length - 1) {
        if (role === 'endPoint') ty = frame.length;
        if (role.startsWith('triangleModels.')) { tx = 0; ty = frame.touchSpread; }
      }
      x += Math.cos(rotation) * tx * scaleX - Math.sin(rotation) * ty * scaleY;
      y += Math.sin(rotation) * tx * scaleX + Math.cos(rotation) * ty * scaleY;
      rotation += angle(transform.rotation);
      scaleX *= transform.scale[0];
      scaleY *= transform.scale[1];
    });
    const sliced = renderer.mode === 1;
    parts.push({ key, x, y: -y, rotation: -rotation, scaleX, scaleY,
      width: sliced ? renderer.size[0] : sprite.rect.width / 100,
      height: sliced ? 1.4 + frame.length : sprite.rect.height / 100,
      anchorX: sprite.pivot[0], anchorY: 1 - sprite.pivot[1], alpha, tint,
      borders: sliced ? [sprite.border[0], sprite.border[3], sprite.border[2], sprite.border[1]] : undefined,
      progress: role === 'holdModel' ? frame.progress : undefined,
      order: renderer.order,
    });
  }
  return parts.sort((a, b) => a.order - b.order);
}

export const iconFrame: FrameState = { distance: 0, scale: 1, alpha: 1, length: 0, endpointVisible: true, touchSpread: 0, progress: 1 };
