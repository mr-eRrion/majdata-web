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
  await load(); await tool('选择'); await flags(true, true);
  await middle(0, 1); await version(1); await count(3);
  assert.match((await exported()).toString(), /1bx/);
  await middle(0, 1); await exported(); await version(1);
  await middle(.5, 2); await version(2);
  assert.match((await exported()).toString(), /2bxh\[4:2\]/);
  await tool('撤销 ⌘Z'); await version(3); assert.doesNotMatch((await exported()).toString(), /2bxh/);
  await tool('重做 ⇧⌘Z'); await version(4); const saved = await exported();
  await load(saved.toString()); assert.deepEqual(await exported(), saved);

  await flags(false, false); await circle('1'); await version(1);
  // Middle applies only on press; crossing to another region while held does not repeat.
  await flags(true, false);
  const first = await area('1'), second = await area('2');
  await page.mouse.move(first.x, first.y); await page.mouse.down({ button: 'middle' }); await version(2);
  await page.mouse.move(second.x, second.y); await page.mouse.up({ button: 'middle' });
  await exported(); await version(2); await circle('A1'); await exported(); await version(2);
  const beforePan = await exported();
  const pan = await timelinePoint(page, 0, 2);
  await page.mouse.move(pan.x, pan.y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(pan.x, pan.y + 60, { steps: 3 }); await page.mouse.up({ button: 'middle' });
  assert.deepEqual(await exported(), beforePan); await version(2);

  await load('&first=0\n&inote_1=(120){4},,,,E\n'); await flags(true, true);
  await tool('Tap'); await clickTimeline(page, 0, 1); await version(1);
  await circle('2', 'left'); await version(2);
  const hover = await timelinePoint(page, .5, 3); await page.mouse.move(hover.x, hover.y);
  await page.keyboard.press('ArrowRight'); await version(3);
  await tool('Hold'); await clickTimeline(page, 1, 4); await clickTimeline(page, 1.5, 4); await version(4);
  const placed = (await exported()).toString();
  for (const token of ['1bx', '2bx', '3bx', '4bxh']) assert(placed.includes(token), token);
  // A pending Hold gates middle application, but finishing it uses the current template.
  await clickTimeline(page, 1, 5); await flags(false, false); await middle(0, 1);
  await exported(); await version(4);
  await page.getByLabel('播放位置', { exact: true }).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '0');
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => parseFloat(document.querySelector('.transport output').textContent) === 0);
  await circle('2'); await version(5); // Circle template application remains available while Hold is pending.
  const cancel = await timelinePoint(page, 1, 5); await page.mouse.click(cancel.x, cancel.y, { button: 'right' });
  await middle(0, 1); await version(6);
  assert.doesNotMatch((await exported()).toString(), /1bx/);
  await page.screenshot({ path: '/tmp/maijdata-tool-template.png', fullPage: true });

  const readonly = '&first=0\n&inote_1=(120){4}1/2-4[4:1]-6[4:1],E\n';
  await load(readonly);
  await flags(true, true); await middle(0, 1); await circle('1');
  assert.equal((await exported()).toString(), readonly); await version(0);
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), flows: ['timeline-middle-applies', 'same-template-no-history',
    'Hold-duration-preserved', 'undo-redo-export-reopen', 'circle-middle-press-only', 'Touch-unchanged',
    'middle-drag-does-not-apply', 'timeline-circle-arrow-template-placement', 'pending-Hold-timeline-gate-circle-allowed', 'readonly-gate'], errors };
  await writeFile('/tmp/maijdata-tool-template.json', JSON.stringify(report, null, 2)); console.log(report);
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-tool-template-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 4000)); throw error;
} finally { await browser.close(); }
