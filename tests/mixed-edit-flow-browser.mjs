import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const flows = [];
const DERIVED_TIME_FIELDS = new Set(['startSeconds', 'moveStartSeconds', 'endSeconds']);
const TIME_TOLERANCE_SECONDS = 1e-8;
let importNumber = 0;

async function waitVersion(value) {
  await page.locator('.document-heading .status').filter({ hasText: `v${value} ·` }).waitFor();
}

async function load(source) {
  const name = `mixed-edit-flow-${++importNumber}.maidata.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(source),
  });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await waitVersion(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}

async function snapshot() {
  return page.evaluate(() => window.__mixedEdit.responses.findLast(
    message => message.ok && message.type === 'snapshot',
  )?.snapshot);
}

function chartFor(snapshotValue, difficulty) {
  const chart = snapshotValue?.charts.find(item => item.difficulty === difficulty);
  assert(chart, `difficulty ${difficulty} is present`);
  return chart;
}

function normalizeChart(chart) {
  const { sourceRange: _chartSourceRange, notes, diagnostics, ...semanticChart } = chart;
  return {
    ...semanticChart,
    diagnostics: diagnostics.map(({ range: _range, ...diagnostic }) => diagnostic),
    notes: notes.map(({ id: _id, order: _order, sourceRange: _sourceRange, ...note }) => note),
  };
}

function normalizeCharts(snapshotValue) {
  return snapshotValue.charts.map(normalizeChart);
}

function assertSemanticEqual(actual, expected, path = 'snapshot') {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const field = path.split(/[.[\]]/).filter(Boolean).at(-1);
    if (DERIVED_TIME_FIELDS.has(field)) {
      assert(Number.isFinite(actual) && Number.isFinite(expected), `${path} must be finite`);
      assert(Math.abs(actual - expected) <= TIME_TOLERANCE_SECONDS,
        `${path}: ${actual} differs from ${expected} by more than ${TIME_TOLERANCE_SECONDS}s`);
      return;
    }
    assert.equal(actual, expected, path);
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    assert(Array.isArray(actual) && Array.isArray(expected), `${path} array shape`);
    assert.equal(actual.length, expected.length, `${path} length`);
    actual.forEach((item, index) => assertSemanticEqual(item, expected[index], `${path}[${index}]`));
    return;
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    assert.deepEqual(actualKeys, expectedKeys, `${path} keys`);
    for (const key of actualKeys) assertSemanticEqual(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  assert.deepEqual(actual, expected, path);
}

function beatValue(beat) { return beat.numerator / beat.denominator; }
function assertSeconds(actual, expected, label) {
  assert(Number.isFinite(actual), `${label} is finite`);
  assert(Math.abs(actual - expected) <= TIME_TOLERANCE_SECONDS,
    `${label}: ${actual} differs from ${expected} by more than ${TIME_TOLERANCE_SECONDS}s`);
}

async function exportText() {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  return readFile(await (await waiting).path(), 'utf8');
}

try {
  await page.addInitScript(() => {
    window.__mixedEdit = { responses: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/i.test(String(url)))
          this.addEventListener('message', event => window.__mixedEdit.responses.push(event.data));
      }
    };
  });
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const fixture = await readFile(new URL('../fixtures/charts/mixed-edit-flow.maidata.txt', import.meta.url), 'utf8');
  await load(fixture);

  const initialSnapshot = await snapshot();
  const initialCharts = normalizeCharts(initialSnapshot);
  const initialFirst = chartFor(initialSnapshot, 1);
  const initialSecond = chartFor(initialSnapshot, 2);
  assert.equal(initialSnapshot.charts.length, 2);
  assert(initialSnapshot.charts.every(chart => chart.editable), 'both difficulties are editable');
  assert(initialFirst.diagnostics.some(({ code, severity }) => code === 'slide-validation-pending' && severity === 'warning'));
  assert.deepEqual(new Set(initialFirst.notes.map(note => note.kind)), new Set(['tap', 'hold', 'touch', 'touchHold', 'slide']));
  assert(initialFirst.notes.some(note => note.kind === 'tap' && note.forceStar));
  assert(initialFirst.notes.some(note => note.kind === 'touch' && note.firework));
  assert(initialFirst.notes.some(note => note.kind === 'touchHold' && note.firework));
  const initialSlides = initialFirst.notes.filter(note => note.kind === 'slide');
  assert(initialSlides.some(note => note.slide.additionalPaths?.length === 1), 'shared-head branch is parsed');
  assert(initialSlides.some(note => note.slide.continuations?.length === 1), 'legacy connected route is parsed');
  assert(initialSlides.some(note => note.slide.command === 'w'), 'Wi-Fi is parsed');
  assert.deepEqual(initialFirst.bpms.map(event => [beatValue(event.beat), event.bpm]), [[0, 120], [3, 240]]);
  assert.deepEqual(initialSecond.bpms.map(event => [beatValue(event.beat), event.bpm]), [[0, 150], [1, 180]]);
  assert.equal(initialSecond.notes.length, 6);
  const secondDifficultyBefore = normalizeChart(initialSecond);
  flows.push('two editable difficulties import with all current note families and pending Slide warning');

  const originalHold = initialFirst.notes.find(note => note.kind === 'hold' && note.position === 3);
  assert(originalHold);
  assert.equal(beatValue(originalHold.beat), 4);
  // Beat 4 is three beats at 120 BPM plus one beat at the original 240 BPM event.
  assertSeconds(originalHold.startSeconds, 3 * (60 / 120) + 1 * (60 / 240), 'original beat-4 Hold hit time');

  const shared = initialFirst.notes.find(note => note.kind === 'slide' && note.slide.additionalPaths?.length);
  assert(shared);
  await page.getByLabel('当前难度', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await clickTimeline(page, shared.startSeconds, shared.position);
  await page.getByLabel('Slide 共享头路径', { exact: true }).waitFor();
  await page.getByRole('button', { name: '左右镜像', exact: true }).click();
  await waitVersion(1);
  let currentSnapshot = await snapshot();
  let currentFirst = chartFor(currentSnapshot, 1);
  let mirroredShared = currentFirst.notes.find(note => note.kind === 'slide' && note.slide.additionalPaths?.length);
  assert(mirroredShared);
  assert.equal(mirroredShared.position, 4);
  assert.equal(mirroredShared.slide.endPosition, 8);
  assert.deepEqual(mirroredShared.slide.additionalPaths.map(path => [path.command, path.endPosition]), [['>', 2]]);
  assertSemanticEqual(normalizeChart(chartFor(currentSnapshot, 2)), secondDifficultyBefore, 'difficulty2 after mirror');

  await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).click();
  await waitVersion(2);
  currentSnapshot = await snapshot();
  assertSemanticEqual(normalizeCharts(currentSnapshot), initialCharts, 'undo mirror');
  await page.getByRole('button', { name: '重做 ⇧⌘Z', exact: true }).click();
  await waitVersion(3);
  currentSnapshot = await snapshot();
  currentFirst = chartFor(currentSnapshot, 1);
  flows.push('shared Slide branch horizontal mirror transforms endpoints and command; undo/redo restores the complete chart');

  const connected = currentFirst.notes.find(note => note.kind === 'slide' && note.slide.continuations?.length);
  assert(connected);
  await clickTimeline(page, connected.startSeconds, connected.position);
  await page.getByRole('button', { name: '顺转 45°', exact: true }).click();
  await waitVersion(4);
  currentSnapshot = await snapshot();
  currentFirst = chartFor(currentSnapshot, 1);
  const rotatedConnected = currentFirst.notes.find(note => note.kind === 'slide' && note.slide.continuations?.length);
  assert(rotatedConnected);
  assert.deepEqual([rotatedConnected.position, rotatedConnected.slide.endPosition,
    rotatedConnected.slide.continuations[0].endPosition], [2, 4, 8]);
  assertSemanticEqual(normalizeChart(chartFor(currentSnapshot, 2)), secondDifficultyBefore, 'difficulty2 after route rotation');

  const connectedBeat = beatValue(rotatedConnected.beat);
  assert.equal(connectedBeat, 2);
  // At 120 BPM: beat 2 starts at 1s, the default wait is 0.5s, and four move beats take 2s.
  assertSeconds(rotatedConnected.startSeconds, connectedBeat * (60 / 120), 'connected Slide beat-2 hit time');
  assertSeconds(rotatedConnected.moveStartSeconds, 1 + 60 / 120, 'connected Slide movement start');
  assertSeconds(rotatedConnected.endSeconds, 1 + 60 / 120 + 4 * (60 / 120), 'connected Slide total end time');
  assert.equal(rotatedConnected.slidePaths[0].segments.length, 2);
  assertSeconds(rotatedConnected.slidePaths[0].segments[0].moveStartSeconds, rotatedConnected.moveStartSeconds,
    'first connected segment start');
  assertSeconds(rotatedConnected.slidePaths[0].segments[1].endSeconds, rotatedConnected.endSeconds,
    'last connected segment end');
  assertSeconds(rotatedConnected.slidePaths[0].segments.reduce((sum, segment) =>
    sum + segment.endSeconds - segment.moveStartSeconds, 0), 4 * (60 / 120), 'connected route total movement duration');

  const beforeBpmEdit = normalizeCharts(currentSnapshot);
  await page.getByText('BPM 事件（2）', { exact: true }).click();
  await page.getByLabel('BPM 数值 2', { exact: true }).fill('180');
  await page.getByRole('button', { name: '应用 BPM', exact: true }).click();
  await waitVersion(5);
  currentSnapshot = await snapshot();
  currentFirst = chartFor(currentSnapshot, 1);
  assert.deepEqual(currentFirst.bpms.map(event => [beatValue(event.beat), event.bpm]), [[0, 120], [3, 180]]);
  const retimedHold = currentFirst.notes.find(note => note.kind === 'hold' && note.position === 3);
  assert(retimedHold);
  assert.equal(beatValue(retimedHold.beat), 4);
  // Manual cross-BPM check: beat 4 = 3*60/120 + 1*60/180 = 11/6 seconds.
  assertSeconds(retimedHold.startSeconds, 3 * (60 / 120) + 1 * (60 / 180), 'retimed beat-4 Hold hit time');
  assertSeconds(retimedHold.endSeconds - retimedHold.startSeconds, 2 * (60 / 180), 'retimed beat-4 Hold elapsed duration');
  const retimedConnected = currentFirst.notes.find(note => note.kind === 'slide' && note.slide.continuations?.length);
  assert(retimedConnected);
  assertSeconds(retimedConnected.endSeconds - retimedConnected.startSeconds, 1 * (60 / 120) + 4 * (60 / 120),
    'connected route remains timed from its beat-2 starting BPM');
  assertSemanticEqual(normalizeChart(chartFor(currentSnapshot, 2)), secondDifficultyBefore, 'difficulty2 after BPM edit');
  const afterBpmEdit = normalizeCharts(currentSnapshot);

  await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).click();
  await waitVersion(6);
  assertSemanticEqual(normalizeCharts(await snapshot()), beforeBpmEdit, 'undo BPM edit');
  await page.getByRole('button', { name: '重做 ⇧⌘Z', exact: true }).click();
  await waitVersion(7);
  currentSnapshot = await snapshot();
  assertSemanticEqual(normalizeCharts(currentSnapshot), afterBpmEdit, 'redo BPM edit');
  flows.push('explicit beat-to-seconds checks cover cross-BPM note timing and connected-route total movement; BPM undo/redo is exact');

  await page.getByText('本地恢复：v7 ·', { exact: false }).waitFor();
  const candidate = await exportText();
  const originalSecondDifficultyLine = fixture.split(/\r?\n/).find(line => line.startsWith('&inote_2='));
  assert(originalSecondDifficultyLine);
  assert(candidate.split(/\r?\n/).includes(originalSecondDifficultyLine), 'unmodified second difficulty source line is preserved');
  const editedCharts = normalizeCharts(currentSnapshot);
  await page.reload();
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await waitVersion(7);
  const restoredSnapshot = await snapshot();
  assertSemanticEqual(normalizeCharts(restoredSnapshot), editedCharts, 'IndexedDB recovery');
  assert.equal(await exportText(), candidate, 'recovered candidate bytes match the pre-reload export');
  flows.push('reload restores both complete chart snapshots and exact candidate export bytes');

  await load(candidate);
  const reopenedSnapshot = await snapshot();
  assertSemanticEqual(normalizeCharts(reopenedSnapshot), editedCharts, 'candidate re-open across both difficulties');
  assert.equal(await exportText(), candidate, 'reopened candidate exports byte-for-byte');
  assertSemanticEqual(normalizeChart(chartFor(reopenedSnapshot, 2)), secondDifficultyBefore, 'second difficulty after re-open');
  flows.push('candidate export reopens with full per-difficulty semantics and byte-stable re-export');

  assert.deepEqual(errors, []);
  const report = {
    browser: browser.version(),
    fixture: 'mixed-edit-flow.maidata.txt',
    flows,
    derivedTimeToleranceSeconds: TIME_TOLERANCE_SECONDS,
    manualTiming: {
      beat4At120Then240: 3 * (60 / 120) + 1 * (60 / 240),
      beat4At120Then180: 3 * (60 / 120) + 1 * (60 / 180),
      connectedBeat2Start: 2 * (60 / 120),
      connectedWaitSeconds: 60 / 120,
      connectedMoveSeconds: 4 * (60 / 120),
    },
    errors,
  };
  await writeFile('/tmp/maijdata-mixed-edit-flow-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-mixed-edit-flow-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
}
