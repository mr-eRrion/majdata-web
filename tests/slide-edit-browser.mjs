import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { clickTimeline, timelinePoint } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
const phase = value => page.waitForFunction(value => document.querySelector('.timeline-canvas')?.dataset.slidePhase === value, value);
const current = () => page.evaluate(() => window.__slideEdit.responses.findLast(message => message.ok && message.type === 'snapshot').snapshot);
const notes = async () => (await current()).charts.find(chart => chart.difficulty === 1).notes;
const parameters = JSON.parse(await readFile(new URL('../apps/web/src/skin/parameters.json', import.meta.url), 'utf8'));
const radius = Math.hypot(...parameters.tracks[0].position.slice(0, 2));
let imports = 0;
const flows = [];
async function load(source) {
  const name = `slide-edit-${++imports}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(source) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0);
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
}
async function exported() {
  const download = page.waitForEvent('download'); await tool('导出 maidata.txt');
  return readFile(await (await download).path(), 'utf8');
}
async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, seconds) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(seconds));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction(seconds => Math.abs(parseFloat(document.querySelector('.transport output').textContent) - seconds) < .002, seconds);
}
async function circle(key, button = 'left') {
  const [x, y] = parameters.notePlaceArea.positions.find(item => item.key === key).position;
  const bounds = await page.locator('.circular-preview-canvas').boundingBox();
  const scale = Math.min(bounds.width, bounds.height) * .36 / radius;
  await page.mouse.click(bounds.x + bounds.width / 2 + x * scale, bounds.y + bounds.height / 2 + 4 - y * scale, { button });
}
async function roundtrip() {
  const before = (await notes()).map(({ id, order, sourceRange, ...note }) => note);
  const text = await exported(); await load(text);
  assert.deepEqual((await notes()).map(({ id, order, sourceRange, ...note }) => note), before);
  assert.equal(await exported(), text);
  return text;
}
function timing(note, hit, move, end) {
  for (const [key, value] of [['startSeconds', hit], ['moveStartSeconds', move], ['endSeconds', end]])
    assert(Math.abs(note[key] - value) < 1e-6, `${key}: ${note[key]} != ${value}`);
}
try {
  await page.addInitScript(() => {
    window.__slideEdit = { responses: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/i.test(String(url))) this.addEventListener('message', event => window.__slideEdit.responses.push(event.data));
      }
    };
  });
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const empty = '&first=0\n&inote_1=(120){4},,,,,,,,E\n';
  await load(empty); await tool('Slide');
  await clickTimeline(page, .5, 1); await phase('end');
  await clickTimeline(page, .75, 5); await phase('end');
  assert.equal((await notes()).length, 0);
  await clickTimeline(page, 1.5, 5); await phase('path');
  const picker = page.getByRole('dialog');
  await picker.waitFor();
  await picker.locator('[data-skin-ready="true"]').waitFor();
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press('Tab');
    assert(await picker.evaluate(dialog => dialog.contains(document.activeElement)), 'modal keyboard focus stays inside picker');
  }
  await picker.getByRole('button', { name: '直线 -', exact: true }).hover();
  const firstPreview = await picker.locator('canvas').evaluate(canvas => canvas.toDataURL());
  await picker.getByRole('button', { name: '圆弧 <', exact: true }).hover();
  await page.waitForFunction(before => document.querySelector('.slide-picker-preview canvas').toDataURL() !== before, firstPreview);
  await page.screenshot({ path: '/tmp/maijdata-slide-picker.png' });
  await page.keyboard.press('Meta+z');
  assert.equal((await current()).version, 0, 'modal suppresses editor undo');
  await picker.locator('canvas').click({ button: 'right' });
  await page.keyboard.press('Enter');
  assert.equal((await notes()).length, 0, 'right click clears candidate, Enter cannot commit it');
  assert.equal((await notes()).length, 0, 'unconfirmed path must not create a note');
  await page.keyboard.press('Escape'); await picker.waitFor({ state: 'hidden' }); await phase('');
  assert.equal((await current()).version, 0, 'cancel must not create history');
  flows.push('pending early-click rejection and modal cancel without history');

  await clickTimeline(page, .5, 1); await clickTimeline(page, 1.5, 5);
  await picker.waitFor();
  await picker.getByRole('button', { name: /直线/ }).click();
  await version(1); await phase('');
  let slide = (await notes())[0];
  assert.equal(slide.kind, 'slide'); assert.equal(slide.slide.command, '-');
  assert.equal(slide.position, 1); assert.equal(slide.slide.endPosition, 5);
  timing(slide, .5, 1, 1.5);
  await tool('撤销 ⌘Z'); await version(2); assert.equal((await notes()).length, 0);
  await tool('重做 ⇧⌘Z'); await version(3); assert.equal((await notes()).length, 1);
  await roundtrip();
  flows.push('default one-beat line placement, single undo transaction, export/reopen');

  await tool('选择'); await clickTimeline(page, .5, 1);
  await tool('顺转 45°'); await version(1);
  slide = (await notes())[0]; assert.equal(slide.position, 2); assert.equal(slide.slide.endPosition, 6);
  const from = await timelinePoint(page, .5, 2); const to = await timelinePoint(page, 1, 3);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
  await version(2); slide = (await notes())[0];
  assert.equal(slide.position, 3); assert.equal(slide.slide.endPosition, 7); timing(slide, 1, 1.5, 2);
  await tool('复制'); await seek(2.5); await tool('粘贴至播放头'); await version(3);
  assert.equal((await notes()).length, 2); timing((await notes())[1], 2.5, 3, 3.5);
  await roundtrip();
  flows.push('select, rotate whole path, drag in lane/time, copy/paste and reopen');

  await load(empty); await tool('Slide');
  await page.getByLabel('Slide 一拍起始', { exact: true }).uncheck();
  await page.getByLabel('Slide WiFi', { exact: true }).check();
  await clickTimeline(page, .5, 2); await phase('prepare');
  await clickTimeline(page, .25, 8); await phase('prepare');
  await clickTimeline(page, .5, 8); await phase('end');
  await clickTimeline(page, 1.5, 1); await version(1); await phase('');
  assert.equal(await picker.count(), 0, 'Wi-Fi does not open path selector');
  slide = (await notes())[0]; assert.equal(slide.slide.command, 'w'); assert.equal(slide.slide.endPosition, 6);
  timing(slide, .5, .5, 1.5); await roundtrip();
  flows.push('manual wait, ignored middle lane, Wi-Fi opposite endpoint without modal');

  await load(empty); await tool('Slide');
  await clickTimeline(page, .5, 4); await phase('prepare');
  await clickTimeline(page, .5, 8); await phase('end');
  await clickTimeline(page, .5, 1); await version(1);
  timing((await notes())[0], .5, .5, .5); await roundtrip();
  flows.push('zero wait and zero movement remain legal through actual parser');

  await load('&first=0\n&inote_1=(120){4},,(60),,,,,,E\n'); await tool('Slide');
  await page.getByLabel('Slide 一拍起始', { exact: true }).check();
  await clickTimeline(page, .5, 3); await clickTimeline(page, 2, 8); await version(1);
  slide = (await notes())[0]; timing(slide, .5, 1, 2);
  assert.equal(slide.slide.endPosition, 7); await roundtrip();
  flows.push('cross-BPM waiting/movement pair survives actual WASM export/reparse');

  await tool('选择'); await clickTimeline(page, .5, 3);
  const waitField = page.getByLabel('Slide 等待秒数', { exact: true });
  await waitField.focus(); await waitField.blur();
  assert.equal((await current()).version, 0, 'unchanged duration must retain its expression without history');
  await page.getByLabel('Slide 音符头', { exact: true }).selectOption('tap'); await version(1);
  await page.getByLabel('Slide 路径 Break', { exact: true }).click(); await version(2);
  assert(await page.getByLabel('Slide 路径 Break', { exact: true }).isChecked());
  const moveField = page.getByLabel('Slide 移动秒数', { exact: true });
  await moveField.fill('0.75'); await moveField.blur(); await version(3);
  slide = (await notes())[0]; assert.equal(slide.slide.head, 'tap'); assert.equal(slide.slide.slideBreak, true);
  timing(slide, .5, 1, 1.75); await roundtrip();
  flows.push('head and path Break properties, explicit duration edit, untouched expression preservation');

  await load('&first=0\n&inote_1=(120){4}1-5[4:2]/1<3[4:1],,,,E\n');
  assert.equal((await notes()).length, 2);
  await tool('选择'); await clickTimeline(page, 0, 1);
  await tool('顺转 45°'); await version(1);
  await roundtrip();
  assert.equal((await notes()).length, 2);
  flows.push('same-beat same-lane separate Slide events remain distinct through candidate export');

  await load(empty); await tool('Slide');
  await page.getByLabel('Slide WiFi', { exact: true }).uncheck();
  await circle('1'); await phase('end'); await seek(1); await circle('5'); await picker.waitFor();
  await picker.getByRole('button', { name: '圆弧 <', exact: true }).click(); await version(1);
  slide = (await notes())[0]; assert.equal(slide.slide.command, '<'); timing(slide, 0, .5, 1);
  await page.getByLabel('Slide 头模板', { exact: true }).selectOption('tap');
  await page.getByLabel('工具 Break', { exact: true }).check();
  await seek(0); await circle('1', 'middle'); await version(2);
  slide = (await notes())[0]; assert.equal(slide.slide.head, 'tap'); assert.equal(slide.modifiers.break, true);
  await circle('1', 'right'); await version(3); assert.equal((await notes()).length, 0);
  await tool('撤销 ⌘Z'); await version(4); await roundtrip();
  flows.push('circle-area arc placement, middle template, head deletion and undo');

  await tool('选择'); await clickTimeline(page, 0, 1);
  const endpoint = page.getByLabel('Slide 终点位置', { exact: true });
  await endpoint.fill('3'); await endpoint.blur(); await version(1);
  await page.getByLabel('Slide 路径', { exact: true }).selectOption('>'); await version(2);
  const position = page.getByLabel('音符位置', { exact: true });
  await position.fill('2'); await position.blur(); await version(3);
  slide = (await notes())[0]; assert.equal(slide.position, 2); assert.equal(slide.slide.endPosition, 4);
  const expected = (await notes()).map(({ id, order, sourceRange, ...note }) => note);
  await page.getByText('本地恢复：v3 ·', { exact: false }).waitFor();
  await page.reload(); await tool('恢复项目'); await version(3);
  assert.deepEqual((await notes()).map(({ id, order, sourceRange, ...note }) => note), expected);
  await roundtrip();
  flows.push('endpoint/path/start-position properties and modified Slide checkpoint reload/restore');

  await page.screenshot({ path: '/tmp/maijdata-slide-edit.png' });
  assert.deepEqual(errors, []);
  const report = { flows, flowCount: flows.length, finalNotes: await notes(), errors };
  await writeFile('/tmp/maijdata-slide-edit.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
