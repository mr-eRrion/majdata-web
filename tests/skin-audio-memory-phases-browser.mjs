import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173/';
const durationSeconds = 300;
const sampleRateHz = 48_000;
const channelCount = 2;
const bytesPerSample = 2;
const sampleEveryMs = 100;
const resultPath = '/tmp/maijdata-skin-audio-memory-phases.json';
const tempDir = await mkdtemp(join(tmpdir(), 'maijdata-audio-memory-phase-'));
const audioPath = join(tempDir, 'single-5m-stereo.wav');
const filename = 'single-5m-stereo.wav';
const dataBytes = durationSeconds * sampleRateHz * channelCount * bytesPerSample;

function makeWav() {
  const file = Buffer.alloc(44 + dataBytes);
  file.write('RIFF', 0);
  file.writeUInt32LE(36 + dataBytes, 4);
  file.write('WAVE', 8);
  file.write('fmt ', 12);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(channelCount, 22);
  file.writeUInt32LE(sampleRateHz, 24);
  file.writeUInt32LE(sampleRateHz * channelCount * bytesPerSample, 28);
  file.writeUInt16LE(channelCount * bytesPerSample, 32);
  file.writeUInt16LE(bytesPerSample * 8, 34);
  file.write('data', 36);
  file.writeUInt32LE(dataBytes, 40);
  return file;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}
function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

async function indexFileHash() {
  const bytes = await readFile(resolve('dist/index.html'));
  return { sha256: sha256(bytes), bytes: bytes.byteLength };
}

let wav = makeWav();
const encodedBytes = wav.byteLength;
await writeFile(audioPath, wav);
wav = null;
const executablePath = process.env.BROWSER_EXECUTABLE ?? null;
const executableSha256 = executablePath ? sha256(await readFile(executablePath)) : null;
const distIndexAtStart = await indexFileHash();
const servedIndexResponse = await fetch(baseUrl);
assert.equal(servedIndexResponse.status, 200, `preview index request failed: ${servedIndexResponse.status}`);
const servedIndexBytes = new Uint8Array(await servedIndexResponse.arrayBuffer());
const servedIndex = { sha256: sha256(servedIndexBytes), bytes: servedIndexBytes.byteLength };

const launchOptions = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.BROWSER_EXECUTABLE;
let browser;
let page;
let browserCdp;
let activePhase = 'browser-startup';
let startedAt = 0;
let sampling = true;
let samplingBusy = false;
let sampleTimer;
const memorySamples = [];
const phaseEvents = [];
const samplingErrors = [];
const pageErrors = [];

function processRss(pids) {
  if (!pids.length) return {};
  const output = execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const byPid = {};
  for (const line of output.trim().split(/\n+/)) {
    const [pid, rssKb] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(rssKb)) byPid[pid] = rssKb * 1024;
  }
  return byPid;
}

async function sampleProcesses(phase = activePhase) {
  if (!sampling || samplingBusy || !browserCdp) return null;
  samplingBusy = true;
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const processes = processInfo
      .map(({ id, type }) => ({ pid: Number(id), type }))
      .filter(({ pid }) => Number.isInteger(pid));
    const byPid = processRss(processes.map(({ pid }) => pid));
    const sampledProcesses = processes.map(({ pid, type }) => ({
      pid,
      type,
      rssBytes: byPid[pid] ?? null,
    }));
    const groups = {};
    for (const process of sampledProcesses) {
      if (process.rssBytes === null) continue;
      groups[process.type] = (groups[process.type] ?? 0) + process.rssBytes;
    }
    const rssBytes = sampledProcesses.reduce((sum, process) => sum + (process.rssBytes ?? 0), 0);
    const groupedRssBytes = Object.values(groups).reduce((sum, bytes) => sum + bytes, 0);
    const sample = {
      elapsedMs: Date.now() - startedAt,
      phase,
      processCount: processes.length,
      sampledProcessCount: sampledProcesses.filter((process) => process.rssBytes !== null).length,
      rssBytes,
      groupedRssBytes,
      groupingDeltaBytes: rssBytes - groupedRssBytes,
      groupTotalsBytes: groups,
      processes: sampledProcesses,
    };
    memorySamples.push(sample);
    return sample;
  } finally {
    samplingBusy = false;
  }
}

