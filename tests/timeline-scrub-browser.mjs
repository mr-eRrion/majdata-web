import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { timelinePoint } from './timeline-browser-helpers.mjs';

const baseUrl = process.argv.find(arg => /^https?:\/\//i.test(arg)) ?? 'http://127.0.0.1:4173/';
const fixture = (await readFile(new URL('../fixtures/charts/mixed-edit-flow.maidata.txt', import.meta.url), 'utf8'))
  .replace('&first=0\n', '&first=0.25\n');
const referenceTone = fileURLToPath(new URL('../fixtures/audio/reference-tone.wav', import.meta.url));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(15000);
page.on('dialog', dialog => void dialog.accept());
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const clock = () => page.locator('.transport output').textContent().then(Number.parseFloat);

async function waitClock(seconds) {
  await page.waitForFunction(target => Math.abs(Number.parseFloat(
    document.querySelector('.transport output').textContent) - target) < 0.002, seconds);
}

async function waitClockAndView(seconds) {
  await page.waitForFunction(target => {
    const canvas = document.querySelector('.timeline-canvas');
    const displayed = Number.parseFloat(document.querySelector('.transport output').textContent);
    return Math.abs(displayed - target) < 0.002 && Math.abs(Number(canvas.dataset.viewSeconds) - target) < 0.002;
  }, seconds);
}

async function seek(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await waitClockAndView(seconds);
}

async function beginMiddleDrag(seconds, lane = 4, capturePointerId = false) {
  await seek(seconds);
  const point = await timelinePoint(page, seconds, lane);
  const scale = await page.locator('.timeline-canvas').evaluate(canvas => Number(canvas.dataset.pixelsPerSecond));
  if (capturePointerId) await page.locator('.timeline-canvas').evaluate(canvas => {
    canvas.addEventListener('pointerdown', event => {
      if (event.button === 1) canvas.dataset.scrubPointerId = String(event.pointerId);
    }, { once: true });
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: 'middle' });
  const pointerId = capturePointerId
    ? await page.locator('.timeline-canvas').evaluate(canvas => Number(canvas.dataset.scrubPointerId)) : undefined;
  return { point, scale, pointerId };
}

async function moveScrub(point, scale, secondsDelta, steps = 1) {
  await page.mouse.move(point.x, point.y + scale * secondsDelta, { steps });
}

try {
  await page.addInitScript(() => {
    window.__musicStarts = [];
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer?.duration === 10) window.__musicStarts.push({ when: args[0], offset: args[1] ?? 0 });
      return original.apply(this, args);
    };
  });
  await page.goto(baseUrl);
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({
    name: 'timeline-scrub-mixed-edit-flow.maidata.txt', mimeType: 'text/plain', buffer: Buffer.from(fixture),
  });
  await page.locator('.document-heading').getByText('timeline-scrub-mixed-edit-flow.maidata.txt', { exact: true }).waitFor();
  await page.locator('.document-heading .status').filter({ hasText: 'v0 ·' }).waitFor();
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();

  await page.getByLabel('歌曲文件', { exact: true }).setInputFiles(referenceTone);
  await page.locator('.song-info strong').getByText('reference-tone.wav', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const text = document.querySelector('.song-info p')?.textContent ?? '';
    const play = [...document.querySelectorAll('.transport button')].find(button => button.textContent.trim() === '播放');
    return text.includes('10.0 秒') && text.includes('48 kHz') && text.includes('2 声道') && play && !play.disabled;
  });
  assert.match(await page.locator('.song-info p').textContent(), /10\.0 秒 · 48 kHz · 2 声道/);

  const { point, scale } = await beginMiddleDrag(1.4);
  await moveScrub(point, scale, 0.2);
  await waitClockAndView(1.6);
  await page.mouse.up({ button: 'middle' });
  await waitClockAndView(1.6249);
  assert((await page.locator('.document-heading .status').textContent()).includes('v0 ·'));
  assert(await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).isDisabled(),
    'scrubbing and release-time adsorption must not create edit history');

  const lower = await beginMiddleDrag(0);
  await moveScrub(lower.point, lower.scale, -0.5, 4);
  await waitClockAndView(-0.25);
  await moveScrub(lower.point, lower.scale, -0.49);
  await waitClockAndView(-0.24);
  await page.mouse.up({ button: 'middle' });
  await waitClockAndView(-0.25);

  const upper = await beginMiddleDrag(9.5);
  await moveScrub(upper.point, upper.scale, 0.5, 4);
  await waitClockAndView(9.75);
  await moveScrub(upper.point, upper.scale, 0.49);
  await waitClockAndView(9.74);
  await page.mouse.up({ button: 'middle' });
  await waitClockAndView(9.7499);

  const cancelDrag = await beginMiddleDrag(1.4, 4, true);
  await moveScrub(cancelDrag.point, cancelDrag.scale, 0.2);
  await waitClockAndView(1.6);
  await page.locator('.timeline-canvas').evaluate((canvas, pointerId) => {
    canvas.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true,
      pointerId, pointerType: 'mouse', button: 1, buttons: 0 }));
  }, cancelDrag.pointerId);
  await page.mouse.up({ button: 'middle' });
  await waitClockAndView(1.6);
  assert(await page.getByRole('button', { name: '撤销 ⌘Z', exact: true }).isDisabled());

  await seek(1.4);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  const playingStart = await clock();
  const playingPoint = await timelinePoint(page, playingStart, 4);
  const playingScale = await page.locator('.timeline-canvas').evaluate(canvas => Number(canvas.dataset.pixelsPerSecond));
  await page.mouse.move(playingPoint.x, playingPoint.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(playingPoint.x, playingPoint.y + playingScale * 0.8);
  await page.waitForTimeout(100);
  const duringPlaybackDrag = await clock();
  assert(await page.getByRole('button', { name: '暂停', exact: true }).isVisible(), 'middle drag must keep playback active');
  assert(duringPlaybackDrag >= playingStart && duringPlaybackDrag - playingStart < 0.5,
    `playing scrub must not apply the pointer displacement as a seek (${playingStart} → ${duringPlaybackDrag})`);
  const startsBeforeRelease = await page.evaluate(() => window.__musicStarts.length);
  await page.mouse.up({ button: 'middle' });
  const startsAfterRelease = await page.evaluate(() => window.__musicStarts);
  assert.equal(startsAfterRelease.length, startsBeforeRelease + 1, 'release must reschedule the playing music source');
  const snappedPlaying = startsAfterRelease.at(-1).offset - 0.25;
  const snappedBeat = snappedPlaying + 0.0001 < 1.5
    ? (snappedPlaying + 0.0001) * 2 : 3 + (snappedPlaying + 0.0001 - 1.5) * 4;
  assert(Math.abs(snappedBeat * 4 - Math.round(snappedBeat * 4)) < 1e-7,
    `playing release must land on the beat grid before playback resumes (${snappedPlaying})`);
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  const afterRelease = await clock();
  await page.waitForTimeout(120);
  assert(await page.getByRole('button', { name: '暂停', exact: true }).isVisible(), 'release-time adsorption must preserve playback');
  assert((await clock()) > afterRelease + 0.04, 'the playback clock must continue after scrub release');
  assert.deepEqual(errors, []);

  const report = { browser: browser.version(), fixture: 'mixed-edit-flow.maidata.txt (&first=0.25)',
    referenceTone: 'reference-tone.wav · 10.0s · 48kHz · stereo',
    crossBpm: { from: 1.4, during: 1.6, releaseBeforeSnap: 1.6, releaseAfterSnap: 1.6249 },
    limits: { lower: -0.25, upper: 9.75, reverseDeltaSeconds: 0.01 },
    pointerCancelClock: 1.6,
    playback: { start: playingStart, duringDrag: duringPlaybackDrag, snappedAtRelease: snappedPlaying, afterRelease: await clock() }, errors };
  await writeFile('/tmp/maijdata-timeline-scrub-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'pass', crossBpm: report.crossBpm, limits: report.limits,
    pointerCancelClock: report.pointerCancelClock, playback: report.playback, errors }));
} catch (error) {
  await page.screenshot({ path: '/tmp/maijdata-timeline-scrub-failure.png', fullPage: true });
  console.error((await page.locator('body').innerText()).slice(0, 3500));
  throw error;
} finally {
  await browser.close();
}
