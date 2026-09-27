import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline, clickTouchTimeline, timelinePoint, touchTimelinePoint } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => void dialog.accept());
const version = (n) => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const count = (n) => page.locator('.timeline-panel > .panel-title').getByText(`${n} 个音符`, { exact: true }).waitFor();
async function exportBytes() {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  return readFile(await (await waiting).path());
}
async function select(seconds, lane) {
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await clickTimeline(page, seconds, lane);
  await page.getByLabel('音符位置', { exact: true }).waitFor();
}
async function selectTouch(seconds) {
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await clickTouchTimeline(page, seconds);
  await page.getByLabel('音符位置', { exact: true }).waitFor();
}
async function drag(fromSeconds, fromLane, toSeconds, toLane) {
  await timelinePoint(page, toSeconds, toLane);
  const start = await timelinePoint(page, fromSeconds, fromLane);
  const end = await timelinePoint(page, toSeconds, toLane);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}
async function dragTouch(fromSeconds, toSeconds) {
  const start = await touchTimelinePoint(page, fromSeconds);
  const end = await touchTimelinePoint(page, toSeconds);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'vertical.txt', mimeType: 'text/plain',
    buffer: Buffer.from('&title=Vertical gesture check\n&first=0\n&inote_1=(120){4}1,,(240),,,,,E\n') });
  await version(0);
  await count(1);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  assert.equal(await page.locator('.timeline-canvas').getAttribute('data-lane-order'), '8,7,6,5,4,3,2,1');

  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  await clickTimeline(page, 1.5, 6);
  await count(1); // The first click is transient, even when it is the later endpoint.
  await clickTimeline(page, 0.5, 2);
  await version(1);
  await count(2);
  await select(0.5, 6);
  assert.equal(await page.getByLabel('音符位置', { exact: true }).inputValue(), '6');
  assert.equal(Number(await page.getByLabel('Hold 固定秒数').inputValue()), 1);
  const crossBpm = await exportBytes();
  assert.match(crossBpm.toString(), /6h\[#1\]/, 'cross-BPM endpoints must preserve actual elapsed seconds');

  await page.getByRole('button', { name: 'Touch Hold', exact: true }).click();
  await page.getByLabel('放置 Touch 区域').selectOption('C');
  await clickTouchTimeline(page, 0.25);
  await page.getByRole('button', { name: '选择传感器 C', exact: true }).click();
  const cancel = await touchTimelinePoint(page, 0.75);
  await page.mouse.click(cancel.x, cancel.y, { button: 'right' });
  await clickTouchTimeline(page, 0.25);
  await page.getByRole('button', { name: '选择传感器 C', exact: true }).click();
  await count(2);
  await clickTouchTimeline(page, 0.75);
  await version(2);
  await count(3);
  await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).click();
  await version(3);
  await count(2);
  await page.getByRole('button', { name: '重做 ⇧⌘Z', exact: true }).click();
  await version(4);
  await count(3);
  const edited = await exportBytes();
  assert.match(edited.toString(), /Ch\[4:1\]/);
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'maidata.txt', mimeType: 'text/plain', buffer: edited });
  await version(0);
  await count(3);
  assert.deepEqual(await exportBytes(), edited);
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'drag.txt', mimeType: 'text/plain',
    buffer: Buffer.from('&first=0\n&inote_1=(120){4}1h[240#4:4],B2,E\n') });
  await version(0);
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await drag(0, 1, 0.25, 1);
  await version(1);
  assert.match((await exportBytes()).toString(), /1h\[240#4:4\]/, 'dragging Hold head must preserve explicit BPM duration');
  await selectTouch(0.5);
  assert.equal(await page.getByLabel('音符位置', { exact: true }).inputValue(), '2', 'Touch sensor position stays fixed');
  await dragTouch(0.5, 0.75);
  await version(2);
  const dragged = (await exportBytes()).toString();
  assert(dragged.includes('B2') && !dragged.includes('B6'));
  await page.keyboard.press(',');
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('[aria-label="播放位置"]').value) - 0.125) < 0.002);
  await page.keyboard.press('Backspace');
  await count(2); // Backspace moves the clock; Delete is the deletion key.
  await page.keyboard.press('Control+p');
  assert.equal(await page.getByLabel('播放速度').inputValue(), '2');
  await page.keyboard.press('Control+o');
  assert.equal(await page.getByLabel('播放速度').inputValue(), '1');
  const canvasBounds = await page.locator('.timeline-canvas').boundingBox();
  await page.mouse.move(canvasBounds.x + 100, canvasBounds.y + 100);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('[aria-label="播放位置"]').value) - 0.125) < 0.002);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Shift');
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('[aria-label="播放位置"]').value) - 2.125) < 0.002);

  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'touch-group.txt', mimeType: 'text/plain',
    buffer: Buffer.from('&title=Touch group drag\n&first=0\n&inote_1=(120){4}A1/B8/C/D3h[#0]/E1,E\n') });
  await version(0);
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await clickTouchTimeline(page, 0);
  await page.getByText('选中 5 个音符', { exact: true }).waitFor();
  await dragTouch(0, 0.5);
  await version(1);
  await clickTouchTimeline(page, 0.5);
  await page.getByText('选中 5 个音符', { exact: true }).waitFor();
  const groupText = (await exportBytes()).toString();
  for (const sensor of ['A1', 'B8', 'C', 'D3h', 'E1']) assert(groupText.includes(sensor), `group drag keeps ${sensor}`);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/maijdata-vertical-verified.png', fullPage: true });
  const report = { browser: browser.version(), flows: ['reverse-endpoint-Hold', 'cross-BPM-seconds', 'TouchTrack-then-sensor-picker', 'right-click-cancel', 'undo-redo-export-reopen', 'explicit-BPM-head-drag', 'Touch-time-only-drag', 'same-beat-Touch-group-drag', 'clock-shortcuts-and-wheel'], errors };
  await writeFile('/tmp/maijdata-vertical-results.json', JSON.stringify(report, null, 2));
  console.log(report);
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-vertical-failure.png', fullPage: true });
  throw error;
} finally { await browser.close(); }
