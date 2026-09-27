import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const baseUrl = process.argv.find(arg => /^https?:\/\//i.test(arg)) ?? 'http://127.0.0.1:4173/';
const scene = JSON.parse(await readFile(new URL('../fixtures/visual-maimai/rendering.json', import.meta.url), 'utf8'));
const parameters = JSON.parse(await readFile(new URL('../apps/web/src/skin/parameters.json', import.meta.url), 'utf8'));
const radius = Math.hypot(...parameters.tracks[0].position.slice(0, 2));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = value => page.locator('.document-heading .status').filter({ hasText: `v${value} ·` }).waitFor();
const current = () => page.evaluate(() => window.__vsz.responses.findLast(
  message => message.ok && message.type === 'snapshot')?.snapshot);
const notes = async () => (await current()).charts.find(chart => chart.difficulty === 1).notes;
const normalized = items => items.map(({ id, order, sourceRange, ...item }) => item);
let imports = 0;

async function load(source) {
  const name = `slide-vsz-${++imports}.maidata.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({
    name, mimeType: 'text/plain', buffer: Buffer.from(source),
  });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}

async function exported() {
  const pending = page.waitForEvent('download');
  await tool('导出 maidata.txt');
  return readFile(await (await pending).path(), 'utf8');
}

async function roundtrip() {
  const before = normalized(await notes());
  const text = await exported();
  await load(text);
  assert.deepEqual(normalized(await notes()), before);
  assert.equal(await exported(), text, 'serialized v/s/z data must remain stable after reopen');
  return text;
}

async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction(value => Math.abs(Number.parseFloat(
    document.querySelector('.transport output').textContent) - value) < 0.002, seconds);
}

async function placeSlide(start, end) {
  await tool('Slide');
  await clickTimeline(page, 0.5, start);
  await clickTimeline(page, 1.5, end);
  const picker = page.getByRole('dialog');
  await picker.waitFor();
  await picker.locator('.slide-picker-preview[data-skin-ready="true"]').waitFor();
  return picker;
}

async function drawSourcePath(command, start, end) {
  const distance = (end - start + 8) % 8;
  const shape = scene.slide_types.commands.find(item => item.command === command);
  const info = shape?.infos.find(item => item.distance === distance);
  assert(info, `fixture contains ${command} distance ${distance}`);
  const path = scene.slide_types.paths[info.path.path_id];
  const bounds = await page.getByRole('dialog').locator('.slide-picker-preview').boundingBox();
  const scale = Math.min(bounds.width, bounds.height) * 0.36 / radius;
  const rotation = -(start - 1) * Math.PI / 4;
  const points = [...path.points].reverse().map(([x, y]) => ({
    x: bounds.x + bounds.width / 2 + (x * Math.cos(rotation) - y * Math.sin(rotation)) * scale,
    y: bounds.y + bounds.height / 2 + 4 - (x * Math.sin(rotation) + y * Math.cos(rotation)) * scale,
  }));
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
  await page.mouse.up();
}

function assertTiming(note, start, moveStart, end) {
  for (const [field, expected] of [['startSeconds', start], ['moveStartSeconds', moveStart], ['endSeconds', end]])
    assert(Math.abs(note[field] - expected) < 1e-6, `${field}: expected ${expected}, got ${note[field]}`);
}

function pathSummary(note) {
  return {
    head: note.slide.head,
    modifiers: note.modifiers,
    paths: [note.slide, ...(note.slide.additionalPaths ?? [])].map(path => ({
      command: path.command, endPosition: path.endPosition, wait: path.wait, move: path.move,
      continuations: path.continuations ?? [],
    })),
    timing: note.slidePaths.map(path => ({
      command: path.command, endPosition: path.endPosition, moveStartSeconds: path.moveStartSeconds,
      endSeconds: path.endSeconds, segments: path.segments?.map(segment => [
        segment.startPosition, segment.command, segment.endPosition, segment.moveStartSeconds, segment.endSeconds,
      ]),
    })),
  };
}

try {
  await page.addInitScript(() => {
    window.__vsz = { responses: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/i.test(String(url)))
          this.addEventListener('message', event => window.__vsz.responses.push(event.data));
      }
    };
  });
  await page.goto(baseUrl);

  const empty = '&first=0\n&inote_1=(120){4},,,,,,,,E\n';
  for (const [command, end, screenshot] of [
    ['v', 3, '/tmp/maijdata-slide-v-middle.png'],
    ['s', 5, '/tmp/maijdata-slide-s-middle.png'],
    ['z', 5, '/tmp/maijdata-slide-z-middle.png'],
  ]) {
    await load(empty);
    const picker = await placeSlide(1, end);
    if (command === 'v') {
      await picker.getByRole('button', { name: '中心折线 v', exact: true }).click();
    } else {
      await drawSourcePath(command, 1, end);
    }
    await version(1);
    await picker.waitFor({ state: 'hidden' });
    const note = (await notes())[0];
    assert.equal(note.kind, 'slide');
    assert.equal(note.slide.command, command);
    assert.equal(note.slide.endPosition, end);
    assertTiming(note, 0.5, 1, 1.5);
    await seek(1.25);
    await page.locator('.circular-preview-panel canvas').screenshot({ path: screenshot });
  }

  const connected = '&title=V S Z shared connected validation\n&first=0\n&lv_1=12\n'
    + '&inote_1=(120){4},1v3s7z3[4:4]*z5[0.25##1.5],E\n';
  await load(connected);
  const importedChart = (await current()).charts.find(chart => chart.difficulty === 1);
  assert(importedChart.editable, 'the supported connected/shared v/s/z chart remains editable');
  assert(!importedChart.diagnostics.some(item => item.severity === 'error'
    || /unsupported|unconsumed|upstream-result-mismatch/.test(item.code)));
  assert.equal((await notes()).length, 1, 'one source head maps to one logical Slide note');
  const original = (await notes())[0];
  assert.deepEqual(original.slide.continuations, [
    { command: 's', endPosition: 7 }, { command: 'z', endPosition: 3 },
  ]);
  assert.equal(original.slide.command, 'v');
  assert.equal(original.slide.endPosition, 3);
  assert.equal(original.slide.additionalPaths.length, 1);
  assert.equal(original.slide.additionalPaths[0].command, 'z');
  assert.equal(original.slide.additionalPaths[0].endPosition, 5);
  assert.deepEqual(original.slide.wait, { kind: 'beatsAtStartBpm', division: 4, beats: 1 });
  assert.deepEqual(original.slide.move, { kind: 'beatsAtStartBpm', division: 4, beats: 4 });
  assert.deepEqual(original.slide.additionalPaths[0].wait, { kind: 'seconds', seconds: 0.25 });
  assert.deepEqual(original.slide.additionalPaths[0].move, { kind: 'seconds', seconds: 1.5 });
  assert.equal(original.slidePaths.length, 2);
  assert.equal(original.slidePaths[0].segments.length, 3);
  assert.equal(original.slidePaths[1].segments.length, 1);
  assertTiming(original, 0.5, 1, 3);
  assert.equal(original.slidePaths[1].moveStartSeconds, 0.75);
  assert.equal(original.slidePaths[1].endSeconds, 2.25);
  assert.equal(original.endSeconds, 3);
  assert.equal(await exported(), connected, 'canonical source should export byte-for-byte before editing');
  const originalStructure = normalized(await notes());

  await tool('选择');
  await clickTimeline(page, 0.5, 1);
  await page.getByLabel('Slide 共享头路径', { exact: true }).selectOption('1');
  await page.getByLabel('Slide 路径', { exact: true }).selectOption('v');
  await version(1);
  const edited = (await notes())[0];
  assert.deepEqual(edited.slide.continuations, original.slide.continuations, 'editing the branch must preserve the main connected route');
  assert.equal(edited.slide.command, 'v');
  assert.equal(edited.slide.endPosition, 3);
  assert.equal(edited.slide.additionalPaths[0].command, 'v');
  assert.equal(edited.slide.additionalPaths[0].endPosition, 2,
    'switching opposite-only z to v selects a valid adjacent endpoint');
  assert.deepEqual(edited.slide.wait, original.slide.wait);
  assert.deepEqual(edited.slide.move, original.slide.move);
  assert.deepEqual(edited.slide.additionalPaths[0].wait, original.slide.additionalPaths[0].wait);
  assert.deepEqual(edited.slide.additionalPaths[0].move, original.slide.additionalPaths[0].move);
  assertTiming(edited, 0.5, 1, 3);
  assert.equal(edited.slidePaths[1].moveStartSeconds, 0.75);
  assert.equal(edited.slidePaths[1].endSeconds, 2.25);

  await tool('撤销 ⌘Z');
  await version(2);
  assert.deepEqual(normalized(await notes()), originalStructure, 'undo restores both source paths and their timings');
  await tool('重做 ⇧⌘Z');
  await version(3);
  const modifiedStructure = normalized(await notes());
  assert.equal((await notes())[0].slide.additionalPaths[0].command, 'v');
  await page.getByText('本地恢复：v3 ·', { exact: false }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await version(3);
  assert.deepEqual(normalized(await notes()), modifiedStructure, 'refresh recovery restores the edited branch');
  const reopened = await roundtrip();
  assert.match(reopened, /1v3s7z3\[4:4\]\*v2\[0\.25##1\.5\]/);

  await tool('选择');
  await clickTimeline(page, 0.5, 1);
  await page.getByLabel('Slide 共享头路径', { exact: true }).selectOption('0');
  await tool('编辑连续路线');
  const routePicker = page.getByRole('dialog');
  await routePicker.locator('[data-preview-ready="true"]').waitFor();
  await routePicker.getByLabel('下一段终点', { exact: true }).selectOption('7');
  await routePicker.getByRole('button', { name: 'Z形 z', exact: true }).click();
  assert.equal(await routePicker.getByLabel('连续路线草稿').textContent(), '1v3s7z3z7 · 4 段');
  await routePicker.getByRole('button', { name: '保存整条路线', exact: true }).click();
  await version(1);
  let extended = (await notes())[0];
  assert.deepEqual(extended.slide.continuations, [
    { command: 's', endPosition: 7 }, { command: 'z', endPosition: 3 }, { command: 'z', endPosition: 7 },
  ]);
  assert.equal(extended.slidePaths[0].segments.length, 4);
  assert.equal(extended.slide.additionalPaths[0].command, 'v', 'editing the main route leaves the shared branch unchanged');
  assert.equal(extended.slide.additionalPaths[0].endPosition, 2);
  assert.deepEqual(extended.slide.additionalPaths[0].wait, original.slide.additionalPaths[0].wait);
  assert.deepEqual(extended.slide.additionalPaths[0].move, original.slide.additionalPaths[0].move);
  assert.deepEqual(extended.slide.wait, original.slide.wait);
  assert.deepEqual(extended.slide.move, original.slide.move);
  assertTiming(extended, 0.5, 1, 3);
  assert.equal(extended.slidePaths[1].moveStartSeconds, 0.75);
  assert.equal(extended.slidePaths[1].endSeconds, 2.25);
  const routeReopened = await roundtrip();
  assert.match(routeReopened, /1v3s7z3z7\[4:4\]\*v2\[0\.25##1\.5\]/);
  extended = (await notes())[0];
  const connectedShared = pathSummary(extended);

  const unsupported = '&first=0\n&inote_1=(120){4}1s3[4:2],E\n';
  await load(unsupported);
  const unsupportedChart = (await current()).charts.find(chart => chart.difficulty === 1);
  assert.equal(unsupportedChart.editable, false, 'an invalid S endpoint keeps the difficulty read-only');
  assert.equal(unsupportedChart.notes.length, 0, 'invalid S must not degrade into a simpler Slide');
  assert.equal(await exported(), unsupported, 'read-only invalid source is preserved byte-for-byte');
  assert.deepEqual(errors, []);

  const report = { browser: browser.version(), independentPlacement: ['v', 's', 'z'], unsupportedReadOnly: '1s3',
    connectedShared, screenshots: [
      '/tmp/maijdata-slide-v-middle.png', '/tmp/maijdata-slide-s-middle.png', '/tmp/maijdata-slide-z-middle.png',
    ], versionAfterEditUndoRedo: [1, 2, 3], routeEditVersion: 1, recoveryVersion: 3,
    reopenedText: routeReopened, errors };
  await writeFile('/tmp/maijdata-slide-vsz-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'pass', independentPlacement: report.independentPlacement,
    sharedPaths: report.connectedShared.timing.length, screenshots: report.screenshots, errors }));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-slide-vsz-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 4000));
  throw error;
} finally {
  await browser.close();
}
