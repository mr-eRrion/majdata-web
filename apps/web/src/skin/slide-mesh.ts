export interface SlideMeshData {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/** Flat strip for the extracted constant-width, uncapped, tiled LineRenderer.
 * Sharp reversals use bevel joins to bound the Web mesh; Unity pixels remain uncalibrated.
 */
export function slideMesh(points: readonly { x: number; y: number }[], width: number,
  tileScale: readonly number[], tileOffset: readonly number[]): SlideMeshData {
  const path = points.filter((point, index) => index === 0
    || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-9);
  if (path.length < 2) return { positions: new Float32Array(), uvs: new Float32Array(), indices: new Uint32Array() };
  const lengths: number[] = [];
  const normals = path.slice(1).map((point, index) => {
    const dx = point.x - path[index].x;
    const dy = point.y - path[index].y;
    const length = Math.hypot(dx, dy);
    lengths.push(length);
    return { x: -dy / length, y: dx / length };
  });
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const halfWidth = width / 2;
  // Four half-widths is a Web tessellation limit, not an extracted Unity setting.
  const miterLimit = 4;
  let distance = 0;
  let previousExit = -1;
  const pair = (point: { x: number; y: number }, nx: number, ny: number, u: number): number => {
    const vertex = positions.length / 2;
    const dx = nx * halfWidth, dy = ny * halfWidth;
    positions.push(point.x - dx, point.y - dy, point.x + dx, point.y + dy);
    uvs.push(u, tileOffset[1], u, tileScale[1] + tileOffset[1]);
    return vertex;
  };
  path.forEach((point, index) => {
    if (index > 0) distance += lengths[index - 1];
    const u = distance * tileScale[0] + tileOffset[0];
    const before = normals[Math.max(0, index - 1)];
    const after = normals[Math.min(normals.length - 1, index)];
    const divisor = 1 + before.x * after.x + before.y * after.y;
    let entry: number, exit: number;
    if (divisor < 2 / (miterLimit * miterLimit)) {
      entry = pair(point, before.x, before.y, u);
      exit = pair(point, after.x, after.y, u);
      // Segment quads overlap on the inside; this triangle fills only the outer corner.
      const center = positions.length / 2;
      positions.push(point.x, point.y);
      uvs.push(u, tileScale[1] / 2 + tileOffset[1]);
      const outer = before.x * after.y - before.y * after.x > 0 ? 0 : 1;
      if (outer === 0) indices.push(exit, entry, center);
      else indices.push(entry + 1, exit + 1, center);
    } else {
      entry = exit = pair(point, (before.x + after.x) / divisor, (before.y + after.y) / divisor, u);
    }
    if (previousExit >= 0) {
      indices.push(previousExit, previousExit + 1, entry, previousExit + 1, entry + 1, entry);
    }
    previousExit = exit;
  });
  return { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}
