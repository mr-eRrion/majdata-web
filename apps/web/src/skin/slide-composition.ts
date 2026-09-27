import type { DisplaySlideSegment } from '../../../../packages/chart-core/src/types.js';
import type { DisplaySlidePathNote } from './display-slide-paths.js';
import type { SkinPart } from './composition.js';
import slideParameters from './slide-parameters.json';
import {
  lineSegmentsAtProgress,
  pointAtProgress,
  resolvePath,
  slideFrame,
  wifiStarPositions,
} from './slide-path.js';

type Vec2 = readonly [number, number];
interface Sprite { name: string; rect: { width: number; height: number }; pivot: number[]; ppu: number }
interface Transform { position: number[]; rotation: number[]; scale: number[] }
interface Renderer {
  role: string; sprite: Sprite | null; order: number; color: number[]; transforms: Transform[];
  parameters?: {
    widthMultiplier: number; widthCurve: unknown; alignment: number; textureMode: number;
    textureScale: number[]; useWorldSpace: boolean;
  };
}
interface Material {
  texture: { width: number; height: number };
  textureScale: number[]; textureOffset: number[]; colors: Record<string, number[]>;
}
interface SlideParameters {
  starModel: { sprites: Record<'single' | 'multi' | 'break', Sprite>; renderers: Renderer[] };
  slideLine: { lines: Renderer[]; materials: Record<'normal' | 'each' | 'break', Material> };
  wifi: {
    arrows: Renderer[];
    sprites: Record<'single' | 'multi' | 'break', Sprite[]>;
  };
}

export interface SlideStrip {
  key: string;
  rendererIndex: number;
  sourceStartIndex: number;
  sourceEndIndex: number;
  segmentIndex: number;
  /** Flat x/y pairs in screen-Y-down scene units, with the lane rotation applied. */
  positions: number[];
  alpha: number;
  widthMultiplier: number;
  widthCurve: unknown;
  alignment: number;
  textureMode: number;
  textureScale: Vec2;
  material: Material;
}

export interface SlideComposition {
  /** Visibility of the path, moving star, and Wi-Fi group; head is composed separately. */
  visible: boolean;
  alpha: number;
  progress: number;
  strips: SlideStrip[];
  parts: (SkinPart & { order: number })[];
  head: { kind: 'star' | 'tap' | 'none'; lane: number };
  /** Connected ring segment currently owning the moving star, at source fragment boundaries too. */
  activeSegmentIndex?: number;
}

const parameters = slideParameters as unknown as SlideParameters;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const radians = (degrees: number) => degrees * Math.PI / 180;
const quaternionAngle = (rotation: number[]) => 2 * Math.atan2(rotation[2], rotation[3]);
const materialStyle = (note: DisplaySlidePathNote): 'normal' | 'each' | 'break' =>
  note.slide!.slideBreak ? 'break' : note.isSlideEach ? 'each' : 'normal';
const colorInt = (rgba: number[]) =>
  (Math.round(rgba[0] * 255) << 16) | (Math.round(rgba[1] * 255) << 8) | Math.round(rgba[2] * 255);

interface TransformState { x: number; y: number; rotation: number; scaleX: number; scaleY: number }

/** The instance root is replaced by the runtime; child transforms remain serialized. */
function childTransform(chain: Transform[]): TransformState {
  let x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1;
  for (const transform of chain.slice(1)) {
    const [tx, ty] = transform.position;
    x += Math.cos(rotation) * tx * scaleX - Math.sin(rotation) * ty * scaleY;
    y += Math.sin(rotation) * tx * scaleX + Math.cos(rotation) * ty * scaleY;
    rotation += quaternionAngle(transform.rotation);
    scaleX *= transform.scale[0];
    scaleY *= transform.scale[1];
  }
  return { x, y, rotation, scaleX, scaleY };
}

function transformPoint(point: Vec2, transform: TransformState): Vec2 {
  return [
    transform.x + Math.cos(transform.rotation) * point[0] * transform.scaleX - Math.sin(transform.rotation) * point[1] * transform.scaleY,
    transform.y + Math.sin(transform.rotation) * point[0] * transform.scaleX + Math.cos(transform.rotation) * point[1] * transform.scaleY,
  ];
}

function rotate(point: Vec2, degrees: number): Vec2 {
  const angle = radians(degrees);
  return [Math.cos(angle) * point[0] - Math.sin(angle) * point[1], Math.sin(angle) * point[0] + Math.cos(angle) * point[1]];
}

function scenePoint(point: Vec2, laneRotation: number): Vec2 {
  const [x, y] = rotate(point, laneRotation);
  return [x, -y];
}

