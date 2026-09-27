import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseUrl);
  const decoded = await page.evaluate(async () => {
    const root = new URL('./assets/visual-maimai/', document.baseURI);
    const response = await fetch(new URL('manifest.json', root));
    if (!response.ok) throw new Error(`Skin manifest HTTP ${response.status}`);
    const manifest = await response.json();
    const embedded = await (await fetch(new URL('embedded/manifest.json', root))).json();
    const checks = await (await fetch(new URL('checks/manifest.json', root))).json();
    return Promise.all([...manifest.assets, ...embedded.assets, ...checks.assets].map(async (asset) => {
      const image = new Image();
      image.src = new URL(asset.outputPath.replace('apps/web/public/assets/visual-maimai/', ''), root).href;
      await image.decode();
      return { key: asset.key, expected: [asset.width, asset.height], actual: [image.naturalWidth, image.naturalHeight] };
    }));
  });
  assert.equal(decoded.length, 67);
  for (const asset of decoded) assert.deepEqual(asset.actual, asset.expected, asset.key);
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await page.locator('.document-heading .status').filter({ hasText: 'v0 ·' }).waitFor();
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  await page.goto(new URL('skin-reference.html', baseUrl).href);
  await page.waitForFunction(() => document.querySelectorAll('.wifi-card canvas[data-ready="true"]').length === 3);
  await page.evaluate(() => Promise.all([...document.images].map((image) => { image.loading = 'eager'; return image.decode(); })));
  assert.equal(await page.locator('.card').count(), 10);
  assert.equal(await page.locator('.load-error:visible').count(), 0);
  await page.screenshot({ path: '/tmp/maijdata-skin-reference.png', fullPage: true });
  assert.deepEqual(errors, []);
  const failed = await browser.newPage();
  await failed.route('**/assets/visual-maimai/tap.png', (route) => route.abort());
  await failed.goto(baseUrl);
  await failed.getByRole('alert').filter({ hasText: /皮肤图片加载失败.*tap\.png/ }).waitFor();
  await failed.close();
  console.log(JSON.stringify({ browser: browser.version(), decoded: decoded.length, missingAssetReported: true, errors }, null, 2));
} finally {
  await browser.close();
}
