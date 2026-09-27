import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpus, platform, arch } from 'node:os';
import { unlink, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const durationSeconds = 300;
const sampleRateHz = 48_000;
const channelCount = 2;
const bytesPerSample = 2;
const dataBytes = durationSeconds * sampleRateHz * channelCount * bytesPerSample;
const audioPath = '/tmp/maijdata-audio-resource-5m-48k-stereo.wav';
const harnessPath = fileURLToPath(new URL('../fixtures/audio/resource-harness.html', import.meta.url));
const url = process.argv[2] ?? `http://127.0.0.1:5173/@fs${harnessPath}`;

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
await writeFile(audioPath, wav);

const launchOptions = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.BROWSER_EXECUTABLE;
const browser = await chromium.launch(launchOptions);
const browserCdp = await browser.newBrowserCDPSession();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const memorySamples = [];
let activePhase = 'browser-baseline';
let sampling = true;
let samplingBusy = false;

page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('__RESOURCE_PHASE__:')) activePhase = text.slice('__RESOURCE_PHASE__:'.length);
});

function readRssBytes(pids) {
  if (pids.length === 0) return 0;
  const output = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
  return output.split(/\s+/).filter(Boolean).reduce((sum, value) => sum + Number(value) * 1024, 0);
}

async function sampleProcesses(phase = activePhase) {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
  const pids = processInfo.map((entry) => entry.id);
  const rssBytes = readRssBytes(pids);
  const sample = { elapsedMs: Date.now() - startedAt, phase, processCount: pids.length, rssBytes };
  memorySamples.push(sample);
  return sample;
}

await page.goto('about:blank');
const startedAt = Date.now();
const baseline = await sampleProcesses('about:blank');
await page.goto(url);
await page.locator('#audio-file').setInputFiles(audioPath);