async function capturePhase(phase, details = {}) {
  activePhase = phase;
  let sample = null;
  while (!sample) {
    sample = await sampleProcesses(phase);
    if (!sample) await sleep(10);
  }
  phaseEvents.push({ elapsedMs: sample.elapsedMs, phase, details, sampleIndex: memorySamples.length - 1 });
  return { elapsedMs: sample.elapsedMs, sampleIndex: memorySamples.length - 1 };
}

async function sampleMilestone(phase, count = 4) {
  activePhase = phase;
  const result = [];
  while (result.length < count) {
    const sample = await sampleProcesses(phase);
    if (sample) result.push(sample);
    else await sleep(10);
    if (result.length < count) await sleep(sampleEveryMs);
  }
  return result;
}

function summarizeSamples(samples) {
  const allTypes = [...new Set(samples.flatMap((sample) => Object.keys(sample.groupTotalsBytes)))].sort();
  const perProcessTypeRssBytes = Object.fromEntries(allTypes.map((type) => [
    type,
    median(samples.map((sample) => sample.groupTotalsBytes[type] ?? 0)),
  ]));
  const rssBytes = median(samples.map((sample) => sample.rssBytes));
  const groupedRssBytes = median(samples.map((sample) => sample.groupedRssBytes));
  return {
    samples: samples.length,
    rssBytes,
    perProcessTypeRssBytes,
    medianGroupSumBytes: groupedRssBytes,
    medianGroupSumDeltaBytes: median(samples.map((sample) => sample.groupingDeltaBytes)),
    maxUnsampledProcessCount: Math.max(...samples.map((sample) => sample.processCount - sample.sampledProcessCount)),
  };
}

