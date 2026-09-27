import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173/';
const fixtureBytes = await readFile(new URL('../fixtures/charts/slide-model.maidata.txt', import.meta.url));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('dialog', (dialog) => void dialog.accept());
const status = page.locator('.document-heading .status');
const version = (value) => status.filter({ hasText: `v${value} ·` }).waitFor({ timeout: 30_000 });
const noteCount = (value) => page.locator('.timeline-panel > .panel-title').getByText(`${value} 个音符`, { exact: true }).waitFor();

async function bridgeCount(list) {
  return page.evaluate((key) => window.__slideTestBridge[key].length, list);
}

async function snapshotAfter(responseOffset) {
  await page.waitForFunction((offset) => window.__slideTestBridge.responses.slice(offset)
    .some((message) => message?.ok && message.type === 'snapshot'), responseOffset, { timeout: 60_000 });
  return page.evaluate((offset) => [...window.__slideTestBridge.responses].slice(offset).reverse()
    .find((message) => message?.ok && message.type === 'snapshot')?.snapshot, responseOffset);
}

async function currentSnapshot() {
  return page.evaluate(() => [...window.__slideTestBridge.responses].reverse()
    .find((message) => message?.ok && message.type === 'snapshot')?.snapshot);
}

async function timelinePatchSignal(position, chartSeconds) {
  return page.locator('.timeline-canvas').evaluate((canvas, target) => {
    const data = canvas.dataset;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('timeline Canvas context is unavailable');
    const order = data.laneOrder.split(',').map(Number);
    const centers = data.laneCenters.split(',').map(Number);
    const centerX = centers[order.indexOf(target.position)];
    const controlX = centers[order.indexOf(target.position === 2 ? 3 : 2)];
    const viewSeconds = Number(data.viewSeconds);
    const pixelsPerSecond = Number(data.pixelsPerSecond);
    const playheadY = Number(data.playheadY);
    const y = playheadY - (target.chartSeconds - viewSeconds) * pixelsPerSecond;
    const ratioX = canvas.width / canvas.getBoundingClientRect().width;
    const ratioY = canvas.height / canvas.getBoundingClientRect().height;

    function uniqueColors(x, cssY) {
      const radius = 18;
      const left = Math.max(0, Math.floor((x - radius) * ratioX));
      const top = Math.max(0, Math.floor((cssY - radius) * ratioY));
      const right = Math.min(canvas.width, Math.ceil((x + radius) * ratioX));
      const bottom = Math.min(canvas.height, Math.ceil((cssY + radius) * ratioY));
      const pixels = context.getImageData(left, top, right - left, bottom - top).data;
      const colors = new Set();
      for (let index = 0; index < pixels.length; index += 4)
        colors.add((pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2]);
      return colors.size;
    }

    const slideColors = uniqueColors(centerX, y);
    const controlColors = uniqueColors(controlX, y);
    return { y, viewSeconds, slideColors, controlColors, difference: slideColors - controlColors };
  }, { position, chartSeconds });
}

async function waitForTimelinePatch(position, chartSeconds, predicate) {
  const deadline = Date.now() + 15_000;
  let signal;
  do {
    signal = await timelinePatchSignal(position, chartSeconds);
    if (predicate(signal)) return signal;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  assert.fail(`Slide timeline pixels did not reach the expected position: ${JSON.stringify(signal)}`);
}

async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction((value) => Math.abs(Number.parseFloat(document.querySelector('.transport output').textContent) - value) < 0.002, seconds);
}

function chart(snapshot, difficulty) {
  const value = snapshot.charts.find((item) => item.difficulty === difficulty);
  assert(value, `missing difficulty ${difficulty}`);
  return value;
}

function slides(snapshot, difficulty) {
  return chart(snapshot, difficulty).notes.filter((note) => note.kind === 'slide');
}

