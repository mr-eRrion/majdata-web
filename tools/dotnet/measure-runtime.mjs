import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(projectRoot);
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(projectRoot, '.tools/playwright');

const [{ chromium }, { generateLoad }] = await Promise.all([
  import('@playwright/test'),
  import(pathToFileURL(path.join(projectRoot, 'fixtures/charts/generate-load.mjs')).href),
]);

const harnessRoot = path.join(projectRoot, '.tools/dotnet-publish/p0-harness');
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.wasm', 'application/wasm'],
  ['.json', 'application/json; charset=utf-8'],
]);
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const filePath = path.resolve(harnessRoot, `.${pathname}`);
    if (!filePath.startsWith(`${harnessRoot}${path.sep}`)) throw new Error('Outside static root');
    const content = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': mimeTypes.get(path.extname(filePath)) ?? 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port.');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  const url = `http://127.0.0.1:${address.port}/p0-harness.html`;
  const coldStartedAt = performance.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('#parse').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#parse').disabled, null, { timeout: 120_000 });
  const coldReadyMs = performance.now() - coldStartedAt;
  const workerReady = await page.locator('#status').textContent();

  async function parse(sourceText) {
    const before = performance.now();
    const result = await page.evaluate((text) => window.__parseMajSimaiSource(text), sourceText);
    const driverEvaluationMs = performance.now() - before;
    return {
      ...result,
      json: JSON.parse(result.json),
      pageWorkerRoundTripMs: result.roundTripMs,
      driverEvaluationMs,
    };
  }

  const baselineText = await readFile(path.join(projectRoot, 'fixtures/charts/baseline.maidata.txt'), 'utf8');
  const baseline = await parse(baselineText);
  const expectedBaseline = [
    [1, 0, 0.25, 'tap'], [1, 0, 0.25, 'tap'], [2, 1, 0.75, 'hold'],
    [3, 2, 1.25, 'tap'], [4, 3, 1.5, 'hold'],
  ];
  const actualBaseline = baseline.json.charts.find((chart) => chart.difficulty === 1).notes.map((note) => [
    note.position, note.beat.numerator / note.beat.denominator,
    note.startSeconds + baseline.json.firstSeconds, note.kind,
  ]);
  if (JSON.stringify(actualBaseline) !== JSON.stringify(expectedBaseline))
    throw new Error(`Baseline mismatch: ${JSON.stringify(actualBaseline)}`);
  if (baseline.json.charts.find((chart) => chart.difficulty === 2).editable !== false)
    throw new Error('Connected Slide chart was not marked read-only.');
  const baselineIds = baseline.json.charts.find((chart) => chart.difficulty === 1).notes.map((note) => note.id);
  if (new Set(baselineIds).size !== baselineIds.length) throw new Error('Duplicate note text did not receive unique source IDs.');

  const strictCases = [
    { source: '&inote_1=(120){4}1h,E', editable: true, duration: 'short' },
    { source: '&inote_1=(120){4}1h[#0.00001],E', editable: true, duration: 'seconds' },
    { source: '&inote_1=(120){4}1h[4:bad],E', editable: false, diagnostic: 'invalid-hold-duration' },
    { source: '&inote_1=(120){4}1h[0:1],E', editable: false, diagnostic: 'invalid-hold-duration' },
    { source: '&inote_1=(120){4}1-9[4:1],E', editable: false },
    { source: '&inote_1=(120){4}1garbage,E', editable: false, diagnostic: 'unconsumed-content' },
    { source: '&inote_1=(120){4}1,E junk', editable: false },
    { source: '&inote_1=(120){#0.5}1,(240)2,3,E', editable: true, times: [0, 0.5, 0.75] },
    { source: '&inote_1=(120){4}1bx,E', editable: true, noteKind: 'tap', modifiers: { break: true, ex: true } },
    { source: '&inote_1=(120){4}2hx[#0.25],E', editable: true, noteKind: 'hold', duration: 'seconds', modifiers: { break: false, ex: true } },
    { source: '&inote_1=(120){4}A1h,E', editable: false, diagnostic: 'unsupported-short-touch-hold', noteCount: 0 },
    { source: '&inote_1=(120){4}A1x,E', editable: false, diagnostic: 'unsupported-touch-ex', noteCount: 0 },
    { source: '&inote_1=(120){4}C1,E', editable: false, diagnostic: 'unconsumed-content' },
    { source: '&inote_1=(120){4}A1f,E', editable: true, noteKind: 'touch', firework: true },
    { source: '&inote_1=(120){4}A1m,E', editable: false, diagnostic: 'unconsumed-content' },
  ];
  for (const testCase of strictCases) {
    const result = await parse(testCase.source);
    const chart = result.json.charts[0];
    if (chart.editable !== testCase.editable) throw new Error(`Unexpected editability for ${testCase.source}: ${JSON.stringify(chart.diagnostics)}`);
    if (testCase.duration && chart.notes[0]?.duration?.kind !== testCase.duration)
      throw new Error(`Unexpected duration for ${testCase.source}: ${JSON.stringify(chart.notes[0]?.duration)}`);
    if (testCase.noteKind && chart.notes[0]?.kind !== testCase.noteKind)
      throw new Error(`Unexpected note kind for ${testCase.source}: ${chart.notes[0]?.kind}`);
    if (testCase.firework !== undefined && chart.notes[0]?.firework !== testCase.firework)
      throw new Error(`Unexpected Firework state for ${testCase.source}: ${chart.notes[0]?.firework}`);
    if (testCase.modifiers && (chart.notes[0]?.modifiers.break !== testCase.modifiers.break
        || chart.notes[0]?.modifiers.ex !== testCase.modifiers.ex))
      throw new Error(`Unexpected modifiers for ${testCase.source}: ${JSON.stringify(chart.notes[0]?.modifiers)}`);
    if (testCase.diagnostic && !chart.diagnostics.some((diagnostic) => diagnostic.code === testCase.diagnostic))
      throw new Error(`Missing ${testCase.diagnostic} diagnostic for ${testCase.source}`);
    if (testCase.noteCount !== undefined && chart.notes.length !== testCase.noteCount)
      throw new Error(`Unsupported syntax leaked a note into the DTO for ${testCase.source}`);
    if (testCase.times && chart.notes.some((note, index) => Math.abs(note.startSeconds - testCase.times[index]) > 1e-6))
      throw new Error(`Unexpected timing for ${testCase.source}: ${JSON.stringify(chart.notes.map((note) => note.startSeconds))}`);
  }

  const connectedSource = '&inote_1=(120){4}1-3-7[4:4],E';
  const connected = await parse(connectedSource);
  const connectedChart = connected.json.charts[0];
  const connectedNote = connectedChart.notes[0];
  if (connected.json.schemaVersion !== 4 || !connectedChart.editable || connectedChart.notes.length !== 1
      || connectedNote.slide?.command !== '-' || connectedNote.slide.endPosition !== 3
      || JSON.stringify(connectedNote.slide.continuations) !== JSON.stringify([{ command: '-', endPosition: 7 }])
      || connectedNote.slide.wait.kind !== 'beatsAtStartBpm' || connectedNote.slide.move.kind !== 'beatsAtStartBpm'
      || connectedNote.slide.move.beats !== 4 || !Number.isFinite(connectedNote.moveStartSeconds)
      || Math.abs(connectedNote.moveStartSeconds - 0.5) > 1e-9
      || Math.abs(connectedNote.durationSeconds - 2.5) > 1e-9
      || connectedSource.slice(connectedNote.sourceRange.start, connectedNote.sourceRange.end) !== '1-3-7[4:4]')
    throw new Error(`Legacy connected Slide did not preserve its route, total timing, and source range: ${JSON.stringify(connectedChart)}`);

  const sharedConnectedSource = '&inote_1=(120){4}1-3-7[4:4]*<5>1b[0.25##1.5]*w5[4:1],E';
  const sharedConnected = await parse(sharedConnectedSource);
  const sharedConnectedChart = sharedConnected.json.charts[0];
  const sharedConnectedNote = sharedConnectedChart.notes[0];
  const sharedPaths = sharedConnectedNote.slide?.additionalPaths ?? [];
  if (!sharedConnectedChart.editable || sharedConnectedChart.notes.length !== 1
      || JSON.stringify(sharedConnectedNote.slide?.continuations) !== JSON.stringify([{ command: '-', endPosition: 7 }])
      || JSON.stringify(sharedPaths[0]?.continuations) !== JSON.stringify([{ command: '>', endPosition: 1 }])
      || sharedPaths[0]?.slideBreak !== true || sharedPaths[1]?.command !== 'w'
      || sharedPaths[1]?.continuations?.length !== 0
      || Math.abs(sharedConnectedNote.durationSeconds - 2.5) > 1e-9
      || sharedConnectedSource.slice(sharedConnectedNote.sourceRange.start, sharedConnectedNote.sourceRange.end)
        !== '1-3-7[4:4]*<5>1b[0.25##1.5]*w5[4:1]')
    throw new Error(`Connected shared-head branches did not preserve independent chains and timing: ${JSON.stringify(sharedConnectedChart)}`);

  for (const token of ['1-5[4:1]*-3<7[4:2]', '1-5[4:1]* - 3 < 7[4:2]']) {
    const angleBranch = await parse(`&inote_1=(120){4}${token},E`);
    const angleBranchChart = angleBranch.json.charts[0];
    const angleBranchPath = angleBranchChart.notes[0]?.slide?.additionalPaths?.[0];
    if (!angleBranchChart.editable
        || JSON.stringify(angleBranchPath?.continuations) !== JSON.stringify([{ command: '<', endPosition: 7 }]))
      throw new Error(`An angle command after a shared-head branch was not parsed as a continuation: ${JSON.stringify(angleBranchChart)}`);
  }

  const readonlyConnectedCases = [
    { token: '1-3[4:1]-7[4:3]', diagnostic: 'unsupported-connected-slide-timing' },
    { token: '1w5-3[4:4]', diagnostic: 'unsupported-connected-wifi' },
    { token: '1-3-4[4:4]', diagnostic: 'unsupported-slide-path' },
  ];
  for (const { token, diagnostic } of readonlyConnectedCases) {
    const result = await parse(`&inote_1=(120){4}${token},E`);
    const chart = result.json.charts[0];
    if (chart.editable || chart.notes.length !== 0 || !chart.diagnostics.some((item) => item.code === diagnostic))
      throw new Error(`Connected Slide boundary ${token} was not rejected as ${diagnostic}: ${JSON.stringify(chart)}`);
  }

  function connectedLineToken(segmentCount) {
    let position = 1;
    let token = String(position);
    for (let index = 0; index < segmentCount; index++) {
      position = ((position - 1 + 2) % 8) + 1;
      token += `-${position}`;
    }
    return `${token}[4:${segmentCount}]`;
  }
  const maxConnected = await parse(`&inote_1=(120){4}${connectedLineToken(64)},E`);
  const maxConnectedChart = maxConnected.json.charts[0];
  if (!maxConnectedChart.editable || maxConnectedChart.notes[0]?.slide?.continuations?.length !== 63)
    throw new Error(`A 64-segment connected Slide should fit the per-path limit: ${JSON.stringify(maxConnectedChart)}`);
  const tooLongConnected = await parse(`&inote_1=(120){4}${connectedLineToken(65)},E`);
  const tooLongChart = tooLongConnected.json.charts[0];
  if (tooLongChart.editable || tooLongChart.notes.length !== 0
      || !tooLongChart.diagnostics.some((item) => item.code === 'unsupported-slide-segment-count'))
    throw new Error(`A 65-segment connected Slide should exceed the per-path limit: ${JSON.stringify(tooLongChart)}`);

  const exactSource = '\uFEFF&title=🎵\r\n&inote_1=(120){4}1,E\r\n';
  const exact = await parse(exactSource);
  const noteRange = exact.json.charts[0].notes[0].sourceRange;
  if (exactSource.slice(noteRange.start, noteRange.end) !== '1')
    throw new Error(`UTF-16 / CRLF source range mismatch: ${JSON.stringify(noteRange)}`);
  if (exact.json.fields.find((field) => field.name === 'title').rawValue !== '🎵\r\n')
    throw new Error('BOM/CRLF field source was not preserved.');

  const touchSource = await readFile(path.join(projectRoot, 'fixtures/charts/touch.maidata.txt'), 'utf8');
  const touchExpected = JSON.parse(await readFile(path.join(projectRoot, 'fixtures/charts/touch-expected.json'), 'utf8'));
  const touchResult = await parse(touchSource);
  const touchChart = touchResult.json.charts.find((chart) => chart.difficulty === 1);
  const readonlyTouchChart = touchResult.json.charts.find((chart) => chart.difficulty === 2);
  if (!touchChart?.editable || !readonlyTouchChart || readonlyTouchChart.editable
      || readonlyTouchChart.notes.length !== 0
      || !readonlyTouchChart.diagnostics.some((diagnostic) => diagnostic.code === touchExpected.difficulty2.diagnostic))
    throw new Error(`Touch read-only boundary mismatch: ${JSON.stringify(touchResult.json.charts)}`);
  const touchNotes = touchChart.notes.map((note) => ({
    kind: note.kind,
    touchArea: note.touchArea,
    position: note.position,
    break: note.modifiers.break,
    beat: note.beat.numerator / note.beat.denominator,
    ...(note.kind === 'touchHold' ? { durationSeconds: note.durationSeconds } : {}),
  }));
  const touchNormalized = {
    editable: touchChart.editable,
    endBeat: touchChart.endBeat,
    notes: touchNotes,
  };
  if (JSON.stringify(touchNormalized) !== JSON.stringify({
    editable: touchExpected.editable,
    endBeat: touchExpected.endBeat,
    notes: touchExpected.notes,
  })) throw new Error(`Touch fixture mismatch: ${JSON.stringify(touchNormalized)}`);
  if (new Set(touchChart.notes.map((note) => note.id)).size !== touchChart.notes.length)
    throw new Error('Touch note source IDs are not unique.');
  for (const note of touchChart.notes) {
    if (touchSource.slice(note.sourceRange.start, note.sourceRange.end).length === 0)
      throw new Error(`Touch source range is empty for ${note.id}`);
  }

  const p3Source = await readFile(path.join(projectRoot, 'fixtures/charts/p3-touch.maidata.txt'), 'utf8');
  const p3Expected = JSON.parse(await readFile(path.join(projectRoot, 'fixtures/charts/p3-touch-expected.json'), 'utf8'));
  const p3Result = await parse(p3Source);
  const p3Chart = p3Result.json.charts.find((chart) => chart.difficulty === 1);
  const p3ReadonlyChart = p3Result.json.charts.find((chart) => chart.difficulty === 2);
  if (!p3Chart?.editable || p3Chart.notes.length !== p3Expected.difficulty1.notes.length
      || !p3ReadonlyChart || p3ReadonlyChart.editable || p3ReadonlyChart.notes.length !== 0
      || !p3ReadonlyChart.diagnostics.some((diagnostic) => diagnostic.code === 'unsupported-touch-ex'))
    throw new Error(`P3 Touch strict fixture mismatch: ${JSON.stringify(p3Result.json.charts)}`);
  for (const [index, expected] of p3Expected.difficulty1.notes.entries()) {
    const note = p3Chart.notes[index];
    if (note.kind !== expected.kind || note.touchArea !== expected.touchArea
        || note.position !== expected.position || note.modifiers.break !== expected.break
        || note.modifiers.ex !== expected.ex
        || Math.abs(note.startSeconds - expected.chartStartSeconds) > 1e-6
        || Math.abs(note.durationSeconds - expected.durationSeconds) > 1e-9
        || (expected.sourceOrder !== undefined && note.order !== expected.sourceOrder))
      throw new Error(`P3 Touch expected note ${index} mismatch: ${JSON.stringify(note)}`);
  }

  async function validateLoad(noteCount) {
    const load = generateLoad(noteCount);
    const result = await parse(load.text);
    const chart = result.json.charts[0];
    if (!chart.editable || chart.notes.length !== noteCount)
      throw new Error(`Load validation failed for ${noteCount}: ${chart.diagnostics.map((d) => d.code).join(', ')}`);
    return {
      ...load.workload,
      sourceUtf16Length: result.json.sourceLengthUtf16,
      workerParseMs: result.workerParseMs,
      pageWorkerRoundTripMs: result.pageWorkerRoundTripMs,
      driverEvaluationMs: result.driverEvaluationMs,
      editable: chart.editable,
      parsedNotes: chart.notes.length,
      slideSegments: 0,
    };
  }
  const smallLoad = generateLoad(1_000);
  await validateLoad(1_000);
  await validateLoad(1_000);
  const smallLoadSamples = [];
  for (let i = 0; i < 10; i++) smallLoadSamples.push(await validateLoad(1_000));
  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      median: sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
  };
  const oneKResults = {
    ...smallLoad.workload,
    sourceUtf16Length: smallLoad.text.length,
    warmupRuns: 2,
    measuredRuns: 10,
    workerParseMs: summarize(smallLoadSamples.map((sample) => sample.workerParseMs)),
    pageWorkerRoundTripMs: summarize(smallLoadSamples.map((sample) => sample.pageWorkerRoundTripMs)),
    driverEvaluationMs: summarize(smallLoadSamples.map((sample) => sample.driverEvaluationMs)),
    editable: true,
    parsedNotes: 1_000,
    slideSegments: 0,
  };
  const tenKPressure = await validateLoad(10_000);
  process.stdout.write(`${JSON.stringify({ type: 'load-results', oneK: oneKResults, tenKPressure }, null, 2)}\n`);

  await page.evaluate(() => window.__terminateMajSimaiParser());

  if (browserErrors.length) throw new Error(`Browser console errors: ${browserErrors.join(' | ')}`);
  process.stdout.write(`${JSON.stringify({
    browser: 'Playwright Chromium headless',
    browserVersion: browser.version(),
    platform: `${process.platform}-${process.arch}`,
    url,
    runtimeUrl: new URL('_framework/dotnet.js', url).href,
    coldReadyMs,
    workerReady,
    baseline: {
      chart1Notes: actualBaseline,
      chart2Editable: false,
      firstSeconds: baseline.json.firstSeconds,
    },
    strictCases: strictCases.length,
    touchFixture: { editableNotes: touchChart.notes.length, readOnlyNotes: readonlyTouchChart.notes.length },
    p3TouchFixture: { editableNotes: p3Chart.notes.length, readOnlyNotes: p3ReadonlyChart.notes.length },
    utf16CrLfBom: 'passed',
    loadResults: { oneK: oneKResults, tenKPressure },
    browserErrors,
  }, null, 2)}\n`);
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
