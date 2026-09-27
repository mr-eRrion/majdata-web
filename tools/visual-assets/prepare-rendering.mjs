import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
async function output(filename, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (check) {
    if (await readFile(path.join(root, filename), 'utf8') !== text) throw new Error(`Stale prepared resource: ${filename}`);
  } else await writeFile(path.join(root, filename), text);
}
const input = await readFile(path.join(root, 'fixtures/visual-maimai/rendering.json'));
const source = JSON.parse(input);
const fixtureSha256 = createHash('sha256').update(input).digest('hex');
const sprite = (value) => value && ({ sourceId: value.object_id, rect: value.rect, pivot: value.pivot, border: value.border, ppu: value.pixels_per_unit });
const sourcedSprite = (value) => value && ({
  sourceId: value.object_id,
  name: value.name,
  assetFile: value.asset_file,
  rect: value.rect,
  pivot: value.pivot,
  border: value.border,
  ppu: value.pixels_per_unit,
  texture: value.texture && {
    sourceId: value.texture.object_id, name: value.texture.name, assetFile: value.texture.asset_file,
    width: value.texture.width, height: value.texture.height,
  },
});
const transform = (value) => ({ position: value.local_position, rotation: value.local_rotation_xyzw, scale: value.local_scale });
const sortingGroupRecord = (group, includeTransformName = false) => ({
  sourceId: group.component_object_id,
  componentClass: group.component_class,
  gameObjectId: group.game_object_id,
  gameObjectName: group.game_object_name,
  transformId: group.transform_id,
  ...(includeTransformName ? { transformName: group.transform_name } : {}),
  sortingLayerId: group.sorting_layer_id,
  sortingLayerRaw: group.sorting_layer_raw,
  sortingOrder: group.sorting_order,
  enabled: group.enabled,
  sortAtRoot: group.sort_at_root,
});
const transformNode = (value) => ({
  sourceId: value.object_id, gameObjectId: value.game_object_id, name: value.name,
  position: value.local_position, rotation: value.local_rotation_xyzw, scale: value.local_scale,
  sortingGroups: (value.sorting_groups ?? []).map((group) => sortingGroupRecord(group)),
});
const rendererSortingGroups = (value) => (value.sorting_groups ?? []).map((group) => sortingGroupRecord(group, true));
const prefabs = Object.fromEntries(['tap', 'hold', 'touch', 'touchHold'].map((kind) => {
  const prefab = source.skin.prefabs[kind];
  return [kind, {
    sortingGroups: (prefab.prefab.root.sorting_groups ?? []).map((group) => sortingGroupRecord(group)),
    sprites: Object.fromEntries(prefab.sprites.map((entry) => [entry.role, sprite(entry.sprite)])),
    renderers: prefab.renderers.filter((entry) => entry.transform_chain_root_first).map((entry) => ({
      role: entry.role, sprite: sprite(entry.sprite), size: entry.size, mode: entry.draw_mode,
      order: entry.sorting_order, layer: entry.sorting_layer_id, color: entry.color_rgba,
      sortingGroups: rendererSortingGroups(entry),
      // Controllers replace the prefab root transform. Child transforms remain serialized values.
      transforms: entry.transform_chain_root_first.slice(1).map(transform),
    })),
  }];
}));
const notePlaceAreaSource = source.note_place_area;
if (notePlaceAreaSource?.positions?.entries?.length !== 41) {
  throw new Error('Expected 41 serialized NotePlaceArea positions');
}
const notePlaceArea = {
  radius: 5.5,
  positions: notePlaceAreaSource.positions.entries.map(({ key, position }) => ({ key, position })),
  source: {
    fixturePath: 'fixtures/visual-maimai/rendering.json',
    fixtureSha256,
    componentId: notePlaceAreaSource.component_object_id,
    gameObjectId: notePlaceAreaSource.game_object.object_id,
    positionsAssetId: notePlaceAreaSource.positions.object_id,
    baseTransformId: notePlaceAreaSource.base_transform.component_object_id,
    pointerTransformId: notePlaceAreaSource.pointer.component_object_id,
    assetPath: notePlaceAreaSource.positions.asset_file,
    assetSha256: notePlaceAreaSource.positions.asset_sha256,
  },
};
const touchFireworkSource = source.skin.touch_firework;
if (!touchFireworkSource || touchFireworkSource.png?.sprite_object_id !== 386 || touchFireworkSource.png?.texture_object_id !== 185) {
  throw new Error('Expected Touch firework Sprite386 / Texture185 source data');
}
function touchFireworkPlacement(variant) {
  const display = touchFireworkSource.display[variant];
  if (!display) throw new Error(`Missing Touch firework placement: ${variant}`);
  const firework = display.firework;
  const imageTransform = firework.transform;
  const glyphNames = { touch: 'touch', touchMulti: 'touchMulti', touchHold: 'touchHold' };
  return {
    componentId: display.component_object_id,
    gameObjectId: display.game_object.object_id,
    rootSize: display.root_transform.size_delta,
    image: {
      gameObjectId: firework.game_object.object_id,
      imageComponentId: firework.image.component_object_id,
      size: imageTransform.size_delta,
      anchorMin: imageTransform.anchor_min,
      anchorMax: imageTransform.anchor_max,
      anchoredPosition: imageTransform.anchored_position,
      pivot: imageTransform.pivot,
      color: firework.image.color_rgba,
      active: firework.game_object.active,
      siblingIndex: firework.sibling_index,
    },
    glyphSizes: Object.fromEntries(Object.entries(glyphNames).map(([kind, name]) => [kind, display.glyphs[name].transform.size_delta])),
    glyphSiblingIndexes: Object.fromEntries(Object.entries(glyphNames).map(([kind, name]) => [kind, display.glyphs[name].sibling_index])),
    siblingOrder: display.sibling_order,
  };
}
const touchFirework = {
  assetKey: 'touch.firework',
  size: [touchFireworkSource.png.width, touchFireworkSource.png.height],
  placements: {
    timeline: touchFireworkPlacement('timeline'),
    sensor: touchFireworkPlacement('sensor'),
    pointer: touchFireworkPlacement('pointer'),
  },
  source: {
    fixturePath: 'fixtures/visual-maimai/rendering.json',
    fixtureSha256,
    sourceAsset: 'Visual Maimai/Visual Maimai_Data/sharedassets0.assets',
    sourceAssetSha256: touchFireworkSource.png.asset_sha256,
    spriteId: touchFireworkSource.png.sprite_object_id,
    textureId: touchFireworkSource.png.texture_object_id,
    logicalSpriteRect: touchFireworkSource.png.sprite_rect,
    textureRect: touchFireworkSource.png.texture_rect,
    textureRectOffset: touchFireworkSource.png.texture_rect_offset,
    extractedSpriteCropSize: [touchFireworkSource.png.sprite_crop_width, touchFireworkSource.png.sprite_crop_height],
    cropPixelOffsetTopLeft: touchFireworkSource.png.crop_pixel_offset_top_left,
    exportedTextureSize: [touchFireworkSource.png.width, touchFireworkSource.png.height],
    exportMethod: touchFireworkSource.png.png_method,
    displaySources: Object.fromEntries(['timeline', 'sensor', 'pointer'].map((variant) => [variant, {
      componentId: touchFireworkSource.display[variant].component_object_id,
      gameObjectId: touchFireworkSource.display[variant].game_object.object_id,
      fireworkGameObjectId: touchFireworkSource.display[variant].firework.game_object.object_id,
      fireworkSpriteId: touchFireworkSource.display[variant].firework.image.sprite.object_id,
      fireworkTextureId: touchFireworkSource.display[variant].firework.image.sprite.texture.object_id,
    }])),
  },
};
const parameters = {
  sourceSha256: fixtureSha256,
  tracks: source.runtime.tracks.map((track) => transform(track.parent_chain_root_first.at(-1))),
  touchPositions: source.runtime.touch_positions.entries,
  notePlaceArea,
  touchFirework,
  prefabs,
};
await output('apps/web/src/skin/parameters.json', parameters);

