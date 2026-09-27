import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline, clickTouchTimeline } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('dialog', (dialog) => void dialog.accept());
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let currentVersion = 0;
async function version(value = ++currentVersion) {
  await page.locator('.document-heading .status').filter({ hasText: `v${value} ·` }).waitFor({ timeout: 30_000 });
  console.log(`P3 confirmed v${value}`);
}
async function clickNote(seconds, lane) {
  await clickTimeline(page, seconds, lane);
}
async function download() {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  return readFile(await (await waiting).path());
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const original = await readFile(new URL('../fixtures/charts/p3-touch.maidata.txt', import.meta.url));
  const source = Buffer.concat([original, Buffer.from('&lv_3=3\n&inote_3=(120){4}1bx,2hx[#0.25],E\n')]);
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'touch.maidata.txt', mimeType: 'text/plain', buffer: source });
  await version(0);
  await page.locator('.timeline-panel > .panel-title').getByText('7 个音符', { exact: true }).waitFor();
  assert.deepEqual(await download(), source);
  assert(await page.getByLabel('谱面偏移', { exact: true }).isDisabled());
  await page.getByRole('button', { name: 'Touch', exact: true }).click();
  await page.getByLabel('放置 Touch 区域', { exact: true }).selectOption('D');
  await page.getByLabel('放置 Touch 位置', { exact: true }).selectOption('6');
  await clickTouchTimeline(page, 3);
  await page.getByRole('button', { name: '选择传感器 D6', exact: true }).click();
  await version();
  await clickTouchTimeline(page, 3);
  await page.getByRole('button', { name: '选择传感器 D6', exact: true }).click();
  await version(1); // Same sensor and beat is rejected.
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await clickTouchTimeline(page, 3);
  assert.equal(await page.getByLabel('音符 Touch 区域', { exact: true }).inputValue(), 'D');
  for (const [operation, expected] of [['左右镜像', '4'], ['左右镜像', '6'], ['顺转 45°', '7'], ['逆转 45°', '6']]) {
    await page.getByRole('button', { name: operation, exact: true }).click();
    await version();
    assert.equal(await page.getByLabel('音符位置', { exact: true }).inputValue(), expected);
  }
  await page.getByLabel('Break', { exact: true }).click();
  await version();
  assert(await page.getByLabel('Break', { exact: true }).isChecked());
  assert(await page.getByLabel('EX', { exact: true }).isDisabled());
  await page.getByText('BPM 事件（1）', { exact: true }).click();
  await page.getByLabel('BPM 数值 1', { exact: true }).fill('240');
  await page.getByRole('button', { name: '应用 BPM', exact: true }).click();
  await version();
  await clickTouchTimeline(page, 1);
  const selectedTouchGroup = await page.getByText(/^选中 \d+ 个音符$/).textContent();
  assert.notEqual(selectedTouchGroup, '选中 0 个音符', 'Touch rail hit selects its same-beat group');
  await page.getByText('谱面信息', { exact: true }).click();
  const title = '<img src="https://invalid.example/test"> local title';
  await page.getByLabel('谱面标题', { exact: true }).fill(title);
  await page.getByLabel('谱面标题', { exact: true }).press('Tab');
  await version();
  assert.equal(await page.locator('img').count(), 0);
  await page.getByLabel('当前难度', { exact: true }).selectOption('3');
  await page.locator('.timeline-panel > .panel-title').getByText('2 个音符', { exact: true }).waitFor();
  await clickNote(0, 1);
  assert(await page.getByLabel('Break', { exact: true }).isChecked());
  assert(await page.getByLabel('EX', { exact: true }).isChecked());
  await page.getByRole('button', { name: '顺转 45°', exact: true }).click();
  await version();
  await page.getByLabel('当前难度', { exact: true }).selectOption('1');
  await page.locator('.timeline-panel > .panel-title').getByText('8 个音符', { exact: true }).waitFor();
  const edited = await download();
  const text = edited.toString('utf8');
  assert(text.includes(`&title=${title}\n`));
  assert(text.includes('&inote_2=(120){4}D4x,E\n'));
  assert(text.includes('D6b'));
  assert(text.includes('2bx'));
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'reopened.txt', mimeType: 'text/plain', buffer: edited });
  await version(0);
  await page.locator('.timeline-panel > .panel-title').getByText('8 个音符', { exact: true }).waitFor();
  assert.deepEqual(await download(), edited);
  await page.screenshot({ path: '/tmp/maijdata-p3-verified.png' });
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent), flows: ['independent-touch-rail-and-sensor-placement', 'touch-mirror-rotate', 'bpm-duration-expression', 'metadata-as-text', 'multi-difficulty', 'break-ex-ring-notes', 'readonly-touch-ex-preservation', 'export-reopen'], errors };
  await writeFile('/tmp/maijdata-p3-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-p3-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 5000));
  throw error;
} finally { await browser.close(); }
