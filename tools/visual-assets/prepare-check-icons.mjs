import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_ROOT = "fixtures/visual-maimai/check-icons";
const PUBLIC_ROOT = "apps/web/public/assets/visual-maimai/checks";
const MANIFEST_PATH = `${PUBLIC_ROOT}/manifest.json`;
const EXPECTED = [
  { key: "check.warning", file: "warning.png", spriteId: 375, textureId: 170 },
  { key: "check.bad", file: "bad.png", spriteId: 303, textureId: 76 },
];
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check-packaged")) {
  throw new Error("Usage: node tools/visual-assets/prepare-check-icons.mjs [--check-packaged]");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function pngDimensions(bytes, label) {
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label}: invalid PNG header`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error(`${label}: invalid PNG dimensions`);
  return { width, height };
}

function validateRecord(asset, index) {
  const expected = EXPECTED[index];
  if (!expected || asset.key !== expected.key || asset.file !== expected.file) {
    throw new Error(`Unexpected check icon at index ${index}: ${asset.key}/${asset.file}`);
  }
  if (asset.sprite.objectId !== expected.spriteId || asset.sprite.name !== (index === 0 ? "Warning" : "Bad")) {
    throw new Error(`${asset.key}: Sprite identity does not match the expected source object`);
  }
  if (asset.sourceSpriteId !== undefined && asset.sourceSpriteId !== expected.spriteId) {
    throw new Error(`${asset.key}: manifest source Sprite ID is inconsistent`);
  }
  if (asset.sourceTextureId !== undefined && asset.sourceTextureId !== expected.textureId) {
    throw new Error(`${asset.key}: manifest source Texture2D ID is inconsistent`);
  }
  if (asset.sprite.texture?.fileId !== 0 || asset.sprite.texture.pathId !== expected.textureId || asset.texture.objectId !== expected.textureId) {
    throw new Error(`${asset.key}: Sprite→Texture reference does not match the expected source object`);
  }
  const rect = asset.sprite.rect;
  const textureRect = asset.sprite.textureRect;
  const png = asset.png ?? asset;
  if ([rect?.x, rect?.y, rect?.width, rect?.height].join(",") !== "0,0,84,84" ||
      [textureRect?.x, textureRect?.y, textureRect?.width, textureRect?.height].join(",") !== "0,0,84,84" ||
      asset.sprite.pivot?.join(",") !== "0.5,0.5" || asset.sprite.pixelsPerUnit !== 100 ||
      asset.sprite.textureRectOffset?.join(",") !== "0,0" ||
      asset.texture.name !== asset.sprite.name || asset.texture.width !== 84 || asset.texture.height !== 84 ||
      png.width !== 84 || png.height !== 84 || !/^[a-f0-9]{64}$/.test(png.sha256)) {
    throw new Error(`${asset.key}: invalid Sprite, Texture2D or PNG metadata`);
  }
}

function validateDisplayReference(displayReference) {
  if (displayReference?.rootGameObject?.objectId !== 637 || displayReference.rootGameObject.name !== "Check Result" ||
      displayReference.rootRectTransform?.objectId !== 1140 || displayReference.rootRectTransform.size?.join(",") !== "42,42" ||
      displayReference.checkResultKeyframe?.objectId !== 1421 ||
      displayReference.checkResultKeyframe.fieldReferences?.map(({ field, pathId }) => `${field}:${pathId}`).join(",") !==
        "image:1323,warningSprite:375,badSprite:303,text:1353,bar:652") {
    throw new Error("Check Result prefab display/source reference metadata is incomplete or unexpected");
  }
}

async function checkPackaged() {
  const manifestBytes = await readFile(path.join(ROOT, MANIFEST_PATH));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.assets?.length !== EXPECTED.length) {
    throw new Error(`${MANIFEST_PATH}: unsupported or incomplete manifest`);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceAssets?.sha256 ?? "")) {
    throw new Error(`${MANIFEST_PATH}: missing source asset hash`);
  }
  validateDisplayReference(manifest.displayReference);
  let totalBytes = 0;
  for (const [index, asset] of manifest.assets.entries()) {
    validateRecord(asset, index);
    const outputPath = `${PUBLIC_ROOT}/${EXPECTED[index].file}`;
    if (asset.outputPath !== outputPath || asset.sourcePath !== "Visual Maimai/Visual Maimai_Data/sharedassets0.assets") {
      throw new Error(`${asset.key}: invalid source/output path`);
    }
    const bytes = await readFile(path.join(ROOT, outputPath));
    const dims = pngDimensions(bytes, outputPath);
    if (sha256(bytes) !== asset.sha256 || dims.width !== asset.width || dims.height !== asset.height) {
      throw new Error(`${outputPath}: hash or dimensions differ from packaged manifest`);
    }
    totalBytes += bytes.length;
  }
  console.log(`Verified ${manifest.assets.length} packaged check icons (${totalBytes} PNG bytes).`);
}

async function prepare() {
  const sourcePath = `${FIXTURE_ROOT}/source.json`;
  const source = JSON.parse(await readFile(path.join(ROOT, sourcePath), "utf8"));
  if (source.schemaVersion !== 1 || source.assets?.length !== EXPECTED.length) {
    throw new Error(`${sourcePath}: unsupported or incomplete source fixture`);
  }
  validateDisplayReference(source.displayReference);
  const sourceSha256 = source.extraction.sourceAssets.sha256;
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error(`${sourcePath}: missing source asset hash`);

  const assets = [];
  const pngFiles = [];
  for (const [index, record] of source.assets.entries()) {
    validateRecord(record, index);
    const fixturePath = `${FIXTURE_ROOT}/${record.file}`;
    const bytes = await readFile(path.join(ROOT, fixturePath));
    const dims = pngDimensions(bytes, fixturePath);
    if (sha256(bytes) !== record.png.sha256 || dims.width !== record.png.width || dims.height !== record.png.height) {
      throw new Error(`${fixturePath}: fixture hash or dimensions do not match source.json`);
    }
    const outputPath = `${PUBLIC_ROOT}/${record.file}`;
    pngFiles.push({ outputPath, bytes });
    assets.push({
      key: record.key,
      sourcePath: source.extraction.sourceAssets.path,
      sourceSpriteId: record.sprite.objectId,
      sourceTextureId: record.texture.objectId,
      sprite: record.sprite,
      texture: record.texture,
      file: record.file,
      fixturePath,
      sha256: record.png.sha256,
      width: record.png.width,
      height: record.png.height,
      outputPath,
    });
  }
  const manifest = {
    schemaVersion: 1,
    sourceAssets: source.extraction.sourceAssets,
    sourceStream: source.extraction.sourceStream,
    displayReference: source.displayReference,
    extractionMethod: source.extraction.method,
    assets,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(path.join(ROOT, PUBLIC_ROOT), { recursive: true });
  for (const { outputPath, bytes } of pngFiles) await writeFile(path.join(ROOT, outputPath), bytes);
  await writeFile(path.join(ROOT, MANIFEST_PATH), manifestText);
  console.log(`Prepared ${assets.length} check icons (${pngFiles.reduce((sum, item) => sum + item.bytes.length, 0)} PNG bytes).`);
}

if (args[0] === "--check-packaged") await checkPackaged();
else await prepare();