const slidePrefab = source.skin.prefabs.slide.prefab;
const slideHeadSource = source.skin.prefabs.slide;
const slideHead = {
  root: transformNode(slidePrefab.root),
  rootScale: slidePrefab.root_scale,
  sprites: Object.fromEntries(slideHeadSource.sprites.map((entry) => [entry.role, sourcedSprite(entry.sprite)])),
  renderers: slideHeadSource.renderers.filter((entry) => entry.transform_chain_root_first).map((entry) => ({
    role: entry.role,
    sourceId: entry.object_id,
    gameObjectId: entry.game_object.object_id,
    sprite: sourcedSprite(entry.sprite),
    size: entry.size,
    mode: entry.draw_mode,
    order: entry.sorting_order,
    layer: entry.sorting_layer_id,
    sortingGroups: rendererSortingGroups(entry),
    color: entry.color_rgba,
    materials: entry.materials.map((material) => ({ sourceId: material.object_id, name: material.name, assetFile: material.asset_file })),
    transforms: entry.transform_chain_root_first.map(transformNode),
  })),
};

const starModelSource = source.skin.star_model;
const starModel = {
  componentId: starModelSource.component_object_id,
  componentClass: starModelSource.component_class,
  root: transformNode(starModelSource.root),
  rootScale: starModelSource.root_scale,
  sprites: Object.fromEntries(Object.entries(starModelSource.sprites).map(([role, value]) => [role, sourcedSprite(value)])),
  renderers: starModelSource.renderers.map((entry) => ({
    role: entry.role,
    sourceId: entry.object_id,
    gameObjectId: entry.game_object.object_id,
    sprite: sourcedSprite(entry.sprite),
    size: entry.size,
    mode: entry.draw_mode,
    order: entry.sorting_order,
    layer: entry.sorting_layer_id,
    sortingGroups: rendererSortingGroups(entry),
    color: entry.color_rgba,
    materials: entry.materials.map((material) => ({ sourceId: material.object_id, name: material.name, assetFile: material.asset_file })),
    transforms: entry.transform_chain_root_first.map(transformNode),
  })),
};

