import slidePaths from './slide-paths.json';

type Point = readonly [number, number];

interface PathResource {
  name: string;
  points: Point[];
  splitIndexes: number[];
  length: number;
  enterAreaData: { area: number; timeRate: number }[];
  warningLength: number;
}

interface PathResources {
  commands: Record<string, Record<string, number>>;
  paths: Record<string, PathResource>;
  wifiStars: { start: Point; ends: Point[] };
}

export interface ResolvedSlidePath extends PathResource {
  id: number;
  command: '-' | '<' | '>' | 'v' | 's' | 'z';
  distance: number;
  rotation: number;
}

type PathGeometry = Pick<ResolvedSlidePath, 'points' | 'splitIndexes' | 'length' | 'rotation'>;

export interface SlidePoint {
  x: number;
  y: number;
  rotation: number;
}

export interface SlidePathSample {
  point: SlidePoint;
  /** Last source point included by SlideLineMono's point-count loop. */
  lastPointIndex: number;
}

export interface SlideLineSegment {
  rendererIndex: number;
  sourceStartIndex: number;
  sourceEndIndex: number;
  points: Point[];
}

export interface SlideFrame {
  visible: boolean;
  alpha: number;
  starVisible: boolean;
  starAlpha: number;
  starScale: number;
  progress: number;
}

const resources = slidePaths as unknown as PathResources;
const FADE_SECONDS = 0.2;
const STAR_REVEAL_THRESHOLD = 0.001;

