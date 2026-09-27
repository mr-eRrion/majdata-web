import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { timelinePoint, clickTimeline } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => void dialog.accept());
let imports = 0;
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const count = n => page.locator('.timeline-panel > .panel-title').getByText(`${n} 个音符`, { exact: true }).waitFor();
const tool = name => page.getByRole('button', { name, exact: true }).click();
const clock = () => page.locator('.transport output').textContent().then(Number.parseFloat);
async function load(text = '&first=0\n&inote_1=(120){4},,,,,,,,E\n') {
  const name = `fast-${++imports}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}
async function hover(seconds, lane) {
  const point = await timelinePoint(page, seconds, lane);
  await page.mouse.move(point.x, point.y);
}
async function cursor(lane, beat) {
  await page.waitForFunction(({ lane, beat }) => {
    const data = document.querySelector('.timeline-canvas').dataset;
    return Number(data.fastLane) === lane && Math.abs(Number(data.fastBeat) - beat) < 1e-7;
  }, { lane, beat });
}
async function exported() {
  const waiting = page.waitForEvent('download');
  await tool('导出 maidata.txt');
  return readFile(await (await waiting).path());
}
async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, seconds) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(seconds));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction(value => Math.abs(parseFloat(document.querySelector('.transport output').textContent) - value) < .002, seconds);
}
function wav(seconds = 1) {
  const rate = 8000, bytes = seconds * rate * 2;
  const output = Buffer.alloc(44 + bytes);
  output.write('RIFF'); output.writeUInt32LE(36 + bytes, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(rate, 24); output.writeUInt32LE(rate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(bytes, 40);
  return output;
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  await load(); await tool('Tap'); await hover(.5, 3);
  await page.keyboard.press('ArrowRight'); await version(1); await count(1); await cursor(2, 1.25);
  assert(Math.abs(await clock() - .125) < .002, 'advance is relative to the clock, not an absolute seek to the hovered beat');
  await page.keyboard.press('ArrowRight'); await version(2); await cursor(1, 1.5);
  await page.keyboard.press('ArrowRight'); await version(3); await cursor(8, 1.75);
  const stepped = await exported();
  assert.match(stepped.toString().replace(/\{[^}]+\}/g, ''), /3,2,1,/);
  await tool('撤销 ⌘Z'); await count(2); await version(4);
  await tool('重做 ⇧⌘Z'); await count(3); await version(5);
  await load(stepped.toString()); await count(3); assert.deepEqual(await exported(), stepped);

  await load(); await tool('Tap'); await hover(0, 8);
  const start = Date.now();
  await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('.document-heading .status').textContent.includes('v3 ·'));
  await page.keyboard.up('ArrowLeft');
  const elapsed = Date.now() - start;
  assert(elapsed >= 370, `three attempts must not burst before 0.4s (${elapsed}ms)`);
  await count(3); await cursor(3, .75);
  await page.waitForTimeout(300); await version(3); await count(3);
  const held = await exported(); assert.match(held.toString().replace(/\{[^}]+\}/g, ''), /8,1,2,/);

  await load(); await tool('Hold'); await hover(0, 2);
  await page.keyboard.press('ArrowLeft'); await version(1); await count(1);
  const short = await exported(); assert.match(short.toString(), /2h[,/\n]/);
  await tool('选择'); await clickTimeline(page, 0, 2);
  assert.equal(Number(await page.getByLabel('Hold 固定秒数', { exact: true }).inputValue()), 0);
  await tool('撤销 ⌘Z'); await count(0);

  await load('&first=0\n&inote_1=(120){4}1,,,,E\n'); await tool('Tap'); await hover(0, 1);
  await page.keyboard.press('ArrowRight'); await cursor(8, .25);
  assert(Math.abs(await clock() - .125) < .002);
  await exported(); await count(1); await version(0);

  await load('&first=0\n&inote_1=(120){16},,,(240),,,,,E\n'); await tool('Tap'); await hover(.25, 3);
  await page.keyboard.press('ArrowRight'); await version(1); await cursor(2, .75);
  assert(Math.abs(await clock() - .125) < .002);
  await page.keyboard.press('ArrowRight'); await cursor(1, 1);
  assert(Math.abs(await clock() - .1875) < .002, 'the next step uses the BPM at the hovered beat');
  await version(2);

  await load(); await tool('Hold'); await clickTimeline(page, 0, 1); await hover(.5, 2);
  await page.keyboard.press('ArrowRight'); await exported(); await count(0); await version(0);
  const cancel = await timelinePoint(page, .5, 2);
  await page.mouse.click(cancel.x, cancel.y, { button: 'right' });
  await exported(); await hover(.5, 2);
  await page.keyboard.press('ArrowRight'); await count(1); await version(1);
  await load(); await tool('Tap');
  await page.getByLabel('谱面偏移', { exact: true }).focus(); await hover(.5, 2);
  await page.keyboard.press('ArrowRight'); await count(0); await version(0);
  await page.getByLabel('谱面偏移', { exact: true }).blur();
  await tool('选择'); await hover(.5, 2); await page.keyboard.press('ArrowRight');
  await count(0); await version(0);
  await tool('Tap'); await page.mouse.move(5, 5); await page.keyboard.press('ArrowRight');
  await count(0); await version(0);
  await hover(0, 3); await page.keyboard.down('ArrowRight'); await version(1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(450); await page.keyboard.up('ArrowRight');
  await count(1); await version(1);

  await load(); await tool('Tap'); await tool('播放');
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await hover(1, 5); await page.keyboard.press('ArrowRight'); await version(1); await count(1);
  await page.getByRole('button', { name: '播放', exact: true }).waitFor();
  const pausedAfterAdd = await clock();
  await page.waitForTimeout(100); assert(Math.abs(await clock() - pausedAfterAdd) < .002);

  await load('&first=0\n&inote_1=(120){16}1,1,1,1,1,1,1,1,E\n'); await tool('Tap'); await tool('播放');
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await hover(.5, 1); await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await page.waitForTimeout(100); await version(0); await count(8);
  await tool('暂停');

  await load(); await tool('Tap');
  await page.getByLabel('歌曲文件', { exact: true }).setInputFiles({ name: 'one-second.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.locator('.song-info strong').getByText('one-second.wav', { exact: true }).waitFor();
  await seek(.99); await hover(1, 3);
  await page.keyboard.press('ArrowRight'); await version(1); await cursor(2, 2);
  assert(Math.abs(await clock() - 1) < .002, 'song endpoint clamps the clock while the lane advances');
  await page.keyboard.press('ArrowRight'); await version(2); await cursor(1, 2);
  assert(Math.abs(await clock() - 1) < .002);
  await page.screenshot({ path: '/tmp/maijdata-fast-placement.png', fullPage: true });
  await load('&first=0\n&inote_1=(120){4}1-5[4:1],E\n');
  await hover(.5, 2); await page.keyboard.press('ArrowRight'); await exported(); await version(0); await count(1);
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), heldThreeStepsMs: elapsed, pausedAfterAdd,
    flows: ['place-before-lane-step', 'display-order-wrap', 'relative-hover-clock', 'held-repeat-200ms', 'zero-Hold',
      'duplicate-no-history-but-step', 'cross-BPM-step', 'pending-Hold-gate', 'form-select-outside-gates', 'blur-stops-repeat',
      'playing-add-pauses', 'playing-duplicate-keeps-playing', 'song-end-clamp', 'readonly-gate', 'undo-redo-export-reopen'], errors };
  await writeFile('/tmp/maijdata-fast-placement.json', JSON.stringify(report, null, 2));
  console.log(report);
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-fast-placement-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 3500));
  console.error(await page.locator('.timeline-canvas').evaluate(el => ({...el.dataset}))); 
  throw error;
} finally { await browser.close(); }
