import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { timelinePoint } from './timeline-browser-helpers.mjs';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15_000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const current = () => page.evaluate(() => window.__checks.responses.findLast(reply => reply.ok && reply.type === 'snapshot')?.snapshot);
const checks = async () => (await current()).charts[0].visualChecks;
const version = value => page.locator('.document-heading .status').filter({ hasText: `v${value} ·` }).waitFor();
const menu = () => page.getByRole('menu', { name: '时间轴编辑菜单' });
let imports = 0;
async function load(text) {
  const name = `warnings-${++imports}.txt`;
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.locator('.document-heading').getByText(name, { exact: true }).waitFor();
  await version(0);
}
async function action(name) {
  const point = await timelinePoint(page, 2.5, 8);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await menu().waitFor();
  await menu().getByRole('menuitem', { name, exact: true }).click();
  await menu().waitFor({ state: 'hidden' });
}
async function at(seconds) {
  await page.waitForFunction(value => Math.abs(Number.parseFloat(document.querySelector('.transport output').textContent) - value) < .001, seconds);
}
async function exportText() {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 maidata.txt', exact: true }).click();
  return readFile(await (await pending).path(), 'utf8');
}
try {
  await page.addInitScript(() => {
    window.__checks = { responses: [] };
    const WorkerBase = window.Worker;
    window.Worker = class extends WorkerBase {
      constructor(url, options) {
        super(url, options);
        if (/chart\.worker/.test(String(url))) this.addEventListener('message', event => window.__checks.responses.push(event.data));
      }
    };
  });
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  const source = '&first=0\n&inote_1=(120){4}1/2/3,(240)1/A1,4/4,E\n';
  await load(source);
  const expected = [
    { beat: { numerator: 0, denominator: 1 }, code: 0, severity: 'bad' },
    { beat: { numerator: 1, denominator: 1 }, code: 8, severity: 'bad' },
    { beat: { numerator: 2, denominator: 1 }, code: 7, severity: 'bad' },
  ];
  assert.deepEqual(await checks(), { available: true, results: expected });
  const panel = page.getByRole('region', { name: 'Visual 碰撞检查' });
  await panel.scrollIntoViewIfNeeded();
  assert.match(await panel.innerText(), /3 项结果 · 3 项冲突/);
  await page.screenshot({ path: '/tmp/maijdata-visual-checks.png' });
  await action('下一处告警'); await at(.5);
  await action('下一处告警'); await at(.75);
  await action('下一处告警'); await at(0);
  await action('上一处告警'); await at(.75);
  await version(0);
  await panel.getByRole('button', { name: /0\.500 s/ }).click(); await at(.5);
  await action('全选'); await action('删除'); await version(1);
  assert.deepEqual(await checks(), { available: true, results: [] });
  await action('撤销'); await version(2);
  assert.deepEqual((await checks()).results, expected);
  await page.waitForFunction(() => window.__checks.responses.some(reply => reply.ok && reply.type === 'checkpoint' && reply.checkpoint.document.version === 2));
  assert.equal(await page.evaluate(() => 'visualChecks' in window.__checks.responses.findLast(reply => reply.ok && reply.type === 'checkpoint').checkpoint.document.charts[0]), false,
    'derived collision results must not enter persisted documents');
  const exported = await exportText();
  await load(exported);
  assert.deepEqual((await checks()).results, expected);
  await page.reload();
  await page.getByRole('button', { name: '恢复项目', exact: true }).click();
  await version(0);
  assert.deepEqual((await checks()).results, expected);

  await load('&first=0\n&inote_1=(120){4}1h[240#4:1],E\n');
  assert.equal((await current()).charts[0].editable, true);
  assert.equal((await checks()).available, false);
  assert.match((await checks()).reason, /指定 BPM/);
  await action('全选'); await action('设为 Break'); await version(1);
  assert.equal((await current()).charts[0].notes[0].modifiers.break, true);
  assert.equal((await checks()).available, false, 'check failure must not reject a committed edit');
  await action('撤销'); await version(2);
  assert.equal((await current()).charts[0].notes[0].modifiers.break, false);

  await load('&first=0\n&inote_1=(120){4}' + '1/2/3,'.repeat(80) + 'E\n');
  assert.equal((await checks()).results.length, 80);
  assert.equal(await panel.locator('li').count(), 50);
  await panel.getByRole('button', {name:'下一页结果',exact:true}).click();
  assert.equal(await panel.locator('li').count(), 30);
  assert.match(await panel.innerText(), /第 51–80 项，共 80 项/);
  await panel.getByRole('button', {name:'上一页结果',exact:true}).click();
  assert.equal(await panel.locator('li').count(), 50);

  const readonly = '&first=0\n&inote_1=(120){4}1/2p4[4:1],E\n';
  await load(readonly);
  assert.equal((await checks()).available, false);
  assert.match((await checks()).reason, /未运行碰撞检查/);
  assert.equal(await exportText(), readonly);
  const point = await timelinePoint(page, 2, 8);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await menu().waitFor();
  assert.equal(await menu().getByRole('menuitem', { name: '下一处告警', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), flows: ['three-independent-warning-codes', 'cross-bpm-navigation-and-wrap',
    'result-click-seek', 'edit-and-undo-recompute', 'derived-results-not-persisted', 'candidate-reopen-and-recovery-recompute',
    'readonly-unchecked-not-clean', 'uncheckable-duration-does-not-reject-edit', 'all-results-reachable-with-pagination'], expected, errors };
  await writeFile('/tmp/maijdata-visual-checks-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-visual-checks-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(-4000));
  throw error;
} finally { await browser.close(); }