function spritePart(
  key: string,
  sprite: Sprite,
  transform: TransformState,
  center: Vec2,
  rotation: number,
  dynamicScale: number,
  alpha: number,
  tint: number,
  order: number,
): SkinPart & { order: number } {
  const offset = rotate([transform.x * dynamicScale, transform.y * dynamicScale], rotation);
  const worldX = center[0] + offset[0];
  const worldY = center[1] + offset[1];
  return {
    key,
    x: worldX,
    y: -worldY,
    rotation: -(radians(rotation) + transform.rotation),
    scaleX: transform.scaleX * dynamicScale,
    scaleY: transform.scaleY * dynamicScale,
    width: sprite.rect.width / sprite.ppu,
    height: sprite.rect.height / sprite.ppu,
    anchorX: sprite.pivot[0],
    anchorY: 1 - sprite.pivot[1],
    alpha,
    tint,
    order,
  };
}

function composeMovingStars(
  centers: { x: number; y: number; rotation: number }[],
  alpha: number,
  scale: number,
  style: 'normal' | 'each' | 'break',
): (SkinPart & { order: number })[] {
  const key = style === 'normal' ? 'star.base' : `star.${style}`;
  const spriteKey = style === 'normal' ? 'single' : style === 'each' ? 'multi' : 'break';
  return centers.flatMap((center) => parameters.starModel.renderers.map((renderer) => {
    if (!renderer.sprite) throw new Error(`Star renderer has no sprite: ${renderer.role}`);
    const sprite = parameters.starModel.sprites[spriteKey];
    const transform = childTransform(renderer.transforms);
    const tint = colorInt(renderer.color);
    const rendererAlpha = renderer.color[3] ?? 1;
    return spritePart(key, sprite, transform, [center.x, center.y], center.rotation, scale,
      alpha * rendererAlpha, tint, renderer.order);
  }));
}

function composeWifiArrows(progress: number, alpha: number, style: 'normal' | 'each' | 'break', laneRotation: number) {
  const spriteSet = style === 'normal' ? 'single' : style === 'each' ? 'multi' : 'break';
  const keyPrefix = style === 'normal' ? 'base' : style;
  const hiddenCount = Math.floor(progress * parameters.wifi.arrows.length);
  const parts: (SkinPart & { order: number })[] = [];
  for (let index = hiddenCount; index < parameters.wifi.arrows.length; index += 1) {
    const renderer = parameters.wifi.arrows[index];
    const sprite = parameters.wifi.sprites[spriteSet][index];
    const transform = childTransform(renderer.transforms);
    const [x, y] = scenePoint([transform.x, transform.y], laneRotation);
    parts.push({
      key: `wifi.${keyPrefix}.${index}`,
      x,
      y,
      rotation: -(radians(laneRotation) + transform.rotation),
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      width: sprite.rect.width / sprite.ppu,
      height: sprite.rect.height / sprite.ppu,
      anchorX: sprite.pivot[0],
      anchorY: 1 - sprite.pivot[1],
      alpha: alpha * (renderer.color[3] ?? 1),
      tint: colorInt(renderer.color),
      order: renderer.order,
    });
  }
  return parts;
}

interface TimedPathSegment {
  data: DisplaySlideSegment;
  path: ReturnType<typeof resolvePath>;
}

function timedPathSegments(note: DisplaySlidePathNote): TimedPathSegment[] {
  const slide = note.slide!;
  const moveStart = note.moveStartSeconds!;
  if (!note.segments && slide.continuations?.length)
    throw new TypeError(`Slide ${note.id} is missing compiled segment times`);
  const data: readonly DisplaySlideSegment[] = note.segments ?? [{
      startPosition: note.position,
      command: slide.command as DisplaySlideSegment['command'],
      endPosition: slide.endPosition,
      moveStartSeconds: moveStart,
      endSeconds: note.endSeconds,
    }];

  return data.map((segment) => ({
    data: segment,
    path: resolvePath(segment.command, segment.startPosition, segment.endPosition),
  }));
}

function pathProgress(segment: DisplaySlideSegment, nowSeconds: number): number | null {
  if (nowSeconds >= segment.endSeconds) return null;
  if (nowSeconds <= segment.moveStartSeconds || segment.endSeconds <= segment.moveStartSeconds) return 0;
  return clamp01((nowSeconds - segment.moveStartSeconds) / (segment.endSeconds - segment.moveStartSeconds));
}

