import manifest from '../../public/assets/visual-maimai/manifest.json';
import embedded from '../../public/assets/visual-maimai/embedded/manifest.json';
import checks from '../../public/assets/visual-maimai/checks/manifest.json';

/** One source of URLs for Canvas, toolbar images, and Pixi textures. */
export const skinAssets = new Map([...manifest.assets, ...embedded.assets, ...checks.assets].map((asset) => [asset.key, {
  ...asset,
  url: `${import.meta.env.BASE_URL}${asset.outputPath.replace('apps/web/public/', '')}`,
}]));

const images = new Map<string, Promise<HTMLImageElement>>();

export function skinAsset(key: string) {
  const asset = skinAssets.get(key);
  if (!asset) throw new Error(`缺少皮肤映射：${key}`);
  return asset;
}

export function loadSkinImage(key: string): Promise<HTMLImageElement> {
  let pending = images.get(key);
  if (!pending) {
    const asset = skinAsset(key);
    pending = (async () => {
      const image = new Image();
      image.src = asset.url;
      try { await image.decode(); }
      catch { throw new Error(`皮肤图片加载失败：${asset.url}`); }
      return image;
    })();
    images.set(key, pending);
  }
  return pending;
}

export async function loadSkinImages(keys: readonly string[]): Promise<Map<string, HTMLImageElement>> {
  return new Map(await Promise.all(keys.map(async (key) => [key, await loadSkinImage(key)] as const)));
}

export const coreSkinKeys = [...manifest.assets, ...embedded.assets]
  .filter(({ key }) => /^(tap|hold|touch|touchhold)\./.test(key))
  .map(({ key }) => key);

export function ringSkinKey(family: 'tap' | 'hold' | 'star' | 'star.double' | 'slide', isEach: boolean, isBreak: boolean): string {
  return `${family}.${isBreak ? 'break' : isEach ? 'each' : 'base'}`;
}
