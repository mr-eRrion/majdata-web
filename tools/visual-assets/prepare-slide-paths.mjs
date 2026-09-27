import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
const sourceBytes = await readFile(path.join(root, 'fixtures/visual-maimai/rendering.json'));
const source = JSON.parse(sourceBytes);
const slideTypes = source.slide_types;
const commands = {};
const paths = {};
let enterAreaEventCount = 0;
const expectedPaths = {
  '-': { 2: 1200, 3: 1201, 4: 1202, 5: 1203, 6: 1204 },
  '<': { 0: 1253, 1: 1254, 2: 1255, 3: 1256, 4: 1257, 5: 1258, 6: 1259, 7: 1260 },
  '>': { 0: 1261, 1: 1262, 2: 1263, 3: 1264, 4: 1265, 5: 1266, 6: 1267, 7: 1268 },
  v: { 1: 1246, 2: 1247, 3: 1248, 5: 1249, 6: 1250, 7: 1251 },
  s: { 4: 1245 },
  z: { 4: 1252 },
};

function warningLength(points, pathId) {
  if (!Array.isArray(points) || points.length < 2
    || points.some((point) => !Array.isArray(point) || point.length !== 3 || point.some((value) => !Number.isFinite(value)))) {
    throw new Error(`Invalid 3D slide path points: ${pathId}`);
  }
  let sum = Math.fround(0);
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const dx = Math.fround(to[0] - from[0]);
    const dy = Math.fround(to[1] - from[1]);
    const dz = Math.fround(to[2] - from[2]);
    const xx = Math.fround(dx * dx);
    const yy = Math.fround(dy * dy);
    const zz = Math.fround(dz * dz);
    const xy = Math.fround(xx + yy);
    const squared = Math.fround(xy + zz);
    const distance = Math.fround(Math.sqrt(squared));
    sum = Math.fround(sum + distance);
  }
  return sum;
}

for (const command of Object.keys(expectedPaths)) {
  const type = slideTypes.commands.find((entry) => entry.command === command);
  if (!type) throw new Error(`Missing serialized slide command: ${command}`);
  const entries = {};
  for (const info of type.infos) {
    if (info.distance < 0 || info.distance > 7 || info.center_distance !== 0) continue;
    const distance = String(info.distance);
    if (entries[distance]) throw new Error(`Duplicate ${command} slide distance: ${distance}`);
    const pathId = String(info.path.path_id);
    const slidePath = slideTypes.paths[pathId];
    if (!slidePath || slidePath.points.length < 2) throw new Error(`Missing path points: ${pathId}`);
    if (!Array.isArray(slidePath.enter_area_data)) throw new Error(`Missing enter area data: ${pathId}`);
    const enterAreaData = slidePath.enter_area_data.map((event) => {
      if (!Number.isInteger(event.area) || event.area < 1 || event.area > 8
        || !Number.isFinite(event.time_rate) || event.time_rate < 0 || event.time_rate > 1) {
        throw new Error(`Invalid enter area event: ${pathId}`);
      }
      enterAreaEventCount += 1;
      return { area: event.area, timeRate: event.time_rate };
    });
    const points = slidePath.points.map((point) => {
      if (point[2] !== 0) throw new Error(`Non-planar slide path: ${pathId}`);
      return [point[0], point[1]];
    });
    const length = points.slice(1).reduce((sum, point, index) =>
      sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0);
    if (Math.abs(length - slidePath.length) > 1e-4) throw new Error(`Slide length mismatch: ${pathId}`);
    paths[pathId] ??= {
      name: slidePath.name,
      points,
      splitIndexes: slidePath.split_indexes,
      length,
      enterAreaData,
      warningLength: warningLength(slidePath.points, pathId),
    };
    entries[distance] = Number(pathId);
  }
  if (JSON.stringify(entries) !== JSON.stringify(expectedPaths[command])) {
    throw new Error(`Unexpected serialized ${command} path coverage: ${JSON.stringify(entries)}`);
  }
  commands[command] = entries;
}

if (Object.keys(paths).length !== 29 || enterAreaEventCount !== 87) {
  throw new Error(`Unexpected supported path/event coverage: ${Object.keys(paths).length} paths, ${enterAreaEventCount} enter-area events`);
}

const trackPoint = (index) => {
  const transform = source.runtime.tracks[index]?.parent_chain_root_first.at(-1);
  if (!transform || !Array.isArray(transform.local_position)) throw new Error(`Missing Wi-Fi track ${index + 1}`);
  return transform.local_position.slice(0, 2);
};
const output = {
  sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
  assemblySha256: source.metadata.assembly_sha256,
  commands,
  paths,
  wifiStars: {
    start: trackPoint(0),
    ends: [trackPoint(3), trackPoint(4), trackPoint(5)],
  },
};
const target = 'apps/web/src/skin/slide-paths.json';
const text = `${JSON.stringify(output, null, 2)}\n`;
const coreOutput = {
  sourceSha256: output.sourceSha256,
  assemblySha256: output.assemblySha256,
  lengths: Object.fromEntries(Object.entries(commands).map(([command, distances]) => [command,
    Object.fromEntries(Object.entries(distances).map(([distance, pathId]) => [distance, paths[String(pathId)].length])),
  ])),
};
const coreTarget = 'packages/chart-core/src/slide-path-lengths.json';
const coreText = `${JSON.stringify(coreOutput, null, 2)}\n`;
if (check) {
  if (await readFile(path.join(root, target), 'utf8') !== text) throw new Error(`Stale slide path data: ${target}`);
  if (await readFile(path.join(root, coreTarget), 'utf8') !== coreText) throw new Error(`Stale slide length data: ${coreTarget}`);
} else {
  await writeFile(path.join(root, target), text);
  await writeFile(path.join(root, coreTarget), coreText);
}
console.log(`${check ? 'Verified' : 'Prepared'} ${Object.keys(paths).length} slide paths, ${enterAreaEventCount} enter-area events, float32 warning lengths, Core segment lengths, and Wi-Fi star endpoints.`);
