import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.__cueStarts = [];
  const create = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () {
    const oscillator = create.call(this);
    const start = oscillator.start;
    const setFrequency = oscillator.frequency.setValueAtTime;
    let frequencyHz = oscillator.frequency.value;
    oscillator.frequency.setValueAtTime = function (value, when) {
      frequencyHz = value;
      return setFrequency.call(this, value, when);
    };
    oscillator.start = function (when) {
      window.__cueStarts.push({ when, frequencyHz });
      return start.call(this, when);
    };
    return oscillator;
  };
});

async function runFrom(seconds) {
  await page.getByLabel('播放位置', { exact: true }).evaluate((input, seconds) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(seconds));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
  await page.waitForFunction((seconds) => Math.abs(Number.parseFloat(document.querySelector('.transport output').textContent) - seconds) < 0.002, seconds);
  await page.evaluate(() => { window.__cueStarts.length = 0; });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.waitForFunction(() => Number.parseFloat(document.querySelector('.transport output').textContent) > 3.7);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  return page.evaluate(() => window.__cueStarts);
}

try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:4173/');
  // One headless Wi-Fi: hit 2, movement 2.5–3.5, path Break. No ordinary note cues.
  await page.getByLabel('谱面文件', { exact: true }).setInputFiles({ name: 'slide-audio.txt', mimeType: 'text/plain',
    buffer: Buffer.from('&title=Slide cue timing\n&first=0\n&inote_1=(120){4},,,,1!w5b[0.5##1],,,,,E\n') });
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  await page.locator('.timeline-panel > .panel-title').getByText('1 个音符', { exact: true }).waitFor();
  const complete = await runFrom(1.8);
  assert.equal(complete.length, 2, 'headless Wi-Fi needs one movement cue and one Break tail cue');
  assert(complete.every((cue) => cue.frequencyHz === 1320));
  assert(Math.abs(complete[1].when - complete[0].when - 1) < 0.02, 'start/tail are one chart second apart');
  const seekMiddle = await runFrom(3);
  assert.equal(seekMiddle.length, 1, 'paused seek into movement must not backfill the elapsed start cue');
  assert.equal(seekMiddle[0].frequencyHz, 1320);
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), complete, seekMiddle, errors,
    scope: 'Real AudioContext oscillator scheduling in the production page; no substitute transport, no original clip timbre or physical output timing claim.' };
  await writeFile('/tmp/maijdata-slide-audio-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
