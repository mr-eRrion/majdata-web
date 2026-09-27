import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(() => {
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes('chart.worker')) window.__chartWorker = this;
    }
    postMessage(message, ...rest) {
      if (window.__rejectExport && message.type === 'export') {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: {
          requestId: message.requestId, generation: message.generation, ok: false, error: '验收注入：候选校验失败',
        } })));
      } else super.postMessage(message, ...rest);
    }
  };
  Object.defineProperty(window.indexedDB, 'open', { value() { throw new DOMException('验收注入：存储不可用', 'SecurityError'); } });
});
page.on('dialog', (dialog) => void dialog.accept());
const status = page.locator('.document-heading .status');
async function version(value) { await status.filter({ hasText: `v${value} ·` }).waitFor({ timeout: 30_000 }); }
async function download() {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  return readFile(await (await event).path());
}
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  await page.getByText(/本地恢复不可用：/).waitFor();
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await version(0);
  await page.getByRole('button', { name: 'Tap', exact: true }).click();
  await clickTimeline(page, 2, 1);
  await version(1);
  assert.match(await status.textContent(), /尚未导出/);
  await page.evaluate(() => { window.__rejectExport = true; });
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  await page.getByText('验收注入：候选校验失败', { exact: true }).waitFor();
  assert.match(await status.textContent(), /尚未导出/);
  await page.evaluate(() => { window.__rejectExport = false; });
  const candidate = await download();
  assert(candidate.includes(Buffer.from('&custom=preserve')));
  await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).click();
  await version(2);
  // A successful queued export is also a barrier behind checkpoint capture.
  await download();
  await page.evaluate(() => window.__chartWorker.onerror(new ErrorEvent('error', { message: '验收注入：Worker 已退出' })));
  const restore = page.getByRole('button', { name: '恢复内存检查点 v2', exact: true });
  await restore.waitFor();
  assert(await page.getByRole('button', { name: 'Tap', exact: true }).isDisabled());
  await restore.click();
  await version(2);
  const original = await readFile(new URL('../fixtures/charts/baseline.maidata.txt', import.meta.url));
  assert.deepEqual(await download(), original);
  await page.getByLabel('歌曲文件', { exact: true }).setInputFiles({ name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') });
  await page.getByRole('alert').waitFor();
  assert.deepEqual(await download(), original, 'bad audio must not damage the chart');
  console.log(JSON.stringify({ browser: browser.version(), flows: ['storage-disabled-export', 'export-rejection-keeps-dirty', 'worker-failure-explicit-checkpoint', 'invalid-media-keeps-chart'] }, null, 2));
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(0, 4500));
  throw error;
} finally { await browser.close(); }
