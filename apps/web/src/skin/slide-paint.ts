import slideMatchPaths from './slide-match-paths.json';

export type SlidePaintPoint = readonly [number, number];

interface SlideTypeInfo {
  sourceOrder: number;
  command: string;
  centerDistance: number;
  pathId: number;
}

interface SlidePaintPath {
  id: number;
  name: string;
  length: number;
  points: readonly (readonly [number, number, number])[];
}

interface SlidePaintSelectionSet {
  startPosition: number;
  endPosition: number;
  candidateSourceOrders: readonly number[];
}

interface SlidePaintResources {
  infos: readonly SlideTypeInfo[];
  paths: readonly SlidePaintPath[];
  selectionSets: readonly SlidePaintSelectionSet[];
}

export interface SlidePaintMatch {
  command: string;
  start: number;
  end: number;
  middle?: number;
  supported: boolean;
  pathId: number;
  pathName: string;
  sourceOrder: number;
  score: number;
}

const resources = slideMatchPaths as unknown as SlidePaintResources;
const pathsById = new Map(resources.paths.map((path) => [path.id, path]));
const infosByOrder = new Map(resources.infos.map((info) => [info.sourceOrder, info]));
const selectionsByRoute = new Map(resources.selectionSets.map((set) => [`${set.startPosition}:${set.endPosition}`, set]));
const supportedCommands = new Set(['-', '<', '>', 'v', 's', 'z']);

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));
}

function rotatePoint(point: SlidePaintPoint, start: number): readonly [number, number, number] {
  const radians = (start - 1) * Math.PI / 4;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [cosine * point[0] - sine * point[1], sine * point[0] + cosine * point[1], 0];
}

function samplePainting(points: readonly (readonly [number, number, number])[], paintLength: number, percent: number): readonly [number, number, number] {
  if (percent <= 0.001) return points[0];
  let length = 0;
  let previousPercent = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    length += distance(from, to);
    const nextPercent = length / paintLength;
    if (nextPercent >= percent) {
      const amount = (percent - previousPercent) / (nextPercent - previousPercent);
      const clamped = Math.min(1, Math.max(0, amount));
      return [
        from[0] + (to[0] - from[0]) * clamped,
        from[1] + (to[1] - from[1]) * clamped,
        from[2] + (to[2] - from[2]) * clamped,
      ];
    }
    previousPercent = nextPercent;
  }
  return points[points.length - 1];
}

function pathScore(
  painting: readonly (readonly [number, number, number])[],
  paintLength: number,
  path: SlidePaintPath,
): number {
  let traversed = 0;
  let total = 0;
  for (let index = path.points.length - 1; index >= 0; index -= 1) {
    const vertex = path.points[index];
    const point = samplePainting(painting, paintLength, traversed / path.length);
    total += distance(vertex, point);
    if (index === 0) break;
    traversed += distance(vertex, path.points[index - 1]);
  }
  return total / path.points.length;
}

/** Replays SlideUtility.SelectSlideFromPath, including its source candidate order and last-wins ties. */
export function selectSlideFromPath(
  paintingPositions: readonly SlidePaintPoint[],
  start: number,
  end: number,
): SlidePaintMatch | null {
  const selection = selectionsByRoute.get(`${start}:${end}`);
  if (!selection || paintingPositions.length < 2) return null;

  const painting = paintingPositions.map((point) => rotatePoint(point, start));
  let paintLength = 0;
  for (let index = 0; index < painting.length - 1; index += 1)
    paintLength += distance(painting[index], painting[index + 1]);

  let selected: SlidePaintMatch | null = null;
  let bestScore = Infinity;
  for (const sourceOrder of selection.candidateSourceOrders) {
    const info = infosByOrder.get(sourceOrder)!;
    const path = pathsById.get(info.pathId)!;
    const score = pathScore(painting, paintLength, path);
    if (selected !== null && score > bestScore) continue;

    let command = info.command;
    if (start >= 3 && start <= 6) {
      if (command === '<') command = '>';
      else if (command === '>') command = '<';
    }
    let middle: number | undefined;
    if (info.centerDistance !== 0) {
      middle = start + info.centerDistance;
      if (middle > 8) middle -= 8;
    }
    selected = {
      command,
      start,
      end,
      ...(middle === undefined ? {} : { middle }),
      supported: supportedCommands.has(command),
      pathId: path.id,
      pathName: path.name,
      sourceOrder,
      score,
    };
    bestScore = score;
  }
  return selected;
}