function assertButton(button: number): void {
  if (!Number.isInteger(button) || button < 1 || button > 8) {
    throw new RangeError(`Slide button must be an integer from 1 to 8: ${button}`);
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rotate(point: Point, degrees: number): Point {
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [cosine * point[0] - sine * point[1], sine * point[0] + cosine * point[1]];
}

function sourceTangentDegrees(from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  const angle = Math.acos(Math.max(-1, Math.min(1, dx / length))) * 180 / Math.PI;
  return (dy < 0 ? -angle : angle) + 90;
}

/** Resolves serialized straight, v, s/z, and < / > paths. Points stay in Unity's Y-up local space. */
export function resolvePath(command: string, start: number, end: number, middle?: number): ResolvedSlidePath {
  assertButton(start);
  assertButton(end);
  if (command !== '-' && command !== '<' && command !== '>' && command !== 'v' && command !== 's' && command !== 'z') {
    throw new RangeError(`Unsupported slide path command: ${command}`);
  }
  if (middle !== undefined) throw new RangeError(`Middle-button paths are not supported: ${command}`);

  let distance = end - start;
  if (distance < 0) distance += 8;
  const commandKey = start >= 3 && start <= 6
    ? command === '<' ? '>' : command === '>' ? '<' : command
    : command;
  const id = resources.commands[commandKey]?.[String(distance)];
  if (id === undefined) throw new RangeError(`No serialized ${command} path from ${start} to ${end}`);
  const path = resources.paths[String(id)];
  if (!path) throw new RangeError(`Missing serialized slide path ${id}`);
  return { ...path, id, command: commandKey as ResolvedSlidePath['command'], distance,
    rotation: (start - 1) * -45 };
}

/** Replays SlideLineMono's source loop, including its un-interpolated final segment. */
export function samplePathAtProgress(path: PathGeometry, progress: number): SlidePathSample {
  if (!Number.isFinite(progress)) throw new RangeError(`Slide progress must be finite: ${progress}`);
  const percent = clamp01(progress);
  const remaining = path.length * (1 - percent) - 0.001;
  let traversed = 0;
  let previous = 0;
  let pointIndex = 1;
  let last = path.points[0];
  let localPoint = path.points[path.points.length - 1];
  let localRotation = 0;

  for (let index = 1; index < path.points.length; index += 1) {
    const nextPoint = path.points[index];
    if (traversed > remaining) {
      if (index < 2) {
        localPoint = path.points[0];
        break;
      }
      const from = path.points[index - 2];
      const to = path.points[index - 1];
      const segmentLength = Math.hypot(to[0] - from[0], to[1] - from[1]);
      const amount = (remaining - previous) / segmentLength;
      localPoint = [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount];
      localRotation = sourceTangentDegrees(from, to);
      break;
    }
    pointIndex += 1;
    previous = traversed;
    traversed += Math.hypot(last[0] - nextPoint[0], last[1] - nextPoint[1]);
    last = nextPoint;
  }

  const [x, y] = rotate(localPoint, path.rotation);
  return { point: { x, y, rotation: path.rotation + localRotation }, lastPointIndex: pointIndex - 1 };
}

/** Samples the source path by its original update loop and applies the root lane rotation. */
export function pointAtProgress(path: PathGeometry, progress: number): SlidePoint {
  return samplePathAtProgress(path, progress).point;
}

function roundToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

/** Recreates each LineRenderer point slice and its source 0.5-unit end stretch. */
export function lineSegmentsAtProgress(path: PathGeometry, progress: number): SlideLineSegment[] {
  const { lastPointIndex } = samplePathAtProgress(path, progress);
  const segments: SlideLineSegment[] = [];
  let startIndex = 0;
  for (let rendererIndex = 0; rendererIndex <= path.splitIndexes.length; rendererIndex += 1) {
    const splitIndex = path.splitIndexes[rendererIndex];
    const endIndex = splitIndex !== undefined && splitIndex < lastPointIndex + 1
      ? splitIndex
      : lastPointIndex;
    if (endIndex > startIndex) {
      const points = path.points.slice(startIndex, endIndex + 1).map(([x, y]) => [x, y] as Point);
      let length = 0;
      for (let index = 0; index < points.length - 1; index += 1) {
        length += Math.hypot(points[index + 1][0] - points[index][0], points[index + 1][1] - points[index][1]);
      }
      const last = points.length - 1;
      const lastLength = Math.hypot(points[last][0] - points[last - 1][0], points[last][1] - points[last - 1][1]);
      const snappedLength = roundToEven(length / 0.5) * 0.5;
      const stretch = (lastLength + snappedLength - length) / lastLength;
      points[last] = [
        points[last - 1][0] + (points[last][0] - points[last - 1][0]) * stretch,
        points[last - 1][1] + (points[last][1] - points[last - 1][1]) * stretch,
      ];
      segments.push({ rendererIndex, sourceStartIndex: startIndex, sourceEndIndex: endIndex, points });
    }
    startIndex = endIndex;
  }
  return segments;
}

/** Recreates SlideLineControl's visibility, pre-reveal, and absolute-time motion state. */
export function slideFrame(hit: number, moveStart: number, end: number, now: number): SlideFrame {
  if (end < moveStart) throw new RangeError(`Slide end cannot precede move start: ${moveStart}..${end}`);
  const visible = hit - now < FADE_SECONDS && now < end;
  const reveal = now < hit ? 0 : now < moveStart ? (now - hit) / (moveStart - hit) : 1;
  const progress = now < moveStart || end === moveStart ? 0 : clamp01((now - moveStart) / (end - moveStart));
  return {
    visible,
    alpha: 1 - (hit - now) / FADE_SECONDS,
    starVisible: visible && reveal > STAR_REVEAL_THRESHOLD,
    starAlpha: reveal,
    starScale: 0.4 + 0.6 * reveal,
    progress,
  };
}

/** Returns the three source-verified Wi-Fi star positions in Unity Y-up space. */
export function wifiStarPositions(progress: number, startButton = 1): SlidePoint[] {
  assertButton(startButton);
  if (!Number.isFinite(progress)) throw new RangeError(`Slide progress must be finite: ${progress}`);
  const percent = clamp01(progress);
  const rootRotation = (startButton - 1) * -45;
  const [startX, startY] = resources.wifiStars.start;
  return resources.wifiStars.ends.map((end) => {
    const localPoint: Point = [startX + (end[0] - startX) * percent, startY + (end[1] - startY) * percent];
    const [x, y] = rotate(localPoint, rootRotation);
    return { x, y, rotation: rootRotation + sourceTangentDegrees(resources.wifiStars.start, end) };
  });
}
