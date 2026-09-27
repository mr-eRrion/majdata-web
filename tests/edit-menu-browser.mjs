import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline, timelinePoint } from './timeline-browser-helpers.mjs';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173/';
const fixture = await readFile(new URL('../fixtures/charts/mixed-edit-flow.maidata.txt', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const menuLabels = ['撤销', '重做', '全选', '取消选择', '复制', '剪切', '粘贴', '删除',
  '左右镜像', '上下镜像', '顺转 45°', '逆转 45°', '设为 Break', '取消 Break', '设为路径 Break',
  '取消路径 Break', '设为 EX', '取消 EX', '下一处告警', '上一处告警'];
const menu = () => page.getByRole('menu', { name: '时间轴编辑菜单', exact: true });
const item = label => menu().getByRole('menuitem', { name: label, exact: true });
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const responseState = () => page.evaluate(() => window.__editMenu.responses.findLast(
  message => message.ok && message.type === 'snapshot')?.snapshot);
const chartState = async () => (await responseState()).charts.find(chart => chart.difficulty === 1);
const notes = async () => (await chartState()).notes;
let importNumber = 0;

async function load(source) {
  const filename = `edit-menu-${++importNumber}.maidata.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({
    name: filename, mimeType: 'text/plain', buffer: Buffer.from(source),
  });
  await page.locator('.document-heading').getByText(filename, { exact: true }).waitFor();
  await version(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}

async function exportText() {
  const pending = page.waitForEvent('download');
  await tool('导出 maidata.txt');
  return readFile(await (await pending).path(), 'utf8');
}

async function blankPoint(seconds = 8, lane = 1) { return timelinePoint(page, seconds, lane); }

async function lowerRightPoint() {
  const target = await page.locator('.timeline-canvas').evaluate(canvas => {
    const bounds = canvas.getBoundingClientRect();
    const data = canvas.dataset;
    const y = bounds.height - 45;
    return {
      seconds: Number(data.viewSeconds) + (Number(data.playheadY) - y) / Number(data.pixelsPerSecond),
      lane: 1,
    };
  });
  return timelinePoint(page, target.seconds, target.lane);
}

async function openMenu(point, verifyRightRelease = false) {
  await page.mouse.move(point.x, point.y);
  if (verifyRightRelease) {
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(40);
    assert.equal(await menu().count(), 0, 'right mouse-down alone must not open the menu');
    await page.evaluate(() => { window.__menuPreviousFocus = document.activeElement; });
    await page.mouse.up({ button: 'right' });
  } else {
    await page.mouse.click(point.x, point.y, { button: 'right' });
  }
  await menu().waitFor();
  return menu();
}

async function openBlankMenu(seconds = 8, lane = 1) {
  return openMenu(await blankPoint(seconds, lane));
}

async function activate(label) {
  await item(label).click();
  await menu().waitFor({ state: 'hidden' });
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

function beatValue(beat) { return beat.numerator / beat.denominator; }
function secondsAtBeat(beat, events) {
  let previous = 0;
  let bpm = events[0]?.bpm ?? 120;
  let seconds = 0;
  for (const event of events) {
    const next = beatValue(event.beat);
    if (next <= 0) { bpm = event.bpm; continue; }
    if (next >= beat) break;
    seconds += (next - previous) * 60 / bpm;
    previous = next;
    bpm = event.bpm;
  }
  return seconds + (beat - previous) * 60 / bpm;
}

function noteSemantic(note) {
  const { id: _id, order: _order, sourceRange: _sourceRange, beat: _beat,
    startSeconds: _start, moveStartSeconds: _move, endSeconds: _end,
    bpm: _bpm, isEach: _each, isSlideEach: _slideEach, slidePaths: _slidePaths, ...semantic } = note;
  return semantic;
}

function assertOneBeatOffset(source, pasted, offset) {
  const expected = source.map(note => ({ key: JSON.stringify(noteSemantic(note)), beat: beatValue(note.beat) + offset }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.beat - b.beat);
  const actual = pasted.map(note => ({ key: JSON.stringify(noteSemantic(note)), beat: beatValue(note.beat) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.beat - b.beat);
  assert.deepEqual(actual, expected, 'paste shifts only the common beat offset and preserves lanes, Touch areas, and Slide paths');
}

async function selectedCount() {
  const heading = await page.locator('.tools-panel h3').filter({ hasText: /^选中 / }).textContent();
  return Number(heading.match(/选中 (\d+) 个音符/)?.[1] ?? -1);
}

try {
  await page.addInitScript(() => {
    window.__editMenu = { responses: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(...args) {
        if (window.__editMenu.delayEditMs && args[0]?.type === 'edit')
          setTimeout(() => super.postMessage(...args), window.__editMenu.delayEditMs);
        else super.postMessage(...args);
      }
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/i.test(String(url)))
          this.addEventListener('message', event => window.__editMenu.responses.push(event.data));
      }
    };
  });
  await page.goto(baseUrl);

  const empty = '&first=0\n&inote_1=(120){4},,,,,,,,E\n';
  await load(empty);
  const selectButton = page.getByRole('button', { name: '选择', exact: true });
  await selectButton.focus();
  let opened = await openMenu(await lowerRightPoint(), true);
  assert.deepEqual((await opened.getByRole('menuitem').allTextContents()).map(text => text.trim()), menuLabels);
  const menuBounds = await opened.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert(menuBounds.x >= 0 && menuBounds.y >= 0
    && menuBounds.x + menuBounds.width <= viewport.width
    && menuBounds.y + menuBounds.height <= viewport.height, 'menu stays inside the viewport at its lower-right edge');
  assert.equal(await opened.evaluate(element => element === document.activeElement), true,
    'an all-disabled menu receives keyboard focus');
  await page.keyboard.press('Space');
  assert.equal(await page.getByRole('button', { name: '暂停', exact: true }).count(), 0,
    'Space must not reach global playback while the menu is focused');
  await page.keyboard.press('Escape');
  await opened.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement === window.__menuPreviousFocus), true,
    'Escape closes the menu and restores the previous focus');

  await load(fixture);
  const initialChart = await chartState();
  assert(initialChart.editable && initialChart.notes.some(note => note.slide?.additionalPaths?.length),
    'the fixture supplies editable notes and a shared connected Slide');
  const originalNotes = structuredClone(initialChart.notes);
  const originalIds = new Set(originalNotes.map(note => note.id));
  await tool('选择');
  opened = await openMenu(await lowerRightPoint());
  assert.deepEqual((await opened.getByRole('menuitem').allTextContents()).map(text => text.trim()), menuLabels);
  await page.screenshot({ path: '/tmp/maijdata-edit-menu-open.png' });
  await activate('全选');
  assert.equal(await selectedCount(), originalNotes.length);

  opened = await openBlankMenu();
  assert.equal(await item('复制').isDisabled(), false);
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '上一处告警');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '全选');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(50);
  assert.equal((await chartState()).notes.length, originalNotes.length, 'global Delete is blocked while the menu is open');
  await page.keyboard.press('Escape');
  await menu().waitFor({ state: 'hidden' });
  assert.equal((await chartState()).notes.length, originalNotes.length);

  opened = await openBlankMenu(6, 8);
  await page.getByRole('heading', { name: '工具与属性', exact: true }).click();
  await menu().waitFor({ state: 'hidden' });
  opened = await openBlankMenu(6, 8);
  await activate('复制');
  await version(0);
  await seek(2.25);
  const playheadBeforePaste = Number.parseFloat(await page.locator('.transport output').textContent());
  const chart = await chartState();
  const originBeat = Math.min(...originalNotes.map(note => beatValue(note.beat)));
  const targetBeat = 12;
  const targetSeconds = secondsAtBeat(targetBeat, chart.bpms);
  opened = await openBlankMenu(4, 1);
  await activate('粘贴');
  assert.equal((await chartState()).notes.length, originalNotes.length, 'selecting Paste only starts the preview');
  const cancelPoint = await blankPoint(targetSeconds, 4);
  await page.mouse.move(cancelPoint.x, cancelPoint.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(60);
  assert.equal(await menu().count(), 0, 'right-click cancels paste instead of opening the menu');
  assert.equal((await chartState()).notes.length, originalNotes.length, 'cancelled paste neither deletes nor inserts notes');
  await version(0);

  opened = await openBlankMenu(4, 1);
  await activate('粘贴');
  const target = await timelinePoint(page, targetSeconds, 1);
  await page.mouse.move(target.x, target.y);
  assert.equal((await chartState()).notes.length, originalNotes.length, 'hovering the ghost does not commit');
  await page.locator('.timeline-canvas').screenshot({ path: '/tmp/maijdata-edit-menu-paste-ghost.png' });
  await page.mouse.down({ button: 'left' });
  assert.equal((await chartState()).notes.length, originalNotes.length, 'paste commits on pointer release, not press');
  await page.mouse.up({ button: 'left' });
  await version(1);
  let afterPaste = await chartState();
  assert.equal(afterPaste.notes.length, originalNotes.length * 2);
  const pastedNotes = afterPaste.notes.filter(note => !originalIds.has(note.id));
  assert.equal(pastedNotes.length, originalNotes.length);
  assertOneBeatOffset(originalNotes, pastedNotes, targetBeat - originBeat);
  assert(Math.abs(Number.parseFloat(await page.locator('.transport output').textContent()) - playheadBeforePaste) < 0.002,
    'paste anchor comes from pointer release, not the playback cursor');

  opened = await openBlankMenu(5, 8);
  await activate('撤销');
  await version(2);
  assert.equal((await chartState()).notes.length, originalNotes.length, 'one Undo removes the complete pasted selection');
  opened = await openBlankMenu(5, 8);
  await activate('重做');
  await version(3);
  afterPaste = await chartState();
  assert.equal(afterPaste.notes.length, originalNotes.length * 2);

  const pastedSlide = afterPaste.notes.find(note => note.kind === 'slide' && beatValue(note.beat) >= targetBeat);
  assert(pastedSlide?.slide.additionalPaths?.length, 'the pasted copy retains its shared route');
  await tool('选择');
  await clickTimeline(page, pastedSlide.startSeconds, pastedSlide.position);
  assert.equal(await selectedCount(), 1);
  opened = await openBlankMenu(5.5, 8);
  await activate('剪切');
  await version(4);
  let currentNotes = await notes();
  assert.equal(currentNotes.length, originalNotes.length * 2 - 1);
  assert(!currentNotes.some(note => note.id === pastedSlide.id));

  await page.keyboard.press('Control+v');
  const nextBeat = 16;
  const nextSeconds = secondsAtBeat(nextBeat, chart.bpms);
  const nextPoint = await timelinePoint(page, nextSeconds, 2);
  await page.mouse.move(nextPoint.x, nextPoint.y);
  assert.equal((await notes()).length, currentNotes.length, 'keyboard Paste also previews until release');
  await page.mouse.click(nextPoint.x, nextPoint.y, { button: 'right' });
  await page.waitForTimeout(50);
  assert.equal(await menu().count(), 0, 'right-click cancels keyboard Paste without opening a menu');
  assert.equal((await notes()).length, currentNotes.length);
  await version(4);

  await page.keyboard.press('Control+v');
  const confirmPoint = await timelinePoint(page, nextSeconds, 1);
  await page.mouse.move(confirmPoint.x, confirmPoint.y);
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
  await version(5);
  currentNotes = await notes();
  const movedSlide = currentNotes.find(note => note.kind === 'slide' && Math.abs(beatValue(note.beat) - nextBeat) < 1e-8);
  assert(movedSlide?.slide.additionalPaths?.length, 'cut then keyboard Paste retains the complete shared connected Slide');
  assert.equal(movedSlide.position, pastedSlide.position);

  opened = await openBlankMenu(5, 8);
  await activate('全选');
  opened = await openBlankMenu(5, 8);
  await activate('设为 Break');
  await version(6);
  currentNotes = await notes();
  assert(currentNotes.filter(note => note.kind === 'tap' || note.kind === 'hold' || note.kind === 'slide')
    .every(note => note.modifiers.break));
  assert(currentNotes.filter(note => note.kind === 'touch' || note.kind === 'touchHold')
    .every(note => !note.modifiers.break), 'Break menu action excludes Touch and TouchHold');
  const slideHeads = currentNotes.filter(note => note.kind === 'slide').map(note => [note.id, note.slide.head]);

  opened = await openBlankMenu(5, 8);
  await activate('设为 EX');
  await version(7);
  currentNotes = await notes();
  assert(currentNotes.filter(note => note.kind === 'tap' || note.kind === 'hold' || note.kind === 'slide')
    .every(note => note.modifiers.ex));
  assert(currentNotes.filter(note => note.kind === 'touch' || note.kind === 'touchHold')
    .every(note => !note.modifiers.ex), 'EX menu action excludes Touch and TouchHold');

  opened = await openBlankMenu(5, 8);
  await activate('设为路径 Break');
  await version(8);
  currentNotes = await notes();
  const slides = currentNotes.filter(note => note.kind === 'slide');
  assert(slides.every(note => note.slide.slideBreak
    && (note.slide.additionalPaths ?? []).every(path => path.slideBreak)), 'path Break applies to every shared branch');
  assert.deepEqual(slides.map(note => [note.id, note.slide.head]), slideHeads, 'path Break leaves shared Slide heads unchanged');

  const edited = currentNotes.map(note => ({ beat: note.beat, ...noteSemantic(note) }));
  await load(await exportText());
  assert.deepEqual((await notes()).map(note => ({ beat: note.beat, ...noteSemantic(note) })), edited,
    'menu edits survive real candidate export and WASM reopen');
  await page.locator('.timeline-canvas').focus();
  await page.keyboard.press('Control+v');
  await load(empty);
  await clickTimeline(page, 1, 2);
  assert.equal((await notes()).length, 0, 'document replacement cancels a pending paste');
  await openBlankMenu();
  await load(empty);
  assert.equal(await menu().count(), 0, 'document replacement closes a stale menu');
  await tool('Hold');
  await clickTimeline(page, 0.5, 2);
  let point = await blankPoint(3, 7);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  assert.equal(await menu().count(), 0, 'right-click cancels a pending Hold before considering the menu');
  await clickTimeline(page, 0.75, 2);
  await version(0);
  await clickTimeline(page, 1, 2);
  await version(1);
  assert.equal((await notes()).length, 1, 'the cancelled start does not leak into the next Hold');
  assert(Math.abs((await notes())[0].startSeconds - 0.75) < 1e-7);

  await load(empty);
  await tool('Slide');
  await clickTimeline(page, 0.5, 1);
  await page.waitForFunction(() => Boolean(document.querySelector('.timeline-canvas').dataset.slidePhase));
  point = await blankPoint(3, 7);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForFunction(() => document.querySelector('.timeline-canvas').dataset.slidePhase === '');
  assert.equal(await menu().count(), 0, 'right-click cancels pending Slide before considering the menu');
  assert.equal((await notes()).length, 0);

  await load('&first=0\n&inote_1=(120){4}1,,,,E\n');
  await tool('选择');
  const tap = (await notes()).find(note => note.kind === 'tap');
  assert(tap);
  point = await timelinePoint(page, tap.startSeconds, tap.position);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await version(1);
  assert.equal((await notes()).length, 0, 'right-click on a note deletes it without opening the blank-track menu');
  assert.equal(await menu().count(), 0);

  await load('&first=0\n&inote_1=(120){4}1,2,E\n');
  const rapid = await notes();
  const firstDelete = await timelinePoint(page, rapid[0].startSeconds, rapid[0].position);
  const secondDelete = await timelinePoint(page, rapid[1].startSeconds, rapid[1].position);
  await page.evaluate(() => { window.__editMenu.delayEditMs = 200; });
  await page.mouse.click(firstDelete.x, firstDelete.y, { button: 'right' });
  await page.mouse.click(secondDelete.x, secondDelete.y, { button: 'right' });
  await version(2);
  assert.equal((await notes()).length, 0, 'both queued right-click deletes survive the first version change');
  assert.equal(await menu().count(), 0);
  await page.evaluate(() => { window.__editMenu.delayEditMs = 0; });

  const readonly = '&first=0\n&inote_1=(120){4}1/2-4[4:1]-6[4:1],E\n';
  await load(readonly);
  const readonlyChart = await chartState();
  assert.equal(readonlyChart.editable, false);
  assert(readonlyChart.notes.length > 0, 'the read-only fixture still has a parsed ordinary note');
  point = await blankPoint(8, 1);
  opened = await openMenu(point);
  assert.equal(await item('全选').isDisabled(), false);
  await activate('全选');
  assert.equal(await selectedCount(), readonlyChart.notes.length);
  opened = await openBlankMenu();
  assert.equal(await item('复制').isDisabled(), false);
  for (const label of ['剪切', '粘贴', '删除', '左右镜像', '上下镜像', '顺转 45°', '逆转 45°',
    '设为 Break', '设为路径 Break', '设为 EX']) assert.equal(await item(label).isDisabled(), true, `${label} is disabled in read-only mode`);
  await activate('复制');
  await version(0);
  assert.equal(await exportText(), readonly, 'read-only menu actions preserve the original source');
  assert.deepEqual(errors, []);

  const report = {
    browser: browser.version(),
    menuItemsInSourceOrder: menuLabels,
    flows: ['right-up-only-open-and-viewport-clamp', 'empty-menu-focus-space-block-and-escape',
      'all-copy-paste-preview-release-anchor-preserves-whole-note-semantics', 'paste-right-cancel',
      'paste-single-undo-redo', 'cut-then-keyboard-paste-and-right-cancel', 'break-exclude-touch',
      'path-break-all-shared-branches-preserve-head', 'pending-hold-and-slide-right-cancel-priority',
      'note-right-click-delete-priority', 'readonly-selection-copy-and-mutation-gates',
      'outside-pointer-close', 'global-delete-blocked-and-keyboard-wrap',
      'edited-candidate-export-reopen', 'document-replacement-cancels-paste-and-menu', 'queued-right-delete'],
    screenshots: ['/tmp/maijdata-edit-menu-open.png', '/tmp/maijdata-edit-menu-paste-ghost.png'],
    finalReadOnlyNotes: readonlyChart.notes.length,
    errors,
  };
  await writeFile('/tmp/maijdata-edit-menu-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'pass', flows: report.flows.length, menuItems: menuLabels.length,
    screenshots: report.screenshots, errors }));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-edit-menu-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 4000));
  throw error;
} finally {
  await browser.close();
}
