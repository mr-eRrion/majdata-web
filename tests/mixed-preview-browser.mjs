import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const fixture = await readFile(new URL('../fixtures/charts/mixed-preview.maidata.txt', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', (dialog) => void dialog.accept());
const clock = () => page.locator('.transport output').textContent().then(Number.parseFloat);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, seconds) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(seconds));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction((value) => Math.abs(Number.parseFloat(document.querySelector('.transport output').textContent) - value) < 0.002, seconds);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const offsets = [];
  const previews = [];
  for (const offset of [0.25, -0.25]) {
    const filename = `mixed-preview-${offset}.txt`;
    await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/plain',
      buffer: Buffer.from(fixture.replace('&first=0.25', `&first=${offset}`)) });
    await page.locator('.document-heading').getByText(filename, { exact: true }).waitFor();
    await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
    await page.locator('.timeline-panel > .panel-title').getByText('12 个音符', { exact: true }).waitFor();
    const diagnostics = await page.locator('.diagnostic').allTextContents();
    assert(diagnostics.length > 0 && diagnostics.every((text) => text.includes('slide-validation-pending')), diagnostics.join('\n'));
    assert(await page.getByRole('button', { name: 'Tap', exact: true }).isEnabled(), 'supported mixed Slide chart must allow Tap editing');
    assert(await page.getByRole('button', { name: 'Slide', exact: true }).isEnabled(), 'supported mixed Slide chart must allow Slide editing');
    for (const seconds of [1.8, 2.25, 2.75, 3.25, 4.25, 2.75]) {
      await seek(seconds);
      const png = await page.locator('.circular-preview-panel canvas').screenshot();
      const box = await page.locator('.circular-preview-panel canvas').boundingBox();
      // The panel's 8px CSS corner mask can differ by one compositor color level.
      // Compare the full inner drawing area exactly; keep uncropped screenshots for review.
      const drawing = await page.screenshot({ clip: { x: Math.ceil(box.x) + 8, y: Math.ceil(box.y) + 8,
        width: Math.floor(box.width) - 16, height: Math.floor(box.height) - 16 } });
      const item = { offset, seconds, sha256: hash(drawing), canvas: await page.locator('.circular-preview-panel canvas')
        .evaluate(node => ({ width: node.width, height: node.height })) };
      previews.push(item);
      if (offset > 0) await writeFile(`/tmp/maijdata-mixed-preview-${seconds}.png`, png);
      else await writeFile(`/tmp/maijdata-mixed-preview-negative-${seconds}.png`, png);
      if (offset > 0 && seconds === 2.75)
        await page.screenshot({ path: '/tmp/maijdata-mixed-workspace.png', fullPage: true });
    }
    offsets.push({ offset, diagnostics, editable: true });
  }
  const first = previews.slice(0, 6);
  const second = previews.slice(6);
  await writeFile('/tmp/maijdata-mixed-preview-frames.json', JSON.stringify(previews, null, 2));
  assert.equal(first[2].sha256, first[5].sha256, 'backward seek must reproduce the same mixed frame');
  assert.deepEqual(first.map((item) => item.sha256), second.map((item) => item.sha256), 'first offset must not shift chart-coordinate rendering');
  assert(new Set(first.map((item) => item.sha256)).size >= 4, 'mixed states should visibly change');

  const rates = [];
  for (const rate of [0.5, 1, 2]) {
    await seek(2);
    await page.getByLabel('播放速度', { exact: true }).selectOption(String(rate));
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => Number.parseFloat(document.querySelector('.transport output').textContent) > 2.05,
      undefined, { timeout: 5000 });
    const start = await clock();
    const started = Date.now();
    await page.waitForTimeout(800);
    const end = await clock();
    const elapsed = (Date.now() - started) / 1000;
    assert(Math.abs(end - start - rate * elapsed) < 0.15,
      `playback rate ${rate}: start=${start}, end=${end}, elapsed=${elapsed}`);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    const paused = await clock();
    await page.waitForTimeout(100);
    assert(Math.abs(await clock() - paused) < 0.002, 'pause must freeze the chart clock');
    rates.push({ rate, elapsed, chartDelta: end - start });
  }
  await seek(2.25);
  await page.locator('.timeline-panel h2').click();
  await page.keyboard.down('Tab');
  await page.waitForTimeout(250);
  assert(await clock() > 2.4, 'held Tab must preview from the saved chart time');
  await page.keyboard.up('Tab');
  await page.getByRole('button', { name: '播放', exact: true }).waitFor();
  const tabPreviewRestoredSeconds = await clock();
  assert(Math.abs(tabPreviewRestoredSeconds - 2.25) < 0.002, 'released Tab must restore the saved chart time');
  await page.getByLabel('播放速度', { exact: true }).selectOption('2');
  await page.getByLabel('循环起点', { exact: true }).fill('2');
  await page.getByLabel('循环终点', { exact: true }).fill('3');
  await page.getByLabel('循环', { exact: true }).check();
  await seek(2.8);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const loopTimes = [];
  for (let sample = 0; sample < 8; sample++) {
    await page.waitForTimeout(100);
    loopTimes.push(await clock());
  }
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  assert(loopTimes.every((seconds) => seconds >= 2 && seconds < 3));
  assert(loopTimes.some((seconds, index) => index > 0 && seconds < loopTimes[index - 1]), 'loop must wrap');
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), viewport: [1920, 1080], fixture: 'mixed-preview.maidata.txt', offsets,
    previews, rates, tabPreviewRestoredSeconds, loopTimes, errors,
    frameComparison: 'Exact PNG hash of the drawing area excluding the 8px CSS panel corner mask; uncropped frames saved separately.',
    limitations: 'Production Web state/clock checks with synthesized cues and no loaded song. No native pixel, physical audio, or target-runtime Slide compatibility claim.' };
  await writeFile('/tmp/maijdata-mixed-preview-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'pass', offsets: offsets.map((item) => item.offset), rates, loopTimes, errors }));
} finally { await browser.close(); }
