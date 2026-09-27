import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { timelinePoint, clickTimeline, clickTouchTimeline } from './timeline-browser-helpers.mjs';
const parameters = JSON.parse(await readFile(new URL('../apps/web/src/skin/parameters.json', import.meta.url), 'utf8'));
const radius = Math.hypot(...parameters.tracks[0].position.slice(0, 2));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => void dialog.accept());
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const count = n => page.locator('.timeline-panel > .panel-title').getByText(`${n} 个音符`, { exact: true }).waitFor();
let imports = 0;
async function load(text = '&first=0\n&inote_1=(120){4}1/2h[4:2]/A1,,,,E\n') {
  const name = `template-${++imports}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0); await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}
async function exported() {
  const waiting = page.waitForEvent('download'); await tool('导出 maidata.txt');
  return readFile(await (await waiting).path());
}
async function middle(seconds, lane) {
  const point = await timelinePoint(page, seconds, lane);
  await page.mouse.click(point.x, point.y, { button: 'middle' });
}
async function area(key) {
  const [x, y] = parameters.notePlaceArea.positions.find(item => item.key === key).position;
  const bounds = await page.locator('.circular-preview-canvas').boundingBox();
  const scale = Math.min(bounds.width, bounds.height) * .36 / radius;
  return { x: bounds.x + bounds.width / 2 + x * scale, y: bounds.y + bounds.height / 2 + 4 - y * scale };
}
async function circle(key, button = 'middle') { const p = await area(key); await page.mouse.click(p.x, p.y, { button }); }
async function flags(brk, ex) {
  await page.getByLabel('工具 Break', { exact: true }).setChecked(brk);
  await page.getByLabel('工具 EX', { exact: true }).setChecked(ex);
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const source = '&first=0\n&inote_1=(120){4}A1f/Cf/B2fh[4:2],D3bf,E4f,E\n';
  await load(source); await count(5);
  await page.locator('.timeline-panel').getByText('可编辑', { exact: true }).waitFor();
  assert.equal((await exported()).toString(), source);
  await page.getByLabel('工具 Touch 烟花', { exact: true }).check();
  await circle('D3'); await version(0); // No note at the current time in D3.
  await page.getByLabel('工具 Touch 烟花', { exact: true }).uncheck();
  await circle('A1'); await version(1);
  let changed = (await exported()).toString();
  assert(!changed.includes('A1f')); assert(changed.includes('Cf')); assert(changed.includes('B2fh[4:2]')); assert(changed.includes('D3fb'));
  await tool('撤销 ⌘Z'); await version(2); assert((await exported()).toString().includes('A1f'));
  await tool('重做 ⇧⌘Z'); await version(3);
  await circle('B2'); await version(4);
  changed = (await exported()).toString(); assert(changed.includes('B2h[4:2]')); assert(!changed.includes('B2fh'));
  await load(changed); assert.equal((await exported()).toString(), changed);
  // New Touch and TouchHold share the independent Touch template.
  await load('&first=0\n&inote_1=(120){4},,,,E\n');
  await page.getByLabel('工具 Touch 烟花', { exact: true }).check();
  await flags(true, true); await tool('Touch'); await circle('A1', 'left'); await version(1);
  await tool('Touch Hold'); await circle('B2', 'left'); await clickTouchTimeline(page, .5); await version(2);
  const placed = (await exported()).toString();
  assert(placed.includes('A1f')); assert(placed.includes('B2fh[4:1]')); assert(!placed.includes('bx'));
  await load(placed); await count(2); assert.equal((await exported()).toString(), placed);
  // A single Touch glyph in the time track receives the Touch template, independent of the ring flags.
  await load('&first=0\n&inote_1=(120){4}Cf,,,,E\n'); await tool('选择');
  await page.getByLabel('工具 Touch 烟花', { exact: true }).uncheck();
  const p = await page.locator('.timeline-canvas').evaluate(el => {
    const r = el.getBoundingClientRect(); return { x: r.x + Number(el.dataset.touchTrackCenter), y: r.y + Number(el.dataset.playheadY) };
  });
  await page.mouse.click(p.x, p.y, { button: 'middle' }); await version(1);
  await clickTouchTimeline(page, 0);
  assert.equal(await page.getByLabel('音符烟花', { exact: true }).isChecked(), false);
  const markerBefore = await page.locator('.timeline-canvas').evaluate(el => {
    const x = Math.round(Number(el.dataset.touchTrackCenter)), y = Math.round(Number(el.dataset.playheadY));
    return { x: x - 20, y: y - 20, pixels: Array.from(el.getContext('2d').getImageData(x - 20, y - 20, 40, 40).data) };
  });
  await page.getByLabel('音符烟花', { exact: true }).click(); await version(2);
  await page.waitForFunction(before => {
    const pixels = document.querySelector('.timeline-canvas').getContext('2d').getImageData(before.x, before.y, 40, 40).data;
    return before.pixels.filter((value, i) => Math.abs(value - pixels[i]) > 10).length > 30;
  }, markerBefore);
  assert.equal(await page.getByLabel('音符烟花', { exact: true }).isChecked(), true);
  assert((await exported()).toString().includes('Cf'));
  await page.screenshot({ path: '/tmp/maijdata-firework.png', fullPage: true });
  for (const token of ['1f', '1fh[4:1]', 'A1ff', 'A1fx', 'A1hf[4:1]', '1-5f[4:1]']) {
    const invalid = `&first=0\n&inote_1=(120){4}${token},E\n`;
    await load(invalid);
    await page.locator('.timeline-panel').getByText('只读', { exact: true }).waitFor();
    assert.equal((await exported()).toString(), invalid);
  }
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), flows: ['WASM-Touch-TouchHold-firework', 'unchanged-byte-export',
    'circle-template-preserves-other-fields', 'undo-redo-export-reopen', 'Touch-placement-template',
    'single-Touch-track-template', 'property-editor-source-marker-pixels', 'invalid-firework-readonly-preservation'], errors };
  await writeFile('/tmp/maijdata-firework.json', JSON.stringify(report, null, 2)); console.log(report);
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-firework-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 4000)); throw error;
} finally { await browser.close(); }