const lineMaterials = Object.fromEntries(Object.entries(source.skin.slide_line.materials).map(([variant, material]) => {
  const mainTexture = material.textures.find((entry) => entry.name === '_MainTex');
  return [variant === 'single' ? 'normal' : variant === 'multi' ? 'each' : variant, {
    sourceId: material.object_id,
    name: material.name,
    assetFile: material.asset_file,
    shader: material.shader && { sourceId: material.shader.object_id, name: material.shader.name, assetFile: material.shader.asset_file },
    texture: mainTexture?.texture && {
      sourceId: mainTexture.texture.object_id, name: mainTexture.texture.name, assetFile: mainTexture.texture.asset_file,
      width: mainTexture.texture.width, height: mainTexture.texture.height,
    },
    textureScale: mainTexture?.scale ?? null,
    textureOffset: mainTexture?.offset ?? null,
    colors: Object.fromEntries(material.colors.map((entry) => [entry.name, entry.value])),
  }];
}));
const lineSource = source.skin.slide_line;
const slideLine = {
  componentId: lineSource.component_object_id,
  componentClass: lineSource.component_class,
  root: transformNode(lineSource.root.root),
  rootScale: lineSource.root.root_scale,
  splitIndexesSource: lineSource.split_indexes_source,
  lines: lineSource.lines.map((entry) => ({
    role: entry.role,
    sourceId: entry.object_id,
    gameObjectId: entry.game_object.object_id,
    sprite: sourcedSprite(entry.sprite),
    size: entry.size,
    order: entry.sorting_order,
    layer: entry.sorting_layer_id,
    sortingGroups: rendererSortingGroups(entry),
    color: entry.color_rgba,
    materials: entry.materials.map((material) => ({ sourceId: material.object_id, name: material.name, assetFile: material.asset_file })),
    transforms: entry.transform_chain_root_first.map(transformNode),
    parameters: entry.line_parameters ? {
      widthMultiplier: entry.line_parameters.width_multiplier,
      widthCurve: entry.line_parameters.width_curve,
      alignment: entry.line_parameters.alignment,
      textureMode: entry.line_parameters.texture_mode,
      textureScale: entry.line_parameters.texture_scale,
      colorGradient: entry.line_parameters.color_gradient,
      numCornerVertices: entry.line_parameters.num_corner_vertices,
      numCapVertices: entry.line_parameters.num_cap_vertices,
      useWorldSpace: entry.line_parameters.use_world_space,
      loop: entry.line_parameters.loop,
    } : null,
  })),
  materials: lineMaterials,
};