try {
  browser = await chromium.launch(launchOptions);
  browserCdp = await browser.newBrowserCDPSession();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.exposeFunction('__reportMemoryPhase', async (phase, details = {}) => capturePhase(phase, details));
  await page.addInitScript(() => {
    const state = { decodeEvents: [], waveformRequests: [], waveformResponses: [], workersTerminated: 0 };
    Object.defineProperty(window, '__audioMemoryProbe', { value: state });

    const originalDecode = window.AudioContext?.prototype.decodeAudioData;
    if (originalDecode) {
      window.AudioContext.prototype.decodeAudioData = function (encoded, ...callbacks) {
        const encodedBytes = encoded?.byteLength ?? null;
        return window.__reportMemoryPhase('decode-start', { encodedBytes }).then(() => {
          const decodeStartedAt = performance.now();
          state.decodeEvents.push({ event: 'start', elapsedMs: performance.now(), encodedBytes });
          return originalDecode.call(this, encoded, ...callbacks).then(async (buffer) => {
            const decode = {
              event: 'complete',
              durationMs: performance.now() - decodeStartedAt,
              sampleRateHz: buffer.sampleRate,
              frameCount: buffer.length,
              channelCount: buffer.numberOfChannels,
              durationSeconds: buffer.duration,
              decodedBytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
            };
            state.decodeEvents.push(decode);
            await window.__reportMemoryPhase('decode-complete', decode);
            return buffer;
          }, async (cause) => {
            state.decodeEvents.push({ event: 'failed', error: String(cause) });
            await window.__reportMemoryPhase('decode-failed', { error: String(cause) });
            throw cause;
          });
        });
      };
    }

    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        this.__memoryProbeWaveform = false;
        this.addEventListener('message', (event) => {
          const message = event.data;
          if (message && Number.isInteger(message.startBin) && Number.isInteger(message.id)
            && (Array.isArray(message.min) || message.error)) {
            state.waveformResponses.push({
              id: message.id,
              startBin: message.startBin,
              channelCount: Array.isArray(message.min) ? message.min.length : null,
              error: message.error ?? null,
            });
          }
        });
      }

      postMessage(message, transfer) {
        if (message && Number.isInteger(message.startBin) && Array.isArray(message.channels)
          && Number.isInteger(message.frameCount) && Number.isInteger(message.samplesPerBaseBin)) {
          this.__memoryProbeWaveform = true;
          state.waveformRequests.push({
            id: message.id,
            startBin: message.startBin,
            frameCount: message.frameCount,
            samplesPerBaseBin: message.samplesPerBaseBin,
            channelCount: message.channels.length,
          });
          if (state.waveformRequests.length === 1) {
            void window.__reportMemoryPhase('waveform-chunks', {
              firstStartBin: message.startBin,
              frameCount: message.frameCount,
              channelCount: message.channels.length,
            }).catch(() => {});
          }
        }
        return super.postMessage(message, transfer);
      }

      terminate() {
        if (this.__memoryProbeWaveform) state.workersTerminated += 1;
        return super.terminate();
      }
    };
  });

  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('about:blank');
  await page.waitForTimeout(2500); // Let browser-owned WebUI targets finish their startup.
  const blankTargets = (await browserCdp.send('Target.getTargets')).targetInfos.map(({ type, url, targetId }) => ({ type, url, targetId }));
  const blankPages = browser.contexts().map((context) => context.pages().map((page) => page.url()));
  const blankProcessInfo = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
  const blankProcessCommands = execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-p', blankProcessInfo.map(({ id }) => id).join(',')], { encoding: 'utf8' });
  startedAt = Date.now();
  const aboutBlank = await sampleMilestone('about-blank-baseline');
  sampleTimer = setInterval(() => {
    void sampleProcesses(activePhase).catch((cause) => samplingErrors.push(String(cause)));
  }, sampleEveryMs);
  sampleTimer.unref?.();

  activePhase = 'app-navigation-and-startup';
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.tool-icon').first().waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await page.locator('.document-heading .status').filter({ hasText: 'v0 ·' }).waitFor();
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor({ timeout: 120_000 });
  const previewReady = await sampleMilestone('app-and-preview-ready');

  const beforeInput = await sampleMilestone('before-audio-file-selection');
  await capturePhase('file-selection-and-read');
  const inputStartedAt = Date.now();
  await page.getByLabel('歌曲文件', { exact: true }).setInputFiles(audioPath);
  await page.waitForFunction((name) => document.querySelector('.song-info strong')?.textContent?.trim() === name,
    filename, { timeout: 180_000 });
  const trackInfo = await page.locator('.song-info p').innerText();
  assert.match(trackInfo, /300\.0 秒/);
  assert.match(trackInfo, /2 声道/);
  await capturePhase('waveform-complete', { trackInfo });
  const stable = await sampleMilestone('stable-after-waveform', 5);

  const probe = await page.evaluate(() => ({
    decodeEvents: window.__audioMemoryProbe.decodeEvents,
    waveformRequests: window.__audioMemoryProbe.waveformRequests,
    waveformResponses: window.__audioMemoryProbe.waveformResponses,
    workersTerminated: window.__audioMemoryProbe.workersTerminated,
  }));
  assert.equal(probe.decodeEvents.filter((event) => event.event === 'start').length, 1, 'expected one decode start');
  assert.equal(probe.decodeEvents.filter((event) => event.event === 'complete').length, 1, 'expected one decode completion');
  assert.equal(probe.decodeEvents.filter((event) => event.event === 'failed').length, 0, 'decode should succeed');
  assert(probe.waveformRequests.length > 0, 'waveform worker should receive chunks');
  assert.equal(probe.waveformResponses.length, probe.waveformRequests.length, 'each waveform request should receive one response');
  assert(probe.waveformResponses.every((response) => !response.error), 'waveform worker should not report errors');
  assert.equal(probe.workersTerminated, 1, 'waveform worker should be disposed once');
  assert.deepEqual(pageErrors, [], 'the app should not emit uncaught browser errors');
  assert.deepEqual(await page.locator('[role="alert"]').allInnerTexts(), [], 'the app should not show errors');

  const validSamples = memorySamples.filter((sample) => Number.isFinite(sample.rssBytes));
  const failedSumChecks = validSamples.filter((sample) => sample.groupingDeltaBytes !== 0);
  assert.deepEqual(failedSumChecks, [], 'sum by process type should equal total process RSS');
  const phaseNames = [
    'about-blank-baseline', 'app-navigation-and-startup', 'app-and-preview-ready', 'before-audio-file-selection',
    'decode-start', 'decode-complete', 'waveform-chunks', 'waveform-complete', 'stable-after-waveform',
  ];
  const phaseSummaries = Object.fromEntries(phaseNames.map((phase) => {
    const samples = validSamples.filter((sample) => sample.phase === phase);
    return [phase, samples.length ? summarizeSamples(samples) : null];
  }));
  const peakByPhaseAndType = {};
  for (const sample of validSamples) {
    const target = peakByPhaseAndType[sample.phase] ??= {};
    for (const [type, bytes] of Object.entries(sample.groupTotalsBytes)) target[type] = Math.max(target[type] ?? 0, bytes);
  }
  const peak = validSamples.reduce((maximum, sample) => sample.rssBytes > maximum.rssBytes ? sample : maximum, validSamples[0]);
  const distIndexAtEnd = await indexFileHash();
  const report = {
    environment: {
      appUrl: baseUrl, executablePath, executableSha256, blankTargets, blankPages, blankProcessCommands,
      browser: browser.version(),
      mode: 'headless Chromium, one real production-app audio import; no CPU/network throttling and no forced GC',
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      viewport: [1440, 1000],
      deviceScaleFactor: 1,
      distIndexAtStart,
      servedIndex,
      distIndexAtEnd,
      distIndexUnchanged: distIndexAtStart.sha256 === distIndexAtEnd.sha256,
      processMeasurement: 'CDP SystemInfo.getProcessInfo PID/type plus ps RSS; group totals are summed from the same sampled PID RSS values.',
      sampleIntervalMs: sampleEveryMs,
      noForcedGarbageCollection: true,
    },
    audio: {
      source: 'Generated silent PCM16 WAV; loaded once through the production song file input.',
      filename,
      durationSeconds,
      inputSampleRateHz: sampleRateHz,
      channelCount,
      encodedBytes,
      theoreticalFloatPcmBytes: durationSeconds * sampleRateHz * channelCount * Float32Array.BYTES_PER_ELEMENT,
      inputToWaveformReadyMs: Date.now() - inputStartedAt,
      trackInfo,
      decodeEvents: probe.decodeEvents,
      waveform: {
        requests: probe.waveformRequests,
        responses: probe.waveformResponses,
        requestCount: probe.waveformRequests.length,
        responseCount: probe.waveformResponses.length,
        workersTerminated: probe.workersTerminated,
        inputPcmBytesTransferred: probe.waveformRequests.reduce((sum, chunk) => sum + chunk.frameCount * chunk.channelCount * Float32Array.BYTES_PER_ELEMENT, 0),
      },
    },
    memory: {
      totalSamples: validSamples.length,
      blankRssBytes: summarizeSamples(aboutBlank).rssBytes,
      previewReady: summarizeSamples(previewReady),
      beforeInput: summarizeSamples(beforeInput),
      phases: phaseSummaries,
      peakRssBytes: peak?.rssBytes ?? null,
      peakPhase: peak?.phase ?? null,
      peakDeltaFromPreviewReadyBytes: peak ? peak.rssBytes - summarizeSamples(previewReady).rssBytes : null,
      peakByPhaseAndProcessTypeRssBytes: peakByPhaseAndType,
      processGroupSumCheck: {
        samplesChecked: validSamples.length,
        failedSamples: failedSumChecks.length,
        allMatch: failedSumChecks.length === 0,
        maximumAbsoluteDeltaBytes: Math.max(0, ...validSamples.map((sample) => Math.abs(sample.groupingDeltaBytes))),
      },
      limitations: 'RSS is a process-resident estimate and may double-count shared pages. It includes Chromium renderer, GPU, decoder, allocator and cache memory; it does not identify retained JS objects or GPU-only memory. CDP-to-ps sampling can miss short peaks and processes may exit between enumeration and ps. No forced GC was used; stable RSS is not proof of a leak or of release. The exposed phase hooks add small boundary-sampling overhead and the input is silent PCM16 WAV, not a representative codec corpus.',
      samples: validSamples,
    },
    phaseEvents,
    pageErrors,
    samplingErrors,
  };
  await writeFile(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    reportPath: resultPath,
    browser: report.environment.browser,
    distIndexAtStart: report.environment.distIndexAtStart,
    servedIndex: report.environment.servedIndex,
    distIndexUnchanged: report.environment.distIndexUnchanged,
    audio: {
      encodedBytes: report.audio.encodedBytes,
      theoreticalFloatPcmBytes: report.audio.theoreticalFloatPcmBytes,
      decodeDurationMs: probe.decodeEvents.find((event) => event.event === 'complete')?.durationMs,
      waveformChunks: report.audio.waveform.requestCount,
    },
    memory: {
      previewReady: report.memory.previewReady,
      beforeInput: report.memory.beforeInput,
      phases: report.memory.phases,
      peakRssBytes: report.memory.peakRssBytes,
      peakPhase: report.memory.peakPhase,
      processGroupSumCheck: report.memory.processGroupSumCheck,
    },
  }, null, 2));
} finally {
  sampling = false;
  if (sampleTimer) clearInterval(sampleTimer);
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await rm(tempDir, { recursive: true, force: true });
}
