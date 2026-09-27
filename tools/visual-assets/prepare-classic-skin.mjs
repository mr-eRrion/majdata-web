import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DIR = path.join(ROOT, "Visual Maimai/Skins/经典");
const OUTPUT_DIR = path.join(ROOT, "apps/web/public/assets/visual-maimai");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");
const SOURCE_ROOT = "Visual Maimai/Skins/经典";
const OUTPUT_ROOT = "apps/web/public/assets/visual-maimai";
const EXPECTED_ASSET_COUNT = 61;

// Keys describe the asset names only. Numbered suffixes, combinations, and
// sprite anchors remain unclassified until the target behavior is recovered.
const ASSETS = [
  ["hold.base", "hold.png"],
  ["hold.break", "hold_break.png"],
  ["hold.each", "hold_each.png"],
  ["hold.ex", "hold_ex.png"],
  ["slide.base", "slide.png"],
  ["slide.break", "slide_break.png"],
  ["slide.each", "slide_each.png"],
  ["star.base", "star.png"],
  ["star.break", "star_break.png"],
  ["star.each", "star_each.png"],
  ["star.ex", "star_ex.png"],
  ["star.double.base", "star_double.png"],
  ["star.double.break", "star_double_break.png"],
  ["star.double.each", "star_double_each.png"],
  ["star.double.ex", "star_double_ex.png"],
  ["tap.base", "tap.png"],
  ["tap.break", "tap_break.png"],
  ["tap.each", "tap_each.png"],
  ["tap.ex", "tap_ex.png"],
  ["touch.base", "touch.png"],
  ["touch.each", "touch_each.png"],
  ["touch.point.base", "touch_point.png"],
  ["touch.point.each", "touch_point_each.png"],
  ["touchhold.0", "touchhold_0.png"],
  ["touchhold.1", "touchhold_1.png"],
  ["touchhold.2", "touchhold_2.png"],
  ["touchhold.3", "touchhold_3.png"],
  ["touchhold.border", "touchhold_border.png"],
  ["wifi.base.0", "wifi_0.png"],
  ["wifi.base.1", "wifi_1.png"],
  ["wifi.base.2", "wifi_2.png"],
  ["wifi.base.3", "wifi_3.png"],
  ["wifi.base.4", "wifi_4.png"],
  ["wifi.base.5", "wifi_5.png"],
  ["wifi.base.6", "wifi_6.png"],
  ["wifi.base.7", "wifi_7.png"],
  ["wifi.base.8", "wifi_8.png"],
  ["wifi.base.9", "wifi_9.png"],
  ["wifi.base.10", "wifi_10.png"],
  ["wifi.break.0", "wifi_break_0.png"],
  ["wifi.break.1", "wifi_break_1.png"],
  ["wifi.break.2", "wifi_break_2.png"],
  ["wifi.break.3", "wifi_break_3.png"],
  ["wifi.break.4", "wifi_break_4.png"],
  ["wifi.break.5", "wifi_break_5.png"],
  ["wifi.break.6", "wifi_break_6.png"],
  ["wifi.break.7", "wifi_break_7.png"],
  ["wifi.break.8", "wifi_break_8.png"],
  ["wifi.break.9", "wifi_break_9.png"],
  ["wifi.break.10", "wifi_break_10.png"],
  ["wifi.each.0", "wifi_each_0.png"],
  ["wifi.each.1", "wifi_each_1.png"],
  ["wifi.each.2", "wifi_each_2.png"],
  ["wifi.each.3", "wifi_each_3.png"],
  ["wifi.each.4", "wifi_each_4.png"],
  ["wifi.each.5", "wifi_each_5.png"],
  ["wifi.each.6", "wifi_each_6.png"],
  ["wifi.each.7", "wifi_each_7.png"],
  ["wifi.each.8", "wifi_each_8.png"],
  ["wifi.each.9", "wifi_each_9.png"],
  ["wifi.each.10", "wifi_each_10.png"],
];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inspectPngHeader(bytes, label) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label}: invalid PNG signature or truncated header`);
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label}: missing PNG IHDR header`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error(`${label}: PNG dimensions must be positive`);
  return { width, height };
}

function namesFrom(entries) {
  return entries.filter((name) => name.toLowerCase().endsWith(".png")).sort();
}

function assertNames(actual, expected, label) {
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing: ${missing.join(", ")}` : "",
      extra.length ? `unexpected: ${extra.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`${label} does not match the explicit asset list (${details})`);
  }
}

function expectedNames() {
  const names = ASSETS.map(([, filename]) => filename);
  if (names.length !== EXPECTED_ASSET_COUNT) throw new Error(`Expected ${EXPECTED_ASSET_COUNT} explicit assets; found ${names.length}`);
  if (new Set(names).size !== names.length) throw new Error("Asset list contains duplicate filenames");
  const keys = ASSETS.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new Error("Asset list contains duplicate semantic keys");
  return names.sort();
}

async function buildManifest() {
  const expected = expectedNames();
  const sourceNames = namesFrom(await readdir(SOURCE_DIR));
  assertNames(sourceNames, expected, SOURCE_ROOT);

  const assets = [];
  for (const [key, filename] of ASSETS) {
    const sourcePath = path.join(SOURCE_DIR, filename);
    const bytes = await readFile(sourcePath);
    const { width, height } = inspectPngHeader(bytes, `${SOURCE_ROOT}/${filename}`);
    assets.push({
      key,
      sourcePath: `${SOURCE_ROOT}/${filename}`,
      sha256: sha256(bytes),
      outputPath: `${OUTPUT_ROOT}/${filename}`,
      width,
      height,
    });
  }

  return {
    schemaVersion: 1,
    sourceRoot: `${SOURCE_ROOT}/`,
    assets,
  };
}

