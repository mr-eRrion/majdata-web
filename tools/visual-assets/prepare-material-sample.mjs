import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_PATH = "fixtures/visual-maimai/rendering.json";
const PUBLIC_ROOT = "apps/web/public/assets/visual-maimai";
const ASSET_MANIFEST_PATH = `${PUBLIC_ROOT}/manifest.json`;
const OUTPUT_PATH = "apps/web/public/skin-reference-data.json";
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: node tools/visual-assets/prepare-material-sample.mjs [--check]");
}
const check = args[0] === "--check";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngDimensions(bytes, label) {
  if (bytes.length < 24 || bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${label}: invalid PNG header`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error(`${label}: invalid PNG dimensions`);
  return { width, height };
}

function spriteFile(sprite) {
  if (!sprite?.name || !sprite.texture) throw new Error("Expected a named Sprite with a source texture in rendering.json");
  return `${sprite.name}.png`;
}

const fixtureBytes = await readFile(path.join(ROOT, FIXTURE_PATH));
const fixture = JSON.parse(fixtureBytes);
const assetManifest = JSON.parse(await readFile(path.join(ROOT, ASSET_MANIFEST_PATH), "utf8"));
if (assetManifest.schemaVersion !== 1 || !Array.isArray(assetManifest.assets)) {
  throw new Error(`${ASSET_MANIFEST_PATH}: unsupported asset manifest`);
}
const packagedAssets = new Map();
for (const asset of assetManifest.assets) {
  const filename = path.basename(asset.outputPath ?? "");
  if (!filename || asset.outputPath !== `${PUBLIC_ROOT}/${filename}` || packagedAssets.has(filename)) {
    throw new Error(`${ASSET_MANIFEST_PATH}: invalid or duplicate outputPath ${asset.outputPath}`);
  }
  packagedAssets.set(filename, asset);
}
const sourceSprite = (prefabName, role) => {
  const result = fixture.skin.prefabs[prefabName]?.sprites?.find((entry) => entry.role === role)?.sprite;
  if (!result) throw new Error(`Missing ${prefabName}.${role} in extracted scene fixture`);
  return result;
};

const imageRecords = new Map();
async function image(sprite) {
  const filename = spriteFile(sprite);
  if (!imageRecords.has(filename)) {
    const outputPath = `${PUBLIC_ROOT}/${filename}`;
    const packaged = packagedAssets.get(filename);
    if (!packaged) throw new Error(`${filename} is not declared in ${ASSET_MANIFEST_PATH}`);
    const publicBytes = await readFile(path.join(ROOT, outputPath));
    const publicDimensions = pngDimensions(publicBytes, outputPath);
    if (sha256(publicBytes) !== packaged.sha256) {
      throw new Error(`${outputPath} does not match the packaged asset manifest; prepare the classic skin assets first`);
    }
    if (publicDimensions.width !== packaged.width || publicDimensions.height !== packaged.height) {
      throw new Error(`${outputPath} dimensions do not match the packaged asset manifest`);
    }
    if (sprite.texture.width !== publicDimensions.width || sprite.texture.height !== publicDimensions.height) {
      throw new Error(`${filename}: PNG dimensions do not match serialized Texture2D ${sprite.texture.object_id}`);
    }
    imageRecords.set(filename, {
      file: filename,
      src: `./assets/visual-maimai/${filename}`,
      sourcePath: packaged.sourcePath,
      outputPath,
      sha256: packaged.sha256,
      width: publicDimensions.width,
      height: publicDimensions.height,
    });
  }
  return imageRecords.get(filename);
}

const starRoles = [
  ["normal", "singleSprite"],
  ["each", "multiSprite"],
  ["break", "breakSprite"],
  ["ex", "exModel"],
];
const stars = [];
for (const [variant, role] of starRoles) {
  const sprite = sourceSprite("slide", role);
  stars.push({ variant, spriteId: sprite.object_id, rect: sprite.rect, pivot: sprite.pivot, ppu: sprite.pixels_per_unit, image: await image(sprite) });
}

const slideTextures = [];
for (const [variant, materialKey] of [["normal", "single"], ["each", "multi"], ["break", "break"]]) {
  const material = fixture.skin.slide_line.materials[materialKey];
  const texture = material.textures.find((entry) => entry.name === "_MainTex")?.texture;
  if (!texture) throw new Error(`SlideLine ${materialKey} material has no serialized _MainTex`);
  const spriteLike = {
    name: texture.name,
    texture,
  };
  slideTextures.push({
    variant,
    materialId: material.object_id,
    materialName: material.name,
    textureId: texture.object_id,
    textureWidth: texture.width,
    textureHeight: texture.height,
    textureScale: material.textures.find((entry) => entry.name === "_MainTex").scale,
    textureOffset: material.textures.find((entry) => entry.name === "_MainTex").offset,
    image: await image(spriteLike),
  });
}

const wifi = fixture.skin.slide_wifi;
if (wifi.arrows.length !== 11) throw new Error(`Expected 11 serialized WiFi SpriteRenderers, got ${wifi.arrows.length}`);
const baseChain = wifi.arrows[0].transform_chain_root_first;
const wifiGroup = baseChain.at(-2);
const wifiPrefabs = {
  rootId: wifi.root.root.game_object_id,
  groupTransformId: wifiGroup.transform_id,
  groupRotation: wifiGroup.local_rotation_xyzw,
  groupScale: wifiGroup.local_scale,
  ppu: wifi.arrows[0].sprite.pixels_per_unit,
  renderers: wifi.arrows.map((renderer, index) => {
    const transform = renderer.transform_chain_root_first.at(-1);
    if (renderer.role !== `arrows.${index}` || renderer.sprite.name !== `wifi_${index}`) {
      throw new Error(`WiFi renderer ${index} does not match the serialized arrows array`);
    }
    return {
      index,
      rendererId: renderer.object_id,
      gameObjectId: renderer.game_object.object_id,
      localPosition: transform.local_position,
      localRotation: transform.local_rotation_xyzw,
      localScale: transform.local_scale,
      size: renderer.size,
      drawMode: renderer.draw_mode,
      sortingOrder: renderer.sorting_order,
    };
  }),
};

const wifiVariants = {};
for (const [variant, arrayKey] of [["normal", "arrowsSingle"], ["each", "arrowsMulti"], ["break", "arrowsBreak"]]) {
  const sprites = wifi.sprites[arrayKey];
  if (sprites.length !== wifiPrefabs.renderers.length) throw new Error(`${arrayKey} length does not match prefab renderer count`);
  wifiVariants[variant] = [];
  for (const [index, sprite] of sprites.entries()) {
    if (sprite.name !== `${variant === "normal" ? "wifi" : `wifi_${variant}`}_${index}`) {
      throw new Error(`${arrayKey}[${index}] unexpected Sprite ${sprite.name}`);
    }
    wifiVariants[variant].push({
      index,
      spriteId: sprite.object_id,
      rect: sprite.rect,
      pivot: sprite.pivot,
      ppu: sprite.pixels_per_unit,
      image: await image(sprite),
    });
  }
}

const output = {
  schemaVersion: 1,
  fixturePath: FIXTURE_PATH,
  fixtureSha256: sha256(fixtureBytes),
  calibration: "Static serialized prefab references and positions only; material tiling and animation are not calibrated.",
  stars,
  slideTextures,
  wifi: {
    prefab: wifiPrefabs,
    variants: wifiVariants,
    composition: "Each image uses its SpriteRenderer array index, prefab local position/rotation/scale, renderer size and Sprite pivot; Wifi Base transform is included.",
  },
  images: [...imageRecords.values()],
};
const outputText = `${JSON.stringify(output, null, 2)}\n`;
const outFile = path.join(ROOT, OUTPUT_PATH);
if (check) {
  if (await readFile(outFile, "utf8") !== outputText) throw new Error(`${OUTPUT_PATH} is stale or not deterministic`);
  console.log(`Verified ${output.images.length} source PNGs and the static material sample manifest.`);
} else {
  await writeFile(outFile, outputText);
  console.log(`Prepared ${output.stars.length} Star variants, ${output.slideTextures.length} Slide textures and ${wifiPrefabs.renderers.length} WiFi prefab positions.`);
}
