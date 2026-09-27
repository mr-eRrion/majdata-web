import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline, clickTouchTimeline, timelinePoint } from './timeline-browser-helpers.mjs';

const parameters = JSON.parse(await readFile(new URL('../apps/web/src/skin/parameters.json', import.meta.url), 'utf8'));
const ringRadius = Math.hypot(...parameters.tracks[0].position.slice(0, 2));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => void dialog.accept());
await page.addInitScript(() => {
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...options) {
    if ((window.delayCircleEdit && message?.type === 'edit') || (window.delayCircleImport && message?.type === 'import')) {
      setTimeout(() => postMessage.call(this, message, ...options), typeof window.delayCircleEdit === 'number' ? window.delayCircleEdit : 150);
    } else postMessage.call(this, message, ...options);
  };
});
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const count = n => page.locator('.timeline-panel > .panel-title').getByText(`${n} 个音符`, { exact: true }).waitFor();
const tool = name => page.getByRole('button', { name, exact: true }).click();
const host = page.locator('.circular-preview-canvas');
let loadIndex = 0;
async function load(text = '&first=0\n&inote_1=(120){4},,,,,,,,E\n') {
  const name = `circle-${++loadIndex}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}
async function point(key) {
  const position = parameters.notePlaceArea.positions.find(area => area.key === key).position;
  const bounds = await host.boundingBox();
  const scale = Math.min(bounds.width, bounds.height) * .36 / ringRadius;
  return { x: bounds.x + bounds.width / 2 + position[0] * scale, y: bounds.y + bounds.height / 2 + 4 - position[1] * scale };
}
async function click(key, button = 'left') {
  const p = await point(key);
  await page.mouse.click(p.x, p.y, { button });
}
async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, seconds) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(seconds));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction(value => Math.abs(parseFloat(document.querySelector('.transport output').textContent) - value) < .002, seconds);
}
async function exported() {
  const waiting = page.waitForEvent('download');
  await tool('导出 maidata.txt');
  return readFile(await (await waiting).path());
}
async function fastStroke(keys, button = 'left') {
  const first = await point(keys[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down({ button });
  // Deliver transitions before React/Worker can acknowledge: this exercises reservations and queueing.
  const positions = await Promise.all(keys.slice(1).map(point));
  await host.evaluate((element, { positions, button }) => {
    for (const p of positions) element.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: p.x, clientY: p.y, buttons: button === 'right' ? 2 : 1,
    }));
  }, { positions, button });
  await page.mouse.up({ button });
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  await load();
  await tool('Tap');
  const keys = parameters.notePlaceArea.positions.map(area => area.key);
  await fastStroke([...keys, ...keys]);
  await count(41);
  await version(41);
  await page.screenshot({ path: '/tmp/maijdata-place-area-41.png', fullPage: true });
  await tool('撤销 ⌘Z'); await count(40); await version(42);
  await tool('重做 ⇧⌘Z'); await count(41); await version(43);
  await click('1');
  await exported(); // Wait behind all queued edits before checking no-op history.
  await version(43);
  await fastStroke(['1', 'C', '1', 'C'], 'right');
  await count(39); await version(45);
  const allAreas = await exported();
  await load(allAreas.toString()); await count(39);
  assert.deepEqual(await exported(), allAreas);

  await load(); await tool('Tap');
  await page.evaluate(() => { window.delayCircleEdit = true; });
  await click('2'); await click('2', 'right'); await click('2');
  await count(1); await version(3);
  await page.evaluate(() => { window.delayCircleEdit = false; });
  await tool('撤销 ⌘Z'); await count(0); await version(4);
  await tool('撤销 ⌘Z'); await count(1); await version(5);
  await tool('撤销 ⌘Z'); await count(0); await version(6);

  await load(); await tool('Tap');
  await page.evaluate(() => { window.delayCircleEdit = 500; });
  await click('1'); await click('2');
  const queuedDelete = await timelinePoint(page, 0, 2);
  await page.mouse.click(queuedDelete.x, queuedDelete.y, { button: 'right' });
  await count(1); await version(3);
  await page.evaluate(() => { window.delayCircleEdit = false; });
  await tool('撤销 ⌘Z'); await count(2); await version(4);

  await load(); await tool('Tap'); await tool('Touch Hold');
  await page.evaluate(() => { window.delayCircleEdit = 500; });
  await click('1'); await click('C'); await clickTouchTimeline(page, .5);
  await count(2); await version(2);
  await page.evaluate(() => { window.delayCircleEdit = false; });
  assert.match((await exported()).toString(), /Ch\[4:1\]/);

  await load();
  await tool('Touch Hold');
  await click('C');
  await tool('Touch');
  await click('B2');
  await count(0); await version(0); // Touch Hold cannot end by crossing another circular region.
  await tool('Hold');
  await click('3'); await tool('Tap'); await click('6');
  await count(1); await version(1); // Ring endpoint keeps the first lane, even at zero duration.
  await tool('Touch');
  await clickTouchTimeline(page, .5);
  await count(2); await version(2);
  await page.screenshot({ path: '/tmp/maijdata-place-area-holds.png', fullPage: true });
  const holds = (await exported()).toString();
  assert.match(holds, /3h\[/);
  assert(!holds.includes('6h['));
  assert.match(holds, /Ch\[4:1\]/);
  await tool('选择'); await clickTimeline(page, 0, 3);
  assert.equal(await page.getByLabel('Hold 固定秒数', { exact: true }).inputValue(), '0');
  await seek(.25);
  await click('C', 'right'); await count(1); await version(3); // Delete within the hold interval.
  await tool('撤销 ⌘Z'); await count(2); await version(4);

  await load(); await tool('Tap');
  const bounds = await host.boundingBox();
  await page.mouse.click(bounds.x + 2, bounds.y + 2); // Outside circular boundary.
  await seek(-1); await click('1');
  await exported(); await count(0); await version(0);
  await seek(0); await tool('播放');
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await click('1');
  await tool('暂停'); await exported(); await count(0); await version(0);
  await seek(0);
  const start = await point('1');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await count(1);
  await host.evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 99, pointerType: 'touch' }));
    element.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 99, pointerType: 'touch' }));
  });
  const next = await point('2'); await page.mouse.move(next.x, next.y);
  await count(2);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const end = await point('3'); await page.mouse.move(end.x, end.y); await page.mouse.up();
  await exported(); await count(2); await version(2);
  await page.evaluate(() => { window.delayCircleImport = true; });
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'replacement.txt', mimeType: 'text/plain',
    buffer: Buffer.from('&first=0\n&inote_1=(120){4}8,E\n') });
  await click('2');
  await version(0); await count(1);
  await page.evaluate(() => { window.delayCircleImport = false; });
  const replacement = (await exported()).toString();
  assert(replacement.includes('8,E') && !replacement.includes('2/'));
  await load('&first=0\n&inote_1=(120){4}1-5[4:1],E\n');
  await click('1'); await click('1', 'right'); await exported();
  await count(1); await version(0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/maijdata-place-area.png', fullPage: true });
  const report = { browser: browser.version(), areas: keys.length, flows: ['41-source-centers', 'fast-cross-family-stroke', 'inflight-and-confirmed-duplicate-rejection', 'per-note-undo-redo', 'add-delete-add-before-acknowledgement', 'continuous-right-delete', 'queued-circle-add-before-timeline-delete', 'independent-Hold-and-TouchHold-pending', 'tool-switch-preserves-pending', 'TouchHold-timeline-end', 'queued-TouchHold-start-before-timeline-end', 'zero-Hold-keeps-first-lane', 'delete-within-Hold', 'export-reopen', 'outside-negative-playing-readonly-gates', 'secondary-pointer-does-not-cancel-stroke', 'blur-cancels-stroke', 'document-replacement-gates-input'], errors };
  await writeFile('/tmp/maijdata-place-area.json', JSON.stringify(report, null, 2));
  console.log(report);
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-place-area-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 4000));
  throw error;
} finally { await browser.close(); }