function slideSummary(snapshot) {
  return snapshot.charts.map((item) => ({
    difficulty: item.difficulty,
    editable: item.editable,
    diagnostics: item.diagnostics.map(({ code }) => code),
    slides: item.notes.filter((note) => note.kind === 'slide').map((note) => ({
      beat: note.beat,
      position: note.position,
      modifiers: note.modifiers,
      bpm: note.bpm,
      startSeconds: note.startSeconds,
      moveStartSeconds: note.moveStartSeconds,
      endSeconds: note.endSeconds,
      slide: note.slide,
    })),
  }));
}

function seconds(duration, sourceBpm) {
  switch (duration.kind) {
    case 'seconds': return duration.seconds;
    case 'beatsAtStartBpm': return duration.beats * 4 / duration.division * 60 / sourceBpm;
    case 'beatsAtBpm': return duration.beats * 4 / duration.division * 60 / duration.bpm;
    default: assert.fail(`unexpected Slide duration kind ${duration.kind}`);
  }
}

function near(actual, expected, label) {
  assert(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);
}

function rawFieldLine(bytes, difficulty) {
  const prefix = Buffer.from(`&inote_${difficulty}=`);
  const start = bytes.indexOf(prefix);
  assert(start >= 0, `missing &inote_${difficulty} source field`);
  const newline = bytes.indexOf(0x0a, start);
  return bytes.subarray(start, newline < 0 ? bytes.length : newline + 1);
}

async function uploadChart(name, bytes) {
  const responseOffset = await bridgeCount('responses');
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
  await version(0);
  const snapshot = await snapshotAfter(responseOffset);
  assert.equal(snapshot.version, 0);
  return snapshot;
}

async function exportBytes() {
  const responseOffset = await bridgeCount('responses');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  const download = await downloadEvent;
  const bytes = await readFile(await download.path());
  await page.waitForFunction((offset) => window.__slideTestBridge.responses.slice(offset)
    .some((message) => message?.ok && message.type === 'export'), responseOffset, { timeout: 30_000 });
  const workerExport = await page.evaluate((offset) => {
    const result = [...window.__slideTestBridge.responses].slice(offset).reverse()
      .find((message) => message?.ok && message.type === 'export')?.result;
    return result && { generation: result.generation, version: result.version, text: result.text, bytes: Array.from(result.bytes) };
  }, responseOffset);
  assert(workerExport, 'chart Worker export response was not observed');
  assert.deepEqual(bytes, Buffer.from(workerExport.bytes), 'download must contain the actual Worker export bytes');
  return { bytes, workerExport };
}

function assertSlideEditability(snapshot) {
  assert.equal(chart(snapshot, 1).editable, true, 'supported -<>w Slide difficulty must be editable');
  assert(chart(snapshot, 1).diagnostics.some(({ code }) => code === 'slide-validation-pending'),
    'supported Slide keeps the native-validation warning without making the chart read-only');
  for (const difficulty of [2, 4]) {
    const unsupported = chart(snapshot, difficulty);
    assert.equal(unsupported.editable, false, `unsupported Slide difficulty ${difficulty} must remain read-only`);
    assert(unsupported.diagnostics.length > 0, `unsupported difficulty ${difficulty} needs a diagnostic`);
    assert.equal(slides(snapshot, difficulty).length, 0, `unsupported difficulty ${difficulty} must not become a base Slide`);
  }
  assert.equal(chart(snapshot, 3).editable, true, 'supported shared-head Slide is editable');
  assert.equal(slides(snapshot, 3).length, 1);
  assert.equal(slides(snapshot, 3)[0].slide.additionalPaths.length, 1);
  assert.equal(chart(snapshot, 5).editable, true, 'ordinary difficulty must remain editable beside Slide difficulties');
}

