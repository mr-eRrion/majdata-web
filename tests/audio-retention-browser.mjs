import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const baseUrl = process.argv.find(value => /^https?:\/\//i.test(value)) ?? 'http://127.0.0.1:4173/';
const durationSeconds = 300;
const sampleRateHz = 48_000;
const channelCount = 2;
const bytesPerSample = 2;
const replacementCount = 10;
const tempDir = await mkdtemp(join(tmpdir(), 'maijdata-audio-retention-'));
const masterPath = join(tempDir, 'source.wav');
const audioFiles = [];
const dataBytes = durationSeconds * sampleRateHz * channelCount * bytesPerSample;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(channelCount, 22);
wav.writeUInt32LE(sampleRateHz, 24);
wav.writeUInt32LE(sampleRateHz * channelCount * bytesPerSample, 28);
wav.writeUInt16LE(channelCount * bytesPerSample, 32);
wav.writeUInt16LE(bytesPerSample * 8, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataBytes, 40);

let browser;
let page;
let cdp;
let firstReady;
let tenthReplacementReady;
const pageErrors = [];

async function waitForAudioReady(filename) {
  await page.waitForFunction(name => document.querySelector('.song-info strong')?.textContent?.trim() === name,
    filename, { timeout: 180_000 });
  const info = await page.locator('.song-info p').innerText();
  assert.match(info, /300\.0 秒/);
  assert.match(info, /48 kHz/);
  assert.match(info, /2 声道/);
  assert.equal(await page.getByRole('alert').count(), 0, `${filename} should finish decode and waveform without an error`);
  return info;
}

async function snapshot(label, diagnosticForcedGc = false) {
  const [heap, weak] = await Promise.all([
    cdp.send('Runtime.getHeapUsage'),
    page.evaluate(() => ({
      entries: window.__retention.entries.map(entry => {
        const encoded = entry.encodedRef.deref();
        const decoded = entry.bufferRef.deref();
        return {
          sequence: entry.sequence,
          encodedBytes: entry.encodedBytes,
          decodedBytes: entry.decodedBytes,
          encodedAlive: Boolean(encoded),
          encodedCurrentByteLength: encoded?.byteLength ?? null,
          decodedAlive: Boolean(decoded),
        };
      }),
    })),
  ]);
  return {
    label,
    diagnosticForcedGc,
    heapUsage: {
      usedSize: heap.usedSize,
      backingStorageSize: heap.backingStorageSize,
      totalSize: heap.totalSize,
      embedderHeapUsedSize: heap.embedderHeapUsedSize,
    },
    weak,
    alive: {
      encoded: weak.entries.filter(entry => entry.encodedAlive).length,
      decoded: weak.entries.filter(entry => entry.decodedAlive).length,
      oldEncoded: weak.entries.slice(0, -1).filter(entry => entry.encodedAlive).length,
      oldDecoded: weak.entries.slice(0, -1).filter(entry => entry.decodedAlive).length,
      currentEncoded: weak.entries.at(-1)?.encodedAlive ?? false,
      currentDecoded: weak.entries.at(-1)?.decodedAlive ?? false,
    },
  };
}

try {
  await writeFile(masterPath, wav);
  for (let index = 0; index <= replacementCount; index += 1) {
    const filename = `retention-${String(index).padStart(2, '0')}-5m.wav`;
    const path = join(tempDir, filename);
    await link(masterPath, path);
    audioFiles.push({ filename, path });
  }

  const launchOptions = { headless: true };
  if (process.env.BROWSER_EXECUTABLE) launchOptions.executablePath = resolve(process.env.BROWSER_EXECUTABLE);
  browser = await chromium.launch(launchOptions);
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => pageErrors.push(error.message));
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  await cdp.send('HeapProfiler.enable');
  await page.addInitScript(() => {
    const state = { nextSequence: 0, entries: [] };
    Object.defineProperty(window, '__retention', { value: state });
    const prototype = window.AudioContext?.prototype;
    if (!prototype) return;
    const decode = prototype.decodeAudioData;
    prototype.decodeAudioData = function (encoded, ...callbacks) {
      const sequence = ++state.nextSequence;
      const encodedRef = new WeakRef(encoded);
      const encodedBytes = encoded.byteLength;
      return decode.call(this, encoded, ...callbacks).then(buffer => {
        state.entries.push({
          sequence,
          encodedRef,
          bufferRef: new WeakRef(buffer),
          encodedBytes,
          decodedBytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
        });
        return buffer;
      });
    };
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('歌曲文件', { exact: true }).waitFor({ state: 'attached' });

  for (let index = 0; index <= replacementCount; index += 1) {
    const { filename, path } = audioFiles[index];
    await page.getByLabel('歌曲文件', { exact: true }).setInputFiles(path);
    const info = await waitForAudioReady(filename);
    const probe = await page.evaluate(() => ({
      count: window.__retention.entries.length,
      last: window.__retention.entries.at(-1) && {
        sequence: window.__retention.entries.at(-1).sequence,
        encodedBytes: window.__retention.entries.at(-1).encodedBytes,
        decodedBytes: window.__retention.entries.at(-1).decodedBytes,
      },
    }));
    assert.equal(probe.count, index + 1, `${filename} should produce exactly one decode`);
    assert.equal(probe.last.sequence, index + 1);
    assert.equal(probe.last.encodedBytes, wav.byteLength);
    assert.equal(probe.last.decodedBytes, durationSeconds * sampleRateHz * channelCount * Float32Array.BYTES_PER_ELEMENT);

    if (index === 0) {
      firstReady = await snapshot('first-song-waveform-ready');
      firstReady.trackInfo = info;
    }
    if (index === replacementCount) {
      tenthReplacementReady = await snapshot('tenth-replacement-waveform-ready');
      tenthReplacementReady.trackInfo = info;
    }
  }

  assert.equal(tenthReplacementReady.weak.entries.length, replacementCount + 1);
  await cdp.send('HeapProfiler.collectGarbage');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  const diagnosticForcedGc = await snapshot('after-forced-gc-diagnostic', true);
  diagnosticForcedGc.warning = 'WeakRef/GC counts are diagnostic only; forced-GC heap and RSS do not determine memory-budget acceptance.';

  assert.deepEqual(pageErrors, []);
  const report = {
    pageErrors,
    environment: {
      appUrl: baseUrl,
      browser: browser.version(),
      mode: 'actual app, sequential 300s/48kHz/stereo WAV decode plus completed waveform build',
      heapMeasurement: 'CDP Runtime.getHeapUsage for the page target',
      livenessMeasurement: 'WeakRef.deref() booleans and scalar decode metadata; no old ArrayBuffer/AudioBuffer is retained strongly by the probe',
      encodedBufferCaveat: 'decodeAudioData detaches its input ArrayBuffer; an alive wrapper with byteLength 0 does not retain the original encoded backing store',
    },
    media: { durationSeconds, sampleRateHz, channelCount, encoding: 'PCM16 WAV silence fixture', encodedBytes: wav.byteLength },
    replacements: replacementCount,
    firstReady,
    tenthReplacementReady,
    diagnosticForcedGc,
  };
  await writeFile('/tmp/maijdata-audio-retention-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: '/tmp/maijdata-audio-retention-results.json',
    decodes: tenthReplacementReady.weak.entries.length,
    oldDecodedAliveBeforeGc: tenthReplacementReady.alive.oldDecoded,
    oldDecodedAliveAfterDiagnosticGc: diagnosticForcedGc.alive.oldDecoded }));
} finally {
  if (browser) await browser.close();
  await rm(tempDir, { recursive: true, force: true });
}
