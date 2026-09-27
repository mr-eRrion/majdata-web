import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const scene = JSON.parse(await readFile(new URL('../fixtures/visual-maimai/rendering.json', import.meta.url), 'utf8'));
const parameters = JSON.parse(await readFile(new URL('../apps/web/src/skin/parameters.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const current = () => page.evaluate(() => window.__connected.responses.findLast(message => message.ok && message.type === 'snapshot').snapshot);
const notes = async () => (await current()).charts.find(chart => chart.difficulty === 1).notes;
const normalized = items => items.map(({ id, order, sourceRange, ...item }) => item);
const flows = [];
let imports = 0;
async function load(source) {
  const name = `connected-${++imports}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(source) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}
async function exported() {
  const pending = page.waitForEvent('download'); await tool('导出 maidata.txt');
  return readFile(await (await pending).path(), 'utf8');
}
async function roundtrip() {
  const before = normalized(await notes());
  const text = await exported(); await load(text);
  assert.deepEqual(normalized(await notes()), before);
  return text;
}
async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, seconds) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(seconds));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction(seconds => Math.abs(parseFloat(document.querySelector('.transport output').textContent) - seconds) < .002, seconds);
}
async function drawLine(start, end) {
  const info = scene.slide_types.commands.find(t => t.command === '-').infos.find(i => i.distance === (end - start + 8) % 8);
  const path = scene.slide_types.paths[info.path.path_id];
  const a = -(start - 1) * Math.PI / 4;
  const box = await page.getByRole('dialog').locator('.slide-picker-preview').boundingBox();
  const scale = Math.min(box.width, box.height) * .36 / Math.hypot(...parameters.tracks[0].position.slice(0, 2));
  const points = [...path.points].reverse().map(([x,y]) => ({
    x: box.x + box.width / 2 + (x * Math.cos(a) - y * Math.sin(a)) * scale,
    y: box.y + box.height / 2 + 4 - (x * Math.sin(a) + y * Math.cos(a)) * scale,
  }));
  await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
  await page.mouse.up();
}
try {
  await page.addInitScript(() => {
    window.__connected = { responses: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/i.test(String(url))) this.addEventListener('message', event => window.__connected.responses.push(event.data));
      }
    };
  });
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const source = '&title=Connected routes\n&first=0\n&inote_1=(120){4},1xb-3-7[4:4]*<5>1b[0.25##1.5]*w5[4:1],,,,,,,,E\n';
  await load(source);
  let note = (await notes())[0];
  assert.equal((await notes()).length, 1);
  assert.equal((await current()).charts[0].editable, true);
  assert.deepEqual(note.slide.continuations, [{ command: '-', endPosition: 7 }]);
  assert.deepEqual(note.slidePaths[0].segments.map(s => [s.startPosition, s.endPosition]), [[1, 3], [3, 7]]);
  assert.equal(note.slidePaths[0].moveStartSeconds, 1);
  assert.equal(note.slidePaths[0].endSeconds, 3);
  assert(note.slidePaths[0].segments[0].endSeconds < 2, 'unequal Visual lengths must not split duration equally');
  assert.equal(note.slidePaths[0].segments[0].endSeconds, note.slidePaths[0].segments[1].moveStartSeconds);
  assert.equal(await exported(), source);
  flows.push('legacy connected branches import with one head, one total duration, continuous length-weighted segments and exact bytes');
  for (const [label, seconds] of [['head', .25], ['first', 1.3], ['second', 2.4]]) {
    await seek(seconds); await page.screenshot({ path: `/tmp/maijdata-slide-connected-${label}.png` });
  }
  await seek(0); await tool('选择'); await clickTimeline(page, .5, 1);
  await tool('编辑连续路线');
  let dialog = page.getByRole('dialog');
  await dialog.locator('[data-preview-ready="true"]').waitFor();
  await dialog.getByLabel('下一段终点').selectOption('3');
  await dialog.getByRole('button', { name: '直线 -', exact: true }).click();
  await assert.equal(await dialog.getByLabel('连续路线草稿').textContent(), '1-3-7-3 · 3 段');
  await dialog.press('Escape');
  await version(0); assert.equal((await notes())[0].slide.continuations.length, 1);
  flows.push('route editing keeps draft isolated and Escape discards all fragments');

  await tool('编辑连续路线'); dialog = page.getByRole('dialog');
  await dialog.locator('[data-preview-ready="true"]').waitFor();
  await dialog.getByLabel('下一段终点').selectOption('3');
  await dialog.getByRole('button', { name: '直线 -', exact: true }).click();
  await dialog.getByRole('button', { name: '圆弧 <', exact: true }).hover();
  await dialog.click({ button: 'right', position: { x: 10, y: 10 } });
  assert.equal(await dialog.getByLabel('连续路线草稿').textContent(), '1-3-7-3 · 3 段', 'first right-click clears the temporary candidate');
  await dialog.click({ button: 'right', position: { x: 10, y: 10 } });
  assert.equal(await dialog.getByLabel('连续路线草稿').textContent(), '1-3-7 · 2 段');
  await dialog.getByRole('button', { name: '直线 -', exact: true }).click();
  await page.screenshot({ path: '/tmp/maijdata-slide-connected-editor.png' });
  await dialog.getByRole('button', { name: '保存整条路线', exact: true }).click();
  await version(1); assert.equal((await notes())[0].slide.continuations.length, 2);
  await tool('撤销 ⌘Z'); await version(2); assert.equal((await notes())[0].slide.continuations.length, 1);
  await tool('重做 ⇧⌘Z'); await version(3); assert.equal((await notes())[0].slide.continuations.length, 2);
  await page.getByText('本地恢复：v3 ·', { exact: false }).waitFor();
  const beforeReload = normalized(await notes());
  await page.reload(); await tool('恢复项目'); await version(3);
  assert.deepEqual(normalized(await notes()), beforeReload);
  await roundtrip();
  flows.push('append, right-click remove-last, single-transaction save, undo/redo, schema 5 restore and export/reopen');

  await tool('选择'); await clickTimeline(page, .5, 1);
  await page.getByLabel('Slide 共享头路径').selectOption('0');
  await tool('删除当前路径'); await version(1);
  note = (await notes())[0];
  assert.deepEqual(note.slide.continuations, [{ command: '>', endPosition: 1 }]);
  assert.equal(note.slide.head, 'star'); assert.deepEqual(note.modifiers, { break: true, ex: true });
  await roundtrip();
  flows.push('promoting a shared-head branch preserves its complete connected route and head modifiers');

  await load('&first=0\n&inote_1=(120){4},,,,,,,,E\n');
  await tool('Slide'); await clickTimeline(page, .5, 1); await clickTimeline(page, 3, 3);
  dialog = page.getByRole('dialog'); await dialog.locator('[data-preview-ready="true"]').waitFor();
  await dialog.getByLabel('连续路线模式').check();
  await dialog.getByRole('button', { name: '直线 -', exact: true }).click();
  await drawLine(1, 5);
  assert.equal(await dialog.getByLabel('连续路线草稿').textContent(), '1-3 · 1 段');
  await dialog.getByRole('status').filter({ hasText: '必须从轨道 3 开始' }).waitFor();
  await drawLine(3, 7);
  assert.equal(await dialog.getByLabel('连续路线草稿').textContent(), '1-3-7 · 2 段');
  await dialog.press('Enter'); await version(1);
  note = (await notes())[0];
  assert.deepEqual(note.slide.continuations, [{ command: '-', endPosition: 7 }]);
  assert.equal(note.endSeconds, 3);
  await tool('撤销 ⌘Z'); await version(2); assert.equal((await notes()).length, 0);
  await tool('重做 ⇧⌘Z'); await version(3); await roundtrip();
  flows.push('new connected placement rejects a disconnected stroke, accepts a continuous stroke, records one transaction and preserves the selected whole-route timing');

  const unsupported = '&first=0\n&inote_1=(120){4}1-3[4:1]-7[4:3],E\n&inote_2=(120){4}1w5-1[4:2],E\n';
  await load(unsupported);
  assert((await current()).charts.every(chart => !chart.editable));
  assert.equal(await exported(), unsupported);
  flows.push('modern multi-bracket and Wi-Fi chaining remain read-only with exact source preservation');
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), flows, errors };
  await writeFile('/tmp/maijdata-slide-connected-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
