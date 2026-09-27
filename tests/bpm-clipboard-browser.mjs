import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { timelinePoint } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
const flows = [];
page.on('pageerror', error => errors.push(error.message));
const source = '&title=BPM clipboard fixture\n&first=0\n&inote_1=(120){4}1,2,(180)3,4,E\n&inote_2=(150){4}5,E\n';
let imports = 0;
const canvas = page.locator('.timeline-canvas');
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const snapshot = () => page.evaluate(() => window.__bpmSnapshots.at(-1));
const chart = async () => (await snapshot()).charts.find(item => item.difficulty === 1);
const beat = value => value.numerator / value.denominator;
const bpms = value => value.bpms.map(event => [beat(event.beat), event.bpm]);
const canonical = value => ({ bpms: value.bpms, endBeat: value.endBeat,
  notes: value.notes.map(({ id, order, sourceRange, ...note }) => note) });
const selected = (notes, events = 0) => page.getByRole('heading', { exact: true,
  name: events ? `选中 ${notes} 个音符和 ${events} 个 BPM 事件` : `选中 ${notes} 个音符` }).waitFor();

async function load(text = source) {
  const name = `bpm-clipboard-${++imports}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}
async function selectBpm(seconds) {
  const point = await timelinePoint(page, seconds, 8);
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 28, point.y - 7);
}
async function clickNote(seconds, lane, shift = false) {
  const point = await timelinePoint(page, seconds, lane);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  if (shift) await page.keyboard.up('Shift');
}
async function menuAction(label) {
  const point = await timelinePoint(page, 1.5, 8);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}
async function pasteAt(seconds) {
  await page.keyboard.press('Control+v');
  const point = await timelinePoint(page, seconds, 8);
  await page.mouse.click(point.x, point.y);
}
async function exportText() {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  return readFile(await (await download).path(), 'utf8');
}

try {
  await page.addInitScript(() => {
    window.__bpmSnapshots = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/i.test(String(url))) this.addEventListener('message', ({ data }) => {
          if (data.ok && data.type === 'snapshot') window.__bpmSnapshots.push(data.snapshot);
        });
      }
    };
  });
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  await load();
  const original = canonical(await chart());
  await selectBpm(1);
  await selected(0, 1);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  const cancelPoint = await timelinePoint(page, 1.5, 8);
  await page.mouse.move(cancelPoint.x, cancelPoint.y);
  await page.screenshot({ path: '/tmp/maijdata-bpm-clipboard-ghost.png' });
  await page.mouse.click(cancelPoint.x, cancelPoint.y, { button: 'right' });
  assert.equal((await snapshot()).version, 0);
  assert.deepEqual(canonical(await chart()), original);
  await pasteAt(2); // BPM 120 for two beats, then 180: 2 seconds is beat 5, after the old E at beat 4.
  await version(1);
  await selected(0, 1);
  const beyondEnd = canonical(await chart());
  assert.deepEqual(bpms(await chart()), [[0, 120], [2, 180], [5, 180]]);
  assert.equal(beat((await chart()).endBeat), 6);
  await page.keyboard.press('Control+z'); await version(2);
  assert.deepEqual(canonical(await chart()), original);
  await page.keyboard.press('Control+Shift+z'); await version(3);
  assert.deepEqual(canonical(await chart()), beyondEnd);
  const exported = await exportText();
  assert(exported.includes('&inote_2=(150){4}5,E\n'));
  await load(exported);
  assert.deepEqual(canonical(await chart()), beyondEnd);
  flows.push('BPM-only preview cancellation, post-E paste, undo/redo, real WASM export/reopen');

  await load();
  await selectBpm(1);
  await clickNote(0.5, 2, true);
  await selected(1, 1);
  await menuAction('剪切'); await version(1);
  assert.deepEqual(bpms(await chart()), [[0, 120]]);
  assert.equal((await chart()).notes.length, 3);
  await page.keyboard.press('Control+z'); await version(2);
  assert.deepEqual(canonical(await chart()), original);
  await pasteAt(2); await version(3);
  await selected(1, 1);
  assert.deepEqual(bpms(await chart()), [[0, 120], [2, 180], [6, 180]]);
  const mixed = canonical(await chart());
  const pasted = (await chart()).notes.find(note => beat(note.beat) === 5);
  assert.equal(pasted.position, 2);
  assert.equal(pasted.startSeconds, 2);
  await page.keyboard.press('Control+z'); await version(4);
  assert.deepEqual(canonical(await chart()), original);
  await page.keyboard.press('Control+Shift+z'); await version(5);
  assert.deepEqual(canonical(await chart()), mixed);
  await load(await exportText());
  assert.deepEqual(canonical(await chart()), mixed);
  flows.push('mixed cut/paste aligns earliest note and BPM, one-step undo/redo, export/reopen');

  await load();
  await selectBpm(0); await selected(0, 1);
  await page.keyboard.press('Delete'); await selected(0);
  assert.equal((await snapshot()).version, 0);
  assert.deepEqual(canonical(await chart()), original);
  await selectBpm(0); await page.keyboard.press('Control+c');
  await pasteAt(1); await version(1);
  assert.deepEqual(bpms(await chart()), [[0, 120], [2, 120]]);
  assert.equal(beat((await chart()).endBeat), 4);
  assert.equal((await chart()).notes.at(-1).startSeconds, 1.5);
  const overwritten = canonical(await chart());
  await load(await exportText());
  assert.deepEqual(canonical(await chart()), overwritten);
  await load();
  await selectBpm(0); await clickNote(0, 1, true); await selected(1, 1);
  await menuAction('剪切'); await version(1);
  assert.deepEqual(bpms(await chart()), [[0, 120], [2, 180]]);
  assert.equal((await chart()).notes.length, 3);
  await page.keyboard.press('Control+z'); await version(2);
  assert.deepEqual(canonical(await chart()), original);
  flows.push('beat-zero delete/cut protection and deterministic same-beat replacement');

  const from = await timelinePoint(page, 1.15, 8);
  const to = await timelinePoint(page, 0.35, 2);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 8, from.y); await page.mouse.down();
  await page.mouse.move(to.x + 18, to.y, { steps: 8 }); await page.mouse.up();
  await selected(2, 1);
  await page.getByLabel('当前难度', { exact: true }).selectOption('2'); await selected(0);
  await page.getByLabel('当前难度', { exact: true }).selectOption('1'); await selected(0);
  await selectBpm(1); await menuAction('全选'); await selected(4);
  await selectBpm(1); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  await load('&inote_1=(120){4}1p4[4:1],E\n'); await selected(0);
  assert.equal((await chart()).editable, false);
  await selectBpm(0); await page.keyboard.press('Delete');
  assert.equal((await snapshot()).version, 0);
  flows.push('mixed box selection, difficulty/import clearing, note-only select-all, readonly protection');
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), flows, errors };
  await writeFile('/tmp/maijdata-bpm-clipboard-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-bpm-clipboard-failure.png' });
  throw error;
} finally { await browser.close(); }