function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function verifyOutput(manifest) {
  const expected = expectedNames();
  const outputNames = namesFrom(await readdir(OUTPUT_DIR));
  assertNames(outputNames, expected, OUTPUT_ROOT);

  let totalBytes = 0;
  for (const asset of manifest.assets) {
    const filename = path.basename(asset.outputPath);
    const bytes = await readFile(path.join(OUTPUT_DIR, filename));
    totalBytes += bytes.length;
    const dimensions = inspectPngHeader(bytes, asset.outputPath);
    if (sha256(bytes) !== asset.sha256) throw new Error(`${asset.outputPath}: bytes differ from source SHA-256`);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
      throw new Error(`${asset.outputPath}: dimensions differ from manifest`);
    }
  }

  const currentManifest = await readFile(MANIFEST_PATH, "utf8");
  if (currentManifest !== manifestText(manifest)) throw new Error(`${OUTPUT_ROOT}/manifest.json is stale or not deterministic`);
  return totalBytes;
}

async function readPackagedManifest() {
  const text = await readFile(MANIFEST_PATH, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${OUTPUT_ROOT}/manifest.json is invalid JSON (${error.message})`);
  }

  if (manifest?.schemaVersion !== 1 || manifest.sourceRoot !== `${SOURCE_ROOT}/` || !Array.isArray(manifest.assets)) {
    throw new Error(`${OUTPUT_ROOT}/manifest.json has an unsupported schema`);
  }
  if (Object.keys(manifest).join(",") !== "schemaVersion,sourceRoot,assets") {
    throw new Error(`${OUTPUT_ROOT}/manifest.json has unexpected fields`);
  }
  if (manifest.assets.length !== EXPECTED_ASSET_COUNT) {
    throw new Error(`Expected ${EXPECTED_ASSET_COUNT} manifest assets; found ${manifest.assets.length}`);
  }

  const keys = new Set();
  const filenames = new Set();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== "object") throw new Error("Manifest has an invalid asset entry");
    if (Object.keys(asset).join(",") !== "key,sourcePath,sha256,outputPath,width,height") {
      throw new Error("Manifest asset has unexpected fields");
    }
    if (typeof asset.key !== "string" || !asset.key || keys.has(asset.key)) throw new Error("Manifest has an empty or duplicate semantic key");
    if (typeof asset.outputPath !== "string") throw new Error(`Manifest has invalid output path for ${asset.key}`);
    const filename = path.basename(asset.outputPath);
    if (asset.sourcePath !== `${SOURCE_ROOT}/${filename}`) throw new Error(`Manifest has invalid source path for ${asset.key}`);
    if (asset.outputPath !== `${OUTPUT_ROOT}/${filename}` || filename === "." || filenames.has(filename)) {
      throw new Error(`Manifest has an invalid or duplicate output path for ${asset.key}`);
    }
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Manifest has invalid SHA-256 for ${asset.key}`);
    if (!Number.isInteger(asset.width) || asset.width < 1 || !Number.isInteger(asset.height) || asset.height < 1) {
      throw new Error(`Manifest has invalid PNG dimensions for ${asset.key}`);
    }
    keys.add(asset.key);
    filenames.add(filename);
  }

  const canonicalText = manifestText(manifest);
  if (text !== canonicalText) throw new Error(`${OUTPUT_ROOT}/manifest.json is not in deterministic format`);
  return manifest;
}

async function verifyPackagedAssets(manifest) {
  const expected = manifest.assets.map((asset) => path.basename(asset.outputPath)).sort();
  const outputNames = namesFrom(await readdir(OUTPUT_DIR));
  assertNames(outputNames, expected, OUTPUT_ROOT);

  let totalBytes = 0;
  for (const asset of manifest.assets) {
    const bytes = await readFile(path.join(OUTPUT_DIR, path.basename(asset.outputPath)));
    totalBytes += bytes.length;
    const dimensions = inspectPngHeader(bytes, asset.outputPath);
    if (sha256(bytes) !== asset.sha256) throw new Error(`${asset.outputPath}: bytes differ from manifest SHA-256`);
    if (dimensions.width !== asset.width || dimensions.height !== asset.height) {
      throw new Error(`${asset.outputPath}: dimensions differ from manifest`);
    }
  }
  return totalBytes;
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["--check", "--check-packaged"].includes(args[0]))) {
  throw new Error("Usage: node tools/visual-assets/prepare-classic-skin.mjs [--check | --check-packaged]");
}

if (args[0] === "--check-packaged") {
  const manifest = await readPackagedManifest();
  const totalBytes = await verifyPackagedAssets(manifest);
  console.log(`Verified packaged ${manifest.assets.length} PNG assets (${totalBytes} bytes).`);
} else if (args[0] === "--check") {
  const manifest = await buildManifest();
  const totalBytes = await verifyOutput(manifest);
  console.log(`Verified ${manifest.assets.length} PNG assets (${totalBytes} bytes).`);
} else {
  const manifest = await buildManifest();
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const [, filename] of ASSETS) {
    await copyFile(path.join(SOURCE_DIR, filename), path.join(OUTPUT_DIR, filename));
  }
  await writeFile(MANIFEST_PATH, manifestText(manifest));
  const totalBytes = await verifyOutput(manifest);
  console.log(`Prepared ${manifest.assets.length} PNG assets (${totalBytes} bytes).`);
}
