import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => void dialog.accept());
const status = page.locator('.document-heading .status');
async function version(value) {
  await status.filter({ hasText: `v${value} ·` }).waitFor({ timeout: 30_000 });
  console.log(`confirmed v${value}`);
}
async function count(value) {
  await page.locator('.timeline-panel > .panel-title').getByText(`${value} 个音符`, { exact: true }).waitFor();
}
async function clickNote(seconds, lane) { await clickTimeline(page, seconds, lane); }
async function downloadedBytes() {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  const download = await waiting;
  return readFile(await download.path());
}

try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/');
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await version(0);
  await count(5);
  const original = await readFile(new URL('../fixtures/charts/baseline.maidata.txt', import.meta.url));
  assert.deepEqual(await downloadedBytes(), original, 'untouched export must preserve original bytes');
  await page.screenshot({ path: '/tmp/maijdata-editor-baseline.png', fullPage: true });

  await page.getByRole('button', { name: 'Tap', exact: true }).click();
  await clickNote(1.75, 6);
  await version(1);
  await count(6);
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await clickNote(1.75, 6);
  const position = page.getByLabel('音符位置', { exact: true });
  await position.waitFor();
  assert.equal(await position.inputValue(), '6');
  await position.fill('7');
  await position.press('Tab');
  await version(2);
  await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).click();
  await version(3);
  assert.equal(await position.inputValue(), '6');
  await page.getByRole('button', { name: '重做 ⇧⌘Z', exact: true }).click();
  await version(4);
  assert.equal(await position.inputValue(), '7');

  await page.getByRole('button', { name: '复制', exact: true }).click();
  await clickNote(3, 8);
  await page.getByRole('button', { name: '粘贴至播放头', exact: true }).click();
  await version(5);
  await count(7);
  await clickNote(3, 7);
  await page.getByRole('button', { name: '删除选中音符', exact: true }).click();
  await version(6);
  await count(6);
  await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).click();
  await version(7);
  await count(7);

  const edited = await downloadedBytes();
  const text = edited.toString('utf8');
  assert(text.includes('&custom=preserve this unknown metadata exactly\n'));
  assert.equal(text.slice(text.indexOf('&lv_2=')), original.toString('utf8').slice(original.toString('utf8').indexOf('&lv_2=')));
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'maidata.txt', mimeType: 'text/plain', buffer: edited });
  await version(0);
  await count(7);
  await page.getByLabel('当前难度', { exact: true }).selectOption('2');
  await page.getByText('此难度只读，导出时保留原文。请查看下方诊断。', { exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Tap', exact: true }).isDisabled());
  await page.getByLabel('当前难度', { exact: true }).selectOption('1');
  await page.getByText(/本地恢复：v0 ·/).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await version(0);
  await count(7);
  await page.getByText('已恢复的谱面 · 请重新选择歌曲', { exact: true }).waitFor();
  assert.deepEqual(await downloadedBytes(), edited, 'restored document must export the same candidate');
  assert.deepEqual(errors, [], 'browser page errors');
  await page.screenshot({ path: '/tmp/maijdata-editor-verified.png', fullPage: true });
  const report = { browser: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent), flows: ['untouched-byte-export', 'edit-copy-undo-export-reopen', 'readonly-preservation', 'indexeddb-reload-restore'], errors };
  await writeFile('/tmp/maijdata-editor-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-editor-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 6000));
  throw error;
} finally { await browser.close(); }
