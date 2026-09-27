import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { timelinePoint, clickTimeline } from './timeline-browser-helpers.mjs';

const parameters = JSON.parse(await readFile(new URL('../apps/web/src/skin/parameters.json', import.meta.url), 'utf8'));
const radius = Math.hypot(...parameters.tracks[0].position.slice(0, 2));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
let imports = 0;
async function load(source) {
  const name = `star-${++imports}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(source) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0); await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}
async function exported() {
  const download = page.waitForEvent('download'); await tool('导出 maidata.txt');
  return (await readFile(await (await download).path())).toString();
}
async function middle(seconds, lane) {
  const p = await timelinePoint(page, seconds, lane); await page.mouse.click(p.x, p.y, { button: 'middle' });
}
async function circle(key, button = 'left') {
  const [x, y] = parameters.notePlaceArea.positions.find(item => item.key === key).position;
  const r = await page.locator('.circular-preview-canvas').boundingBox();
  const scale = Math.min(r.width, r.height) * .36 / radius;
  await page.mouse.click(r.x + r.width / 2 + x * scale, r.y + r.height / 2 + 4 - y * scale, { button });
}
async function flags(brk, ex, star) {
  await page.getByLabel('工具 Break', { exact: true }).setChecked(brk);
  await page.getByLabel('工具 EX', { exact: true }).setChecked(ex);
  await page.getByLabel('工具星形 Tap', { exact: true }).setChecked(star);
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const source = '&first=0\n&inote_1=(120){4}1$bx/2$,3$,,,E\n';
  await load(source);
  await page.locator('.timeline-panel').getByText('可编辑', { exact: true }).waitFor();
  assert.equal(await exported(), source);
  await tool('选择'); await flags(true, true, false); await middle(0, 1); await version(1);
  let edited = await exported(); assert(edited.includes('1bx')); assert(!edited.includes('1$')); assert(edited.includes('2$'));
  await tool('撤销 ⌘Z'); await version(2); assert((await exported()).includes('1$bx'));
  await tool('重做 ⇧⌘Z'); await version(3);
  await clickTimeline(page, 0, 1);
  assert.equal(await page.getByLabel('音符星形 Tap', { exact: true }).isChecked(), false);
  const before = await page.locator('.timeline-canvas').evaluate(el => el.toDataURL());
  await page.getByLabel('音符星形 Tap', { exact: true }).click(); await version(4);
  await page.waitForFunction(before => document.querySelector('.timeline-canvas').toDataURL() !== before, before);
  assert((await exported()).includes('1$bx'));
  edited = await exported(); await load(edited); assert.equal(await exported(), edited);

  // One template reaches timeline, sensor-ring and fast-key placement; Hold remains a Hold.
  await load('&first=0\n&inote_1=(120){4},,,,,,,,E\n');
  await flags(false, true, false); await tool('Tap');
  const icon = page.getByRole('button', { name: 'Tap', exact: true }).locator('canvas');
  const tapIcon = await icon.evaluate(el => el.toDataURL());
  await page.getByLabel('工具星形 Tap', { exact: true }).check();
  await page.waitForFunction(tapIcon => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Tap').querySelector('canvas').toDataURL() !== tapIcon, tapIcon);
  await clickTimeline(page, .5, 1); await version(1);
  await circle('2'); await version(2);
  const p = await timelinePoint(page, 1, 3); await page.mouse.move(p.x, p.y);
  await page.keyboard.press('ArrowRight'); await version(3);
  await tool('Hold'); await clickTimeline(page, 1.5, 4); await clickTimeline(page, 2, 4); await version(4);
  let placed = await exported();
  for (const token of ['1$x', '2$x', '3$x', '4xh[4:1]']) assert(placed.includes(token), placed);
  assert(!placed.includes('4$'));
  // Middle on an existing Hold applies Break/EX without forceStar; ring Tap gets the flag.
  await flags(true, false, true); await middle(1.5, 4); await version(5);
  assert((await exported()).includes('4bh[4:1]'));
  await flags(false, true, false);
  // Fast-key placement advances the playhead; restore zero before testing the ring target.
  await page.getByLabel('播放位置', { exact: true }).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => parseFloat(document.querySelector('.transport output').textContent) === 0);
  await circle('2', 'middle'); await version(6);
  assert(!(await exported()).includes('2$'));
  placed = await exported(); await load(placed); assert.equal(await exported(), placed);
  // The same paused frame must switch its actual Pixi sprite and reproduce it on undo.
  await tool('选择'); await clickTimeline(page, .5, 1);
  await page.getByLabel('播放位置', { exact: true }).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0.4');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('.transport output').textContent) - .4) < .002);
  const preview = page.locator('.circular-preview-panel canvas');
  const starPng = await preview.screenshot();
  await page.getByLabel('音符星形 Tap', { exact: true }).click(); await version(1);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  assert(!starPng.equals(await preview.screenshot()), 'star-to-Tap must change the actual preview pixels');
  await tool('撤销 ⌘Z'); await version(2);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  assert(starPng.equals(await preview.screenshot()), 'undo must reproduce the static star frame');
  await page.screenshot({ path: '/tmp/maijdata-force-star.png', fullPage: true });

  for (const token of ['1$$', '1$h[4:1]', 'A1$', '1$$bx']) {
    const invalid = `&first=0\n&inote_1=(120){4}${token},E\n`;
    await load(invalid); await page.locator('.timeline-panel').getByText('只读', { exact: true }).waitFor();
    assert.equal(await exported(), invalid);
  }
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), flows: ['WASM-single-star-Tap-combinations', 'unchanged-byte-export',
    'template-property-undo-redo-export-reopen', 'timeline-icon-pixels', 'three-placement-entries', 'Hold-template-isolation',
    'ring-middle-template', 'Pixi-static-star-undo-pixels', 'double-star-and-other-families-readonly'], errors };
  await writeFile('/tmp/maijdata-force-star.json', JSON.stringify(report, null, 2)); console.log(report);
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-force-star-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 4000)); throw error;
} finally { await browser.close(); }