function routePointAtTime(segments: readonly TimedPathSegment[], nowSeconds: number): {
  point: ReturnType<typeof pointAtProgress>;
  segmentIndex: number;
} {
  const exactEndIndex = segments.findIndex(({ data }) =>
    data.endSeconds === nowSeconds && data.endSeconds > data.moveStartSeconds);
  if (exactEndIndex >= 0) {
    return { point: pointAtProgress(segments[exactEndIndex].path, 1), segmentIndex: exactEndIndex };
  }

  const activeIndex = segments.findIndex(({ data }) =>
    data.moveStartSeconds <= nowSeconds && nowSeconds < data.endSeconds);
  if (activeIndex >= 0) {
    const active = segments[activeIndex];
    const progress = pathProgress(active.data, nowSeconds) ?? 0;
    return { point: pointAtProgress(active.path, progress), segmentIndex: activeIndex };
  }

  let startedIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].data.moveStartSeconds <= nowSeconds) {
      startedIndex = index;
      break;
    }
  }
  if (startedIndex >= 0) {
    const previous = segments[startedIndex];
    return {
      point: pointAtProgress(previous.path, nowSeconds >= previous.data.endSeconds ? 1 : 0),
      segmentIndex: startedIndex,
    };
  }
  return { point: pointAtProgress(segments[0].path, 0), segmentIndex: 0 };
}

/** Pure visual state for source-supported ring paths and atomic Wi-Fi slides. */
export function composeSlide(note: DisplaySlidePathNote, nowSeconds: number): SlideComposition {
  if (note.kind !== 'slide' || !note.slide) throw new TypeError('composeSlide requires a DisplayNote with slide data');
  if (note.moveStartSeconds === undefined) throw new TypeError(`Slide ${note.id} is missing moveStartSeconds`);

  const frame = slideFrame(note.startSeconds, note.moveStartSeconds, note.endSeconds, nowSeconds);
  const style = materialStyle(note);
  const head = { kind: note.slide.head, lane: note.position };
  if (note.slide.command === 'w' && note.slide.continuations?.length) {
    throw new RangeError('Wi-Fi slides cannot contain connected ring-path segments');
  }
  if (!frame.visible) return { visible: false, alpha: frame.alpha, progress: frame.progress, strips: [], parts: [], head };

  const laneRotation = (note.position - 1) * -45;
  if (note.slide.command === 'w') {
    const parts = composeWifiArrows(frame.progress, frame.alpha, style, laneRotation);
    if (frame.starVisible) {
      const centers = wifiStarPositions(frame.progress, note.position);
      parts.push(...composeMovingStars(centers, frame.starAlpha, frame.starScale, style));
    }
    return { visible: true, alpha: frame.alpha, progress: frame.progress, strips: [], parts, head };
  }

  const segments = timedPathSegments(note);
  const strips: SlideStrip[] = [];
  for (const [segmentIndex, timed] of segments.entries()) {
    const progress = pathProgress(timed.data, nowSeconds);
    if (progress === null) continue;
    for (const segment of lineSegmentsAtProgress(timed.path, progress)) {
      const renderer = parameters.slideLine.lines[segment.rendererIndex];
      const line = renderer.parameters;
      if (!line) throw new Error(`SlideLine renderer parameters are missing: ${segment.rendererIndex}`);
      if (line.useWorldSpace) throw new Error('World-space SlideLineRenderer is not supported by the recovered local-path model');
      const transform = childTransform(renderer.transforms);
      const positions: number[] = [];
      for (const point of segment.points) {
        const local = transformPoint(point, transform);
        const [x, y] = scenePoint(local, timed.path.rotation);
        positions.push(x, y);
      }
      const material = parameters.slideLine.materials[style];
      strips.push({
        key: `slide.${style === 'normal' ? 'base' : style}`,
        rendererIndex: segment.rendererIndex,
        sourceStartIndex: segment.sourceStartIndex,
        sourceEndIndex: segment.sourceEndIndex,
        segmentIndex,
        positions,
        alpha: frame.alpha,
        widthMultiplier: line.widthMultiplier,
        widthCurve: line.widthCurve,
        alignment: line.alignment,
        textureMode: line.textureMode,
        textureScale: [line.textureScale[0], line.textureScale[1]],
        material,
      });
    }
  }

  const starState = frame.starVisible ? routePointAtTime(segments, nowSeconds) : null;
  const parts = starState
    ? composeMovingStars([starState.point], frame.starAlpha, frame.starScale, style)
    : [];
  return { visible: true, alpha: frame.alpha, progress: frame.progress, strips, parts, head,
    activeSegmentIndex: starState?.segmentIndex };
}