function assertSupportedSlideModel(snapshot) {
  const supported = chart(snapshot, 1);
  const notes = slides(snapshot, 1);
  assert.equal(notes.length, 10);
  assert.deepEqual(new Set(notes.map((note) => note.slide.command)), new Set(['-', '<', '>', 'w']));
  assert(notes.every((note) => note.slide && note.slide.endPosition >= 1 && note.slide.endPosition <= 8));

  const atBeat = (numerator) => notes.find((note) => note.beat.numerator === numerator && note.beat.denominator === 1);
  const defaultSlide = atBeat(0);
  assert.equal(defaultSlide.slide.command, '-');
  assert.equal(defaultSlide.slide.head, 'star');
  assert.equal(defaultSlide.position, 1);
  assert.equal(defaultSlide.slide.endPosition, 5);
  near(defaultSlide.bpm, 120, 'default Slide start BPM');
  near(defaultSlide.startSeconds, 0, 'default Slide hit');
  const defaultWait = seconds(defaultSlide.slide.wait, defaultSlide.bpm);
  const defaultMove = seconds(defaultSlide.slide.move, defaultSlide.bpm);
  near(defaultWait, 0.5, 'BPM 120 default wait');
  near(defaultMove, 1, 'BPM 120 [4:2] movement');
  near(defaultSlide.moveStartSeconds, 0.5, 'default movement start');
  near(defaultSlide.endSeconds, 1.5, 'default movement end across a BPM change');

  const fixedWaitRatio = atBeat(1);
  assert.equal(fixedWaitRatio.slide.command, '<');
  assert.equal(fixedWaitRatio.slide.endPosition, 1);
  near(fixedWaitRatio.bpm, 120, 'fixed-wait ratio source BPM');
  near(seconds(fixedWaitRatio.slide.wait, fixedWaitRatio.bpm), 0.25, 'fixed wait');
  near(seconds(fixedWaitRatio.slide.move, fixedWaitRatio.bpm), 0.25, 'fixed-wait ratio movement at source BPM 120');
  near(fixedWaitRatio.moveStartSeconds, 0.75, 'fixed-wait ratio movement start');
  near(fixedWaitRatio.endSeconds, 1, 'fixed-wait ratio movement end');

  const bpmOverride = atBeat(2);
  assert.equal(bpmOverride.slide.command, '<');
  assert.equal(bpmOverride.slide.endPosition, 6);
  near(bpmOverride.bpm, 240, 'explicit Slide BPM at onset');
  near(seconds(bpmOverride.slide.wait, bpmOverride.bpm), 0.25, 'explicit BPM wait');
  near(seconds(bpmOverride.slide.move, bpmOverride.bpm), 0.125, '[240#8:1] movement');
  near(bpmOverride.moveStartSeconds, 1.25, 'explicit BPM movement start');
  near(bpmOverride.endSeconds, 1.375, 'explicit BPM movement end');

  const explicitFixedMove = atBeat(3);
  assert.equal(explicitFixedMove.slide.command, '>');
  assert.equal(explicitFixedMove.slide.endPosition, 7);
  near(seconds(explicitFixedMove.slide.wait, explicitFixedMove.bpm), 0.25, 'explicit BPM fixed-move wait');
  near(seconds(explicitFixedMove.slide.move, explicitFixedMove.bpm), 0.5, 'explicit BPM fixed movement');
  near(explicitFixedMove.endSeconds, 2, 'explicit BPM fixed movement end');

  const fixedMove = atBeat(4);
  assert.equal(fixedMove.slide.command, 'w');
  assert.equal(fixedMove.slide.endPosition, 8);
  near(seconds(fixedMove.slide.wait, fixedMove.bpm), 0.25, 'fixed-wait fixed-move wait');
  near(seconds(fixedMove.slide.move, fixedMove.bpm), 0.5, 'fixed movement seconds');

  const headBreak = atBeat(5);
  assert.equal(headBreak.modifiers.break, true);
  assert.equal(headBreak.slide.head, 'star');
  const slideBreak = atBeat(6);
  assert.equal(slideBreak.slide.slideBreak, true);
  assert.equal(slideBreak.modifiers.break, false, 'destination Slide Break must remain distinct from a Break head');
  assert.equal(atBeat(7).modifiers.ex, true, 'EX head flag must survive parsing');
  assert.equal(atBeat(8).slide.head, 'tap', 'tap-head flag must survive parsing');
  assert.equal(atBeat(9).slide.head, 'none', 'no-head flag must survive parsing');

  const tempoChange = supported.bpms.find((event) => event.bpm === 240);
  assert(tempoChange, 'fixture must contain a mid-movement BPM change');
  const tempoBeat = tempoChange.beat.numerator / tempoChange.beat.denominator;
  const tempoSeconds = tempoBeat * 60 / 120;
  assert(tempoSeconds > defaultSlide.moveStartSeconds && tempoSeconds < defaultSlide.endSeconds,
    'the 240 BPM event must occur during the default BPM 120 movement');
}

