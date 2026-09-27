import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline, timelinePoint } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const current = () => page.evaluate(() => window.__shared.responses.findLast(message => message.ok && message.type === 'snapshot').snapshot);
const notes = async () => (await current()).charts.find(chart => chart.difficulty === 1).notes;
const normalized = items => items.map(({ id, order, sourceRange, ...item }) => item);
const flows = [];
let imports = 0;
async function load(source) {
  const name = `shared-${++imports}.txt`;
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
async function number(label, value) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(String(value)); await input.press('Tab');
}
try {
  await page.addInitScript(() => {
    window.__shared = { responses: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/i.test(String(url))) this.addEventListener('message', event => window.__shared.responses.push(event.data));
      }
    };
  });
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const source = '&title=Shared head\n&first=0\n&inote_1=(120){4},1xb-5[4:1]*<7b[0.25##1.5]*w5[240#8:1],,,,,,,,E\n';
  await load(source);
  let all = await notes();
  assert.equal(all.length, 1);
  assert.equal(all[0].slide.additionalPaths.length, 2);
  assert.equal(all[0].isEach, false);
  assert.equal(all[0].isSlideEach, true);
  assert.deepEqual(all[0].slidePaths.map(path => [path.moveStartSeconds, path.endSeconds]), [[1, 1.5], [.75, 2.25], [.75, .875]]);
  assert.equal(all[0].endSeconds, 2.25);
  assert.equal(await exported(), source, 'unchanged shared chart preserves original bytes');
  flows.push('three branches import as one head with independent duration, path Each, and byte preservation');
  await seek(.25);
  const headPoint = await timelinePoint(page, .5, 1);
  const headPixels = await page.locator('.timeline-canvas').evaluate((canvas, point) => {
    const bounds = canvas.getBoundingClientRect();
    const scale = canvas.width / bounds.width;
    const pixels = canvas.getContext('2d').getImageData(Math.round((point.x - bounds.x - 14) * scale),
      Math.round((point.y - bounds.y - 14) * scale), Math.round(28 * scale), Math.round(28 * scale)).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 180 && pixels[i] > pixels[i + 1] * 1.15 && pixels[i + 1] > 30) colored++;
    return colored;
  }, headPoint);
  assert(headPixels > 10, `shared Break head must be drawn on the timeline: ${headPixels}`);
  await page.screenshot({ path: '/tmp/maijdata-slide-shared-head.png' });
  await seek(.85); await page.screenshot({ path: '/tmp/maijdata-slide-shared-moving.png' });
  await seek(1.75); await page.screenshot({ path: '/tmp/maijdata-slide-shared-tail.png' });
  await seek(0);

  await tool('选择'); await clickTimeline(page, .5, 1);
  await page.getByLabel('Slide 共享头路径').selectOption('1');
  await number('Slide 移动秒数', 2); await version(1);
  all = await notes();
  assert.equal(all[0].slide.move.kind, 'beatsAtStartBpm');
  assert.equal(all[0].slide.additionalPaths[0].move.seconds, 2);
  assert.equal(all[0].endSeconds, 2.75);
  await tool('撤销 ⌘Z'); await version(2); assert.equal((await notes())[0].endSeconds, 2.25);
  await tool('重做 ⇧⌘Z'); await version(3);
  await page.getByLabel('Slide 音符头').selectOption('tap'); await version(4);
  await page.getByLabel('Slide 共享头路径').selectOption('0');
  await tool('删除当前路径'); await version(5);
  all = await notes();
  assert.equal(all[0].slide.command, '<'); assert.equal(all[0].slide.head, 'tap');
  assert.deepEqual(all[0].modifiers, { break: true, ex: true });
  assert.equal(all[0].slide.additionalPaths.length, 1);
  await tool('撤销 ⌘Z'); await version(6);
  await number('音符位置', 2); await version(7);
  all = await notes();
  assert.equal(all[0].position, 2);
  assert.deepEqual([all[0].slide.endPosition, ...all[0].slide.additionalPaths.map(path => path.endPosition)], [6, 8, 6]);
  await roundtrip();
  flows.push('branch-specific duration, head change, first-branch deletion, undo/redo, whole-head rotation and export/reopen');

  // Appending through normal placement reuses the existing head and creates one undo entry.
  await tool('Slide');
  await clickTimeline(page, .5, 2); await clickTimeline(page, 2, 6);
  await page.getByRole('dialog').getByRole('button', { name: '直线 -', exact: true }).click();
  await version(1);
  all = await notes(); assert.equal(all.length, 1); assert.equal(all[0].slide.additionalPaths.length, 3);
  assert.equal(all[0].slide.head, 'tap'); assert.deepEqual(all[0].modifiers, { break: true, ex: true });
  await tool('撤销 ⌘Z'); await version(2); assert.equal((await notes())[0].slide.additionalPaths.length, 2);
  await tool('重做 ⇧⌘Z'); await version(3);
  await page.getByText('本地恢复：v3 ·', { exact: false }).waitFor();
  const beforeReload = normalized(await notes());
  await page.reload();
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await version(3);
  assert.deepEqual(normalized(await notes()), beforeReload);
  await roundtrip();
  flows.push('same-hit same-lane append keeps one head, one undo transaction, schema 5 recovery and export/reopen');
  await tool('选择'); await clickTimeline(page, .5, 2); await tool('复制');
  await seek(3); await tool('粘贴至播放头'); await version(1);
  all = await notes(); assert.equal(all.length, 2);
  assert.deepEqual(all[0].slide, all[1].slide);
  assert.equal(all[1].startSeconds, 3);
  assert.equal(all[1].endSeconds - all[0].endSeconds, 2.5);
  await roundtrip();
  flows.push('copy/paste preserves all paths and shifts each branch by the same head offset');


  const unsupported = '&first=0\n&inote_1=(120){4}1-3[4:1]-5[4:3],E\n&inote_2=(120){4}1-5[4:1]*x<7[4:2],E\n';
  await load(unsupported);
  assert((await current()).charts.every(chart => !chart.editable));
  assert.equal(await exported(), unsupported);
  flows.push('connected segments and branch-local head flags remain read-only and preserve bytes');
  assert.deepEqual(errors, []);
  await writeFile('/tmp/maijdata-slide-shared-results.json', JSON.stringify({ browser: browser.version(), flows, errors }, null, 2));
  console.log(JSON.stringify({ flows, errors }, null, 2));
} finally { await browser.close(); }
