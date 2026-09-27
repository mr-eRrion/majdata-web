import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { chromium } from '@playwright/test';
import { generateLoad } from '../fixtures/charts/generate-load.mjs';
import { timelinePoint } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  window.__workerSamples = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    #requests = new Map();
    constructor(url, options) {
      super(url, options);
      this.addEventListener('message', ({ data }) => {
        const request = this.#requests.get(data.requestId);
        if (request) {
          window.__workerSamples.push({ type: request.type, ms: performance.now() - request.started, ok: data.ok });
          this.#requests.delete(data.requestId);
        }
      });
    }
    postMessage(message, ...rest) {
      if (message.requestId) this.#requests.set(message.requestId, { type: message.type, started: performance.now() });
      super.postMessage(message, ...rest);
    }
  };
});
page.on('dialog', (dialog) => void dialog.accept());
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const percentile = (items, q) => [...items].sort((a, b) => a - b)[Math.ceil(items.length * q) - 1];
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const noteCount = Number(process.argv[3] ?? 1_000);
  assert([1_000, 10_000].includes(noteCount));
  const mixedSlide = process.argv.includes('--mixed-slide');
  assert(!mixedSlide || noteCount === 1_000, 'The mixed-slide workload is defined for exactly 1000 notes.');
  const workload = generateLoad(noteCount, { mixedSlide });
  for (let index = 0; index < 12; index++) {
    await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: `load-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(workload.text) });
    await page.waitForFunction((count) => window.__workerSamples.filter((sample) => sample.type === 'import').length >= count, index + 1);
    await page.locator('.document-heading .status').filter({ hasText: 'v0 ·' }).waitFor();
    await page.getByRole('button', { name: '打开示例', exact: true }).waitFor({ state: 'visible' });
    console.log(`${noteCount} notes import ${index + 1}/12`);
  }
  await page.locator('.timeline-panel > .panel-title').getByText(`${noteCount.toLocaleString('en-US')} 个音符`, { exact: true }).waitFor();
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  // The first Wi-Fi starts near second 9; five seconds only samples the first straight Slide.
  const frameSampleMs = mixedSlide ? 12_000 : 5_000;
  const frames = await page.evaluate((durationMs) => new Promise((resolve) => {
    const intervals = [];
    let previous;
    const started = performance.now();
    function frame(time) {
      if (previous !== undefined) intervals.push(time - previous);
      previous = time;
      if (time - started >= durationMs) resolve(intervals);
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }), frameSampleMs);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const seeks = [];
  for (const seconds of [240, 30, 180, 0, 120, 299, 100, 60, 200, 1]) {
    seeks.push(await page.evaluate((value) => new Promise((resolve) => {
      const input = document.querySelector('input[aria-label="播放位置"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const started = performance.now();
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
    }), seconds));
  }
  let inputFeedback = null;
  let inputFeedbackNotMeasured;
  if (mixedSlide) {
    inputFeedbackNotMeasured = '未测：含 Slide 的谱面保持只读，未尝试编辑或绕过只读门禁。';
  } else {
    const inputFeedbackSamples = [];
    await page.getByRole('button', { name: 'Tap', exact: true }).click();
    for (let index = 0; index < 10; index++) {
      const point = await timelinePoint(page, 1 + index / 8, 8);
      await page.evaluate(() => {
        window.__inputPaint = new Promise((resolve) => document.querySelector('.timeline-canvas').addEventListener('pointerdown', () => {
          const started = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
        }, { once: true }));
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      inputFeedbackSamples.push(await page.evaluate(() => window.__inputPaint));
      await page.mouse.up();
      await page.locator('.document-heading .status').filter({ hasText: `v${index + 1} ·` }).waitFor();
    }
    inputFeedback = {
      p95Ms: percentile(inputFeedbackSamples, 0.95),
      samples: inputFeedbackSamples.length,
      scope: 'real pointerdown to two animation frames; placement preview, before Worker commit',
    };
  }
  const samples = await page.evaluate(() => window.__workerSamples);
  const imports = samples.filter((sample) => sample.type === 'import').slice(2);
  assert(imports.every((sample) => sample.ok));
  assert.deepEqual(errors, []);
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const metrics = Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map((metric) => [metric.name, metric.value]));
  const report = {
    environment: { browser: browser.version(), mode: 'headless; foreground page; no CPU/network throttling', platform: platform(), arch: arch(), cpu: cpus()[0]?.model, viewport: [1920, 1080], dpr: 1 },
    workload: workload.workload,
    workloadRole: mixedSlide
      ? 'mixed-slide read-only preview observation'
      : noteCount === 1_000 ? 'normal acceptance' : 'stress observation only',
    initializationMs: samples.find((sample) => sample.type === 'initialize')?.ms,
    warmImport: { samples: imports.length, medianMs: percentile(imports.map((sample) => sample.ms), 0.5), p95Ms: percentile(imports.map((sample) => sample.ms), 0.95), scope: 'page postMessage through real WASM parser + TS model + snapshot receipt; file read and React paint excluded' },
    frames: { sampleDurationMs: frameSampleMs, count: frames.length, medianMs: percentile(frames, 0.5), p95Ms: percentile(frames, 0.95), over33_3Fraction: frames.filter((ms) => ms > 33.3).length / frames.length },
    seek: { p95Ms: percentile(seeks, 0.95), scope: 'input dispatch through two animation frames; no loaded media' },
    inputFeedback,
    inputFeedbackNotMeasured,
    mainPageJsHeapUsedBytes: metrics.JSHeapUsedSize,
    memoryLimitations: 'CDP page heap is not total memory; excludes some worker/WASM/GPU/audio allocations. No physical output latency claim.',
    errors,
  };
  const reportPath = mixedSlide
    ? '/tmp/maijdata-performance-1000-slide-results.json'
    : `/tmp/maijdata-performance-${noteCount}-results.json`;
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
