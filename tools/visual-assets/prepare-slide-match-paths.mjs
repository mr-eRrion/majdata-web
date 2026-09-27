import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
const fixturePath = 'fixtures/visual-maimai/rendering.json';
const targetPath = 'apps/web/src/skin/slide-match-paths.json';
const fixtureBytes = await readFile(path.join(root, fixturePath));
const fixture = JSON.parse(fixtureBytes);
const slideTypes = fixture.slide_types;
if (!Array.isArray(slideTypes?.commands) || !slideTypes.paths || typeof slideTypes.paths !== 'object')
  throw new Error('Rendering fixture does not contain serialized SlideTypesData.');

const sourceInfos = [];
const pathIds = new Set();
for (let typeIndex = 0; typeIndex < slideTypes.commands.length; typeIndex += 1) {
  const type = slideTypes.commands[typeIndex];
  if (typeof type.command !== 'string' || !Array.isArray(type.infos))
    throw new Error(`Malformed serialized slide command at type index ${typeIndex}.`);
  for (let infoIndex = 0; infoIndex < type.infos.length; infoIndex += 1) {
    const info = type.infos[infoIndex];
    const pathId = info.path?.path_id;
    if (!Number.isSafeInteger(info.distance) || !Number.isSafeInteger(info.center_distance)
      || !Number.isSafeInteger(pathId) || info.path.file_id !== 0)
      throw new Error(`Malformed SlideInfoData at ${typeIndex}:${infoIndex}.`);
    if (!slideTypes.paths[String(pathId)]) throw new Error(`Missing serialized SlidePathData ${pathId}.`);
    sourceInfos.push({
      sourceOrder: sourceInfos.length,
      typeIndex,
      infoIndex,
      sourceCommand: type.command,
      distance: info.distance,
      centerDistance: info.center_distance,
      pathId,
    });
    pathIds.add(pathId);
  }
}

const paths = [...pathIds].map((pathId) => {
  const pathData = slideTypes.paths[String(pathId)];
  if (pathData.object_id !== pathId || !Array.isArray(pathData.points) || pathData.points.length < 2
    || !Array.isArray(pathData.split_indexes) || !Array.isArray(pathData.enter_area_data))
    throw new Error(`Malformed SlidePathData ${pathId}.`);
  const points = pathData.points.map((point) => {
    if (!Array.isArray(point) || point.length !== 3 || point.some((coordinate) => !Number.isFinite(coordinate)))
      throw new Error(`SlidePathData ${pathId} contains a malformed point.`);
    return [...point];
  });
  const calculatedLength = points.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1], point[2] - points[index][2]), 0);
  if (!Number.isFinite(pathData.length) || Math.abs(calculatedLength - pathData.length) > 1e-4)
    throw new Error(`SlidePathData ${pathId} length does not match its serialized points.`);
  return {
    id: pathId,
    name: pathData.name,
    points,
    length: pathData.length,
  };
});

const selectionSets = [];
for (let startPosition = 1; startPosition <= 8; startPosition += 1) {
  for (let endPosition = 1; endPosition <= 8; endPosition += 1) {
    const distance = (endPosition - startPosition + 8) % 8;
    const candidateSourceOrders = sourceInfos
      .filter((info) => info.distance === distance)
      .map((info) => info.sourceOrder);
    if (candidateSourceOrders.length === 0)
      throw new Error(`No GetSelections candidate for ${startPosition}→${endPosition}.`);
    selectionSets.push({ startPosition, endPosition, distance, candidateSourceOrders });
  }
}

for (let index = 0; index < sourceInfos.length; index += 1) {
  if (sourceInfos[index].sourceOrder !== index)
    throw new Error(`sourceOrder ${sourceInfos[index].sourceOrder} does not match infos index ${index}.`);
}

const output = {
  schemaVersion: 1,
  provenance: {
    fixturePath,
    fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
    assemblySha256: fixture.metadata.assembly_sha256,
    slideTypesObjectId: slideTypes.object_id,
    slideTypesName: slideTypes.name,
    serializedInfoCount: sourceInfos.length,
    uniquePathCount: paths.length,
  },
  ordering: {
    source: 'Gameplay.Data.SlideTypesData.GetPaths → EditorScene.Slide.SlideTypeList.GetSelections',
    candidateOrder: 'serialized commands[] order, then each infos[] order; preserve duplicates; no additional sort',
    distance: 'CalcDistance(endPosition - startPosition), where negative values add 8; select info.distance equal to that value',
    commandRotation: 'For startPosition 3–6, swap only < and >; keep all other commands unchanged',
    centerDistance: 'Copied unchanged from SlideInfoData.centerDistance',
    points: 'SlidePathData.points kept in serialized order and are not rotated per start position',
  },
  infos: sourceInfos.map(({ sourceOrder, typeIndex, infoIndex, sourceCommand, distance, centerDistance, pathId }) => ({
    sourceOrder,
    typeIndex,
    infoIndex,
    command: sourceCommand,
    distance,
    centerDistance,
    pathId,
  })),
  paths,
  selectionSets,
};

const target = path.join(root, targetPath);
const text = `${JSON.stringify(output, null, 2)}\n`;
if (check) {
  let actual;
  try { actual = await readFile(target, 'utf8'); }
  catch { throw new Error(`Missing generated Slide match paths: ${targetPath}`); }
  if (actual !== text) throw new Error(`Stale Slide match paths: ${targetPath}`);
} else {
  await writeFile(target, text);
}

console.log(`${check ? 'Verified' : 'Prepared'} ${paths.length} unique paths and ${selectionSets.length} ordered endpoint candidate sets (${sourceInfos.length} serialized path references).`);