try {
  await page.addInitScript(() => {
    const bridge = { workerCount: 0, requests: [], responses: [] };
    Object.defineProperty(window, '__slideTestBridge', { value: bridge });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(scriptURL, options) {
        super(scriptURL, options);
        this.isChartWorker = /chart\.worker/i.test(String(scriptURL));
        if (this.isChartWorker) {
          bridge.workerCount += 1;
          this.addEventListener('message', ({ data }) => bridge.responses.push(data));
        }
      }
      postMessage(message, ...transfer) {
        if (this.isChartWorker && message && typeof message.type === 'string')
          bridge.requests.push({ type: message.type, baseVersion: message.baseVersion, generation: message.generation });
        return super.postMessage(message, ...transfer);
      }
    };
  });

  await page.goto(baseUrl);
  await page.waitForFunction(() => window.__slideTestBridge.workerCount > 0);
  const initial = await uploadChart('slide-model.maidata.txt', fixtureBytes);
  assertSlideEditability(initial);
  assertSupportedSlideModel(initial);
  await noteCount(10);
  const timelineSlide = slides(initial, 1).find((note) => note.startSeconds === 0 && note.position === 1 && note.slide.head === 'star');
  assert(timelineSlide, 'fixture must have a Star-headed Slide at ring lane 1 and chart time 0');
  const timeline = page.locator('.timeline-canvas');
  await page.waitForFunction(() => Boolean(document.querySelector('.timeline-canvas')?.dataset.laneCenters));
  const initialSlidePixels = await waitForTimelinePatch(timelineSlide.position, timelineSlide.startSeconds,
    ({ difference }) => difference > 8);
  assert(initialSlidePixels.difference > 8, 'Slide PNG head must render in its chart-time and ring-lane region');
  await seek(0.25);
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('.timeline-canvas')?.dataset.viewSeconds) - 0.25) < 0.01);
  const soughtSlidePixels = await waitForTimelinePatch(timelineSlide.position, timelineSlide.startSeconds,
    ({ difference }) => difference > 8);
  assert(soughtSlidePixels.difference > 8, 'Slide PNG head must move with its chart-time location after seeking');
  const formerHeadPixels = await timelinePatchSignal(timelineSlide.position, 0.25);
  assert(formerHeadPixels.difference < 8, 'Slide PNG head must leave the old playhead location after seeking');
  await seek(0);
  await page.waitForFunction(() => Math.abs(Number(document.querySelector('.timeline-canvas')?.dataset.viewSeconds)) < 0.01);
  await page.waitForFunction(() => window.__slideTestBridge.responses.some((message) =>
    message?.ok && message.type === 'checkpoint' && message.checkpoint?.schemaVersion === 5), null, { timeout: 30_000 });
  const checkpointSchemaVersion = await page.evaluate(() => [...window.__slideTestBridge.responses].reverse()
    .find((message) => message?.ok && message.type === 'checkpoint')?.checkpoint?.schemaVersion);
  assert.equal(checkpointSchemaVersion, 4, 'Slide checkpoint must use schema version 4');
  await page.getByLabel('当前难度', { exact: true }).selectOption('1');
  assert(await page.getByRole('button', { name: 'Tap', exact: true }).isEnabled(), 'supported Slide difficulty must allow Tap editing');
  assert(await page.getByRole('button', { name: 'Slide', exact: true }).isEnabled(), 'supported Slide difficulty must allow Slide editing');
  assert.equal(await page.locator('.timeline-readonly-note').count(), 0, 'supported Slide difficulty must not show the read-only banner');
  const supportedDiagnostics = await page.locator('.diagnostic').allTextContents();
  assert(supportedDiagnostics.some((text) => text.includes('slide-validation-pending')),
    'supported Slide warning remains visible in the diagnostics');
  for (const difficulty of [2, 4]) {
    await page.getByLabel('当前难度', { exact: true }).selectOption(String(difficulty));
    await page.getByText('此难度只读，导出时保留原文。请查看下方诊断。', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Tap', exact: true }).isDisabled(), `difficulty ${difficulty} must disable editing tools`);
    assert(await page.getByRole('button', { name: 'Slide', exact: true }).isDisabled(), `difficulty ${difficulty} must disable Slide editing`);
  }
  const originalExport = await exportBytes();
  assert.deepEqual(originalExport.bytes, fixtureBytes, 'untouched Slide fixture must export byte-for-byte');

  await page.getByLabel('当前难度', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Tap', exact: true }).click();
  const editResponseOffset = await bridgeCount('responses');
  await clickTimeline(page, 2, 8);
  await version(1);
  await noteCount(3);
  const editedSnapshot = await snapshotAfter(editResponseOffset);
  assertSlideEditability(editedSnapshot);
  assertSupportedSlideModel(editedSnapshot);
  const slideBeforeEdit = slideSummary(editedSnapshot);
  const editedExport = await exportBytes();
  for (const difficulty of [1, 2, 3, 4])
    assert.deepEqual(rawFieldLine(editedExport.bytes, difficulty), rawFieldLine(fixtureBytes, difficulty), `Slide source field ${difficulty} must remain byte-identical`);

  const reopened = await uploadChart('slide-model-edited.maidata.txt', editedExport.bytes);
  assertSlideEditability(reopened);
  assertSupportedSlideModel(reopened);
  assert.deepEqual(slideSummary(reopened), slideBeforeEdit, 'ordinary edit and export/reopen must preserve every supported Slide field');
  await page.getByText('本地恢复：v0 ·', { exact: false }).waitFor({ timeout: 60_000 });

  await page.reload();
  await page.getByRole('button', { name: '恢复项目', exact: true }).waitFor({ timeout: 30_000 });
  const restoreOffset = await bridgeCount('responses');
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await version(0);
  const restored = await snapshotAfter(restoreOffset);
  assertSlideEditability(restored);
  assertSupportedSlideModel(restored);
  assert.deepEqual(slideSummary(restored), slideBeforeEdit, 'schema 5 checkpoint recovery must preserve Slide structure and timing');
  await page.waitForFunction(() => window.__slideTestBridge.requests.some((request) => request.type === 'restore'), null, { timeout: 30_000 });
  const restoredExport = await exportBytes();
  assert.deepEqual(restoredExport.bytes, editedExport.bytes, 'restored document must export the same bytes');
  assert.deepEqual(pageErrors, [], 'browser page errors');

  const report = {
    browser: browser.version(),
    fixture: 'slide-model.maidata.txt',
    flow: ['Worker Slide import', 'timing and path semantics', 'editable supported Slide and read-only unsupported syntax', 'PNG head and transport-seeked timeline display', 'exact source export', 'ordinary difficulty edit', 'export/reopen', 'schema 5 checkpoint restore'],
    supportedSlides: slides(restored, 1).length,
    unsupported: [2, 4].map((difficulty) => ({ difficulty, diagnostics: chart(restored, difficulty).diagnostics.length, slideNotes: slides(restored, difficulty).length })),
    slideTimeline: {
      position: timelineSlide.position,
      startSeconds: timelineSlide.startSeconds,
      initialColorDifference: initialSlidePixels.difference,
      soughtColorDifference: soughtSlidePixels.difference,
      formerLocationColorDifference: formerHeadPixels.difference,
    },
    workerRequests: await page.evaluate(() => window.__slideTestBridge.requests.map(({ type }) => type)),
    checkpointSchemaVersion,
    originalExportBytes: originalExport.bytes.byteLength,
    editedExportBytes: editedExport.bytes.byteLength,
    errors: pageErrors,
  };
  await writeFile('/tmp/maijdata-slide-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-slide-failure.png', fullPage: true }).catch(() => {});
  console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 6000));
  throw error;
} finally {
  await browser.close();
}