const wifiSource = source.skin.slide_wifi;
const wifi = {
  componentId: wifiSource.component_object_id,
  componentClass: wifiSource.component_class,
  root: transformNode(wifiSource.root.root),
  rootScale: wifiSource.root.root_scale,
  groups: [...new Map(wifiSource.arrows.flatMap((entry) => entry.transform_chain_root_first.slice(1, -1).map((node) => [
    node.object_id, transformNode(node),
  ]))).values()],
  arrows: wifiSource.arrows.map((entry) => ({
    role: entry.role,
    sourceId: entry.object_id,
    gameObjectId: entry.game_object.object_id,
    sprite: sourcedSprite(entry.sprite),
    size: entry.size,
    mode: entry.draw_mode,
    order: entry.sorting_order,
    layer: entry.sorting_layer_id,
    sortingGroups: rendererSortingGroups(entry),
    color: entry.color_rgba,
    materials: entry.materials.map((material) => ({ sourceId: material.object_id, name: material.name, assetFile: material.asset_file })),
    transforms: entry.transform_chain_root_first.map(transformNode),
  })),
  sprites: Object.fromEntries(Object.entries(wifiSource.sprites).map(([key, sprites]) => [
    key === 'arrowsSingle' ? 'single' : key === 'arrowsMulti' ? 'multi' : 'break', sprites.map(sourcedSprite),
  ])),
};
const renderingParameters = {
  schemaVersion: 1,
  source: {
    fixturePath: 'fixtures/visual-maimai/rendering.json',
    fixtureSha256,
    unityVersion: source.metadata.unity_version,
    tool: source.metadata.tool,
    toolVersion: source.metadata.tool_version,
    assetPath: source.metadata.asset_path,
    sourceAssetSha256: source.metadata.source_sha256['sharedassets0.assets'],
  },
  provenance: {
    skinManagerComponentId: source.skin.component_object_id,
    slideHeadComponentId: slideHeadSource.component.object_id,
    slideHeadGameObjectId: slideHeadSource.component.game_object.object_id,
    starModelComponentId: starModel.componentId,
    slideLineComponentId: slideLine.componentId,
    slideWifiComponentId: wifi.componentId,
  },
  sorting: {
    slideHead: slideHead.root.sortingGroups,
    movingStar: starModel.root.sortingGroups,
    slideLine: slideLine.lines[0]?.sortingGroups ?? [],
    wifiArrows: wifi.arrows[0]?.sortingGroups ?? [],
    notePrefabs: Object.fromEntries(['tap', 'hold', 'touch', 'touchHold'].map((kind) => [
      kind,
      (source.skin.prefabs[kind].prefab.root.sorting_groups ?? []).map((group) => sortingGroupRecord(group)),
    ])),
    rendererOrders: {
      slideHead: slideHead.renderers.map(({ role, sourceId, order, layer }) => ({ role, sourceId, order, layer })),
      movingStar: starModel.renderers.map(({ role, sourceId, order, layer }) => ({ role, sourceId, order, layer })),
      slideLine: slideLine.lines.map(({ role, sourceId, order, layer }) => ({ role, sourceId, order, layer })),
      wifiArrows: wifi.arrows.map(({ role, sourceId, order, layer }) => ({ role, sourceId, order, layer })),
    },
  },
  head: slideHead,
  starModel,
  slideLine,
  wifi,
};
await output('apps/web/src/skin/slide-parameters.json', renderingParameters);
const destination = 'apps/web/public/assets/visual-maimai/embedded';
if (!check) await mkdir(path.join(root, destination), { recursive: true });
const assets = [];
for (const [role, suffix] of [['singleEndPoint', 'base'], ['multiEndPoint', 'each'], ['breakEndPoint', 'break']]) {
  const entry = source.skin.endpoint_pngs[role];
  const sourcePath = `fixtures/visual-maimai/${entry.file}`;
  const outputPath = `${destination}/${entry.file}`;
  const bytes = await readFile(path.join(root, sourcePath));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== entry.png_sha256) throw new Error(`Extracted endpoint hash mismatch: ${entry.file}`);
  if (check) {
    if (!(await readFile(path.join(root, outputPath))).equals(bytes)) throw new Error(`Changed endpoint: ${outputPath}`);
  } else await copyFile(path.join(root, sourcePath), path.join(root, outputPath));
  assets.push({ key: `hold.end.${suffix}`, sourcePath, outputPath, sha256, width: entry.width, height: entry.height,
    sourceAsset: 'Visual Maimai/Visual Maimai_Data/sharedassets0.assets', sourceAssetSha256: entry.asset_sha256,
    spriteId: entry.sprite_object_id, textureId: entry.texture_object_id });
}
const fireworkAsset = touchFireworkSource.png;
const fireworkSourcePath = `fixtures/visual-maimai/${fireworkAsset.file}`;
const fireworkOutputPath = `${destination}/touch_firework.png`;
const fireworkBytes = await readFile(path.join(root, fireworkSourcePath));
const fireworkSha256 = createHash('sha256').update(fireworkBytes).digest('hex');
if (fireworkSha256 !== fireworkAsset.png_sha256) throw new Error('Extracted Touch firework hash mismatch');
if (check) {
  if (!(await readFile(path.join(root, fireworkOutputPath))).equals(fireworkBytes)) throw new Error(`Changed Touch firework: ${fireworkOutputPath}`);
} else await copyFile(path.join(root, fireworkSourcePath), path.join(root, fireworkOutputPath));
assets.push({
  key: 'touch.firework', sourcePath: fireworkSourcePath, outputPath: fireworkOutputPath,
  sha256: fireworkSha256, width: fireworkAsset.width, height: fireworkAsset.height,
  sourceAsset: 'Visual Maimai/Visual Maimai_Data/sharedassets0.assets', sourceAssetSha256: fireworkAsset.asset_sha256,
  spriteId: fireworkAsset.sprite_object_id, textureId: fireworkAsset.texture_object_id,
  logicalSpriteRect: fireworkAsset.sprite_rect, textureRect: fireworkAsset.texture_rect,
  textureRectOffset: fireworkAsset.texture_rect_offset,
  extractedSpriteCropSize: [fireworkAsset.sprite_crop_width, fireworkAsset.sprite_crop_height],
  cropPixelOffsetTopLeft: fireworkAsset.crop_pixel_offset_top_left,
  exportMethod: fireworkAsset.png_method,
});
await output(`${destination}/manifest.json`, { assets });
console.log(`${check ? 'Verified' : 'Prepared'} scene parameters, three Hold endpoints, and the Touch firework marker.`);