const runPromise = page.evaluate(async ({ durationSeconds, channelCount }) => {
  const input = document.querySelector('#audio-file');
  const file = input?.files?.[0];
  if (!file) throw new Error('5-minute WAV fixture was not attached to the page');
  const { AudioTransport } = await import('/src/audio/transport.ts');
  const context = new AudioContext();
  let decodeCalls = 0;
  let holdNextDecodeResult = false;
  let releaseDecodeResult;
  let holdPromise = Promise.resolve();
  const transport = new AudioTransport({
    context,
    metadataReader: async () => ({ durationSeconds: 300, channelCount: 2 }),
    decoder: async (encoded, audioContext) => {
      decodeCalls += 1;
      const decoded = await audioContext.decodeAudioData(encoded);
      if (holdNextDecodeResult) {
        holdNextDecodeResult = false;
        await holdPromise;
      }
      return decoded;
    },
  });
  const mark = (phase) => console.log(`__RESOURCE_PHASE__:${phase}`);
  const waitFor = async (predicate, timeoutMs = 120_000) => {
    const started = performance.now();
    while (!predicate()) {
      if (performance.now() - started > timeoutMs) throw new Error('Timed out waiting for browser audio pipeline');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  mark('initial-decode');
  const initial = await transport.load(file, 'original-5m.wav');
  if (initial.status !== 'loaded') throw new Error(`Initial WAV load failed: ${initial.status}`);
  const initialTrack = initial.track;
  const expectedDecodedBytes = context.sampleRate * durationSeconds * channelCount * Float32Array.BYTES_PER_ELEMENT;
  if (initialTrack.decodedBytes !== expectedDecodedBytes) throw new Error(`Unexpected PCM size ${initialTrack.decodedBytes}; expected ${expectedDecodedBytes}`);

  mark('waveform-summary');
  const waveform = await transport.buildCurrentWaveform(128 * 1024 * 1024);
  if (!waveform) throw new Error('Waveform summary was discarded unexpectedly');
  const waveformInfo = {
    byteLength: waveform.byteLength,
    samplesPerBaseBin: waveform.samplesPerBaseBin,
    baseBinsPerChannel: waveform.levels[0].min[0].length,
    levelCount: waveform.levels.length,
    workerChunkBins: 512,
    workerChunkCount: Math.ceil(waveform.levels[0].min[0].length / 512),
    maximumInputChunkBytes: Math.min(512, waveform.levels[0].min[0].length) * waveform.samplesPerBaseBin
      * initialTrack.channelCount * Float32Array.BYTES_PER_ELEMENT,
    cumulativeCopiedPcmBytes: initialTrack.decodedBytes,
  };

  mark('loaded-seek');
  transport.seekChartSeconds(123.456);
  const loadedSeek = transport.getSnapshot();
  if (Math.abs(loadedSeek.songSeconds - 123.456) > 0.001 || loadedSeek.track?.decodedBytes !== initialTrack.decodedBytes)
    throw new Error('Seeking a loaded track changed its software time or track metadata');

  mark('ten-replacements-one-inflight');
  const callsBeforeBatch = decodeCalls;
  holdPromise = new Promise((resolve) => { releaseDecodeResult = resolve; });
  holdNextDecodeResult = true;
  const swaps = [transport.load(file, 'swap-0.wav')];
  await waitFor(() => decodeCalls === callsBeforeBatch + 1);
  for (let index = 1; index < 10; index += 1) swaps.push(transport.load(file, `swap-${index}.wav`));
  releaseDecodeResult();
  const swapResults = await Promise.all(swaps);
  const swapStatuses = swapResults.reduce((counts, result) => ({ ...counts, [result.status]: (counts[result.status] ?? 0) + 1 }), {});
  const swapDecodeCalls = decodeCalls - callsBeforeBatch;
  const afterSwaps = transport.getSnapshot();
  if (swapDecodeCalls !== 2 || swapStatuses.loaded !== 1 || swapStatuses.superseded !== 9 || afterSwaps.track?.name !== 'swap-9.wav')
    throw new Error(`Latest-wins replacement mismatch: ${JSON.stringify({ swapDecodeCalls, swapStatuses, track: afterSwaps.track?.name })}`);

  mark('invalid-media');
  const invalid = await transport.load(new Blob([new Uint8Array([0x00, 0x01, 0x02])], { type: 'audio/wav' }), 'invalid.wav', { durationSeconds: 0.1, channelCount: 2 });
  const afterInvalid = transport.getSnapshot();
  if (invalid.status !== 'rejected' || afterInvalid.state !== 'paused' || afterInvalid.track !== null)
    throw new Error(`Invalid media did not leave a paused empty transport: ${JSON.stringify({ status: invalid.status, state: afterInvalid.state, track: afterInvalid.track?.name })}`);

  transport.dispose();
  await context.close();
  input.value = '';
  mark('disposed');
  return {
    contextSampleRateHz: initialTrack.sampleRateHz,
    loaded: initialTrack,
    waveform: waveformInfo,
    seek: { requestedChartSeconds: 123.456, actualChartSeconds: loadedSeek.chartSeconds, songSeconds: loadedSeek.songSeconds },
    replacements: { requestedCandidates: 10, decoderCalls: swapDecodeCalls, statuses: swapStatuses, finalTrackName: afterSwaps.track.name },
    invalidMedia: { status: invalid.status, error: invalid.status === 'rejected' ? invalid.error.message : '', stateAfterFailure: afterInvalid.state, trackAfterFailure: afterInvalid.track },
  };
}, { durationSeconds, channelCount });

async function collectWhileRunning() {
  if (!sampling || samplingBusy) return;
  samplingBusy = true;
  try { await sampleProcesses(); } catch (error) { memorySamples.push({ phase: activePhase, error: String(error) }); }
  finally { samplingBusy = false; }
}

const interval = setInterval(() => { void collectWhileRunning(); }, 150);
let harness;
try {
  harness = await runPromise;
} catch (error) {
  await browser.close();
  await unlink(audioPath).catch(() => {});
  throw error;
} finally {
  sampling = false;
  clearInterval(interval);
}
await sampleProcesses('disposed-after-run');
await new Promise((resolve) => setTimeout(resolve, 1_000));
const disposed = await sampleProcesses('disposed-after-1s');
await page.close();
const afterPageClose = await sampleProcesses('after-page-close');

const validSamples = memorySamples.filter((sample) => typeof sample.rssBytes === 'number');
const phasePeaks = {};
for (const sample of validSamples) phasePeaks[sample.phase] = Math.max(phasePeaks[sample.phase] ?? 0, sample.rssBytes);
const peak = validSamples.reduce((maximum, sample) => sample.rssBytes > maximum.rssBytes ? sample : maximum, baseline);
const report = {
  environment: { browser: browser.version(), mode: 'headless Chromium; no CPU/network throttling', platform: platform(), arch: arch(), cpu: cpus()[0]?.model, measurement: 'CDP SystemInfo process PIDs plus ps RSS; browser process set only' },
  media: { durationSeconds, sampleRateHz, channelCount, encoding: 'PCM16 WAV silence fixture generated in /tmp', encodedBytes: wav.byteLength, theoreticalFloatPcmBytes: durationSeconds * sampleRateHz * channelCount * Float32Array.BYTES_PER_ELEMENT },
  workload: harness,
  memory: {
    baselineBytes: baseline.rssBytes,
    peakBytes: peak.rssBytes,
    peakPhase: peak.phase,
    peakDeltaBytes: peak.rssBytes - baseline.rssBytes,
    phasePeakRssBytes: phasePeaks,
    disposedAfter1sBytes: disposed.rssBytes,
    afterPageCloseBytes: afterPageClose.rssBytes,
    samples: validSamples.length,
    sampleIntervalMs: 150,
    methodLimitations: 'Process-tree RSS is an approximation: RSS can count shared pages more than once and includes browser/GPU/runtime allocations. It is not an exact page heap or an allocator/live-PCM counter.'
  },
  memoryBudgetBytes: 512 * 1024 * 1024,
};
await writeFile('/tmp/maijdata-audio-resource-results.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

try {
  assert.equal(harness.loaded.decodedBytes, report.media.theoreticalFloatPcmBytes);
  assert(harness.waveform.byteLength <= 1024 * 1024);
  assert.equal(harness.replacements.decoderCalls, 2);
  assert.equal(harness.replacements.statuses.superseded, 9);
  assert.equal(harness.invalidMedia.trackAfterFailure, null);
  assert(report.memory.peakDeltaBytes <= report.memoryBudgetBytes, `Peak browser-process RSS delta exceeded 512 MiB: ${report.memory.peakDeltaBytes}`);
} finally {
  await browser.close();
  await unlink(audioPath).catch(() => {});
}
