import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, link, unlink, writeFile, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4173/';
const durationSeconds = 300;
const sampleRateHz = 48_000;
const channelCount = 2;
const bytesPerSample = 2;
const loadCount = 11; // One initial load, then ten sequential replacements.
const sampleEveryMs = 100;
const footprintEnabled = process.env.MAIJDATA_FOOTPRINT === '1';
const outputSuffix = footprintEnabled ? '-aligned' : '';
const resultPath = `/tmp/maijdata-skin-audio-resource-results${outputSuffix}.json`;
const footprintJsonPath = `/tmp/maijdata-footprint${outputSuffix}.json`;
const footprintStdoutPath = `/tmp/maijdata-footprint${outputSuffix}.stdout.log`;
const footprintStderrPath = `/tmp/maijdata-footprint${outputSuffix}.stderr.log`;
const footprintStatusPath = `/tmp/maijdata-footprint${outputSuffix}-status.json`;
const tempDir = await mkdtemp(join(tmpdir(), 'maijdata-skin-audio-v5-'));
const masterAudioPath = join(tempDir, 'audio-base.wav');
const audioPaths = [];
const dataBytes = durationSeconds * sampleRateHz * channelCount * bytesPerSample;
const wav = makeWav();
await writeFile(masterAudioPath, wav);
for (let index = 0; index < loadCount; index += 1) {
  const filename = `resource-${String(index).padStart(2, '0')}-5m.wav`;
  const path = join(tempDir, filename);
  await link(masterAudioPath, path);
  audioPaths.push({ path, filename });
}

const launchOptions = { headless: true };
if (process.env.BROWSER_EXECUTABLE) launchOptions.executablePath = process.env.BROWSER_EXECUTABLE;
let browser;
let page;
let browserCdp;
const memorySamples = [];
const skinResponses = new Map();
const pageErrors = [];
const samplingErrors = [];
let activePhase = 'browser-startup';
let startedAt = 0;
let sampling = true;
let samplingBusy = false;
let sampleTimer;
let footprintSession;
let footprintResult;

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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function processRss(pids) {
  if (!pids.length) return { byPid: {}, totalBytes: 0 };
  const output = execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  const byPid = {};
  for (const line of output.trim().split(/\n+/)) {
    const [pid, rssKb] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(rssKb)) byPid[pid] = rssKb * 1024;
  }
  return { byPid, totalBytes: Object.values(byPid).reduce((sum, bytes) => sum + bytes, 0) };
}

async function sampleProcesses(phase = activePhase) {
  if (!sampling || samplingBusy || !browserCdp) return null;
  samplingBusy = true;
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const processes = processInfo.map(({ id, type }) => ({ pid: Number(id), type })).filter(({ pid }) => Number.isInteger(pid));
    const rss = processRss(processes.map(({ pid }) => pid));
    const sampledAtEpochMs = Date.now();
    const sample = {
      sampledAt: new Date(sampledAtEpochMs).toISOString(),
      elapsedMs: sampledAtEpochMs - startedAt,
      phase,
      processes: processes.map((item) => ({ ...item, rssBytes: rss.byPid[item.pid] ?? null })),
      processCount: processes.length,
      rssBytes: rss.totalBytes,
    };
    memorySamples.push(sample);
    return sample;
  } finally {
    samplingBusy = false;
  }
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

async function waitForSkinRequests(expectedUrls) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const allResponses = expectedUrls.every((url) => skinResponses.get(url)?.status === 200);
    const imageState = await page.evaluate(() => window.__v5.skin.pending.map((item) => item.url));
    const called = expectedUrls.every((url) => imageState.includes(url));
    if (allResponses && called) return imageState;
    await sleep(50);
  }
  const missingResponses = expectedUrls.filter((url) => skinResponses.get(url)?.status !== 200);
  const missingDecodeCalls = await page.evaluate((urls) => urls.filter((url) => !window.__v5.skin.pending.some((item) => item.url === url)), expectedUrls);
  throw new Error(`Timed out waiting for required skin files; response misses=${missingResponses.length}, decode-call misses=${missingDecodeCalls.length}`);
}

async function waitForAudioReady(filename) {
  await page.waitForFunction((name) => document.querySelector('.song-info strong')?.textContent?.trim() === name,
    filename, { timeout: 180_000 });
  const info = await page.locator('.song-info p').innerText();
  assert.match(info, /300\.0 秒/);
  assert.match(info, /2 声道/);
  return info;
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function fitLinearTrend(values) {
  if (values.length < 2) return { slopeBytesPerReplacement: null, rSquared: null };
  const xs = values.map((_, index) => index);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  const numerator = xs.reduce((sum, x, index) => sum + (x - meanX) * (values[index] - meanY), 0);
  const denominator = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;
  const residual = values.reduce((sum, value, index) => sum + (value - (intercept + slope * index)) ** 2, 0);
  const total = values.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  return { slopeBytesPerReplacement: slope, rSquared: total === 0 ? 1 : 1 - residual / total };
}

async function startFootprint(browserPid, startupError = null) {
  if (!footprintEnabled) return null;
  const paths = [footprintJsonPath, footprintStdoutPath, footprintStderrPath, footprintStatusPath];
  await Promise.all(paths.map((path) => unlink(path).catch(() => {})));
  const base = {
    enabled: true,
    command: '/usr/bin/footprint',
    args: ['--sample', '0.5', '--targetChildren', '--pid', String(browserPid), '--json', footprintJsonPath],
    browserPid,
    jsonPath: footprintJsonPath,
    stdoutPath: footprintStdoutPath,
    stderrPath: footprintStderrPath,
  };
  const failed = async (error) => {
    const result = {
      ...base,
      status: 'failed',
      collectorStatus: 'failed-to-start',
      coverageStatus: 'unknown',
      error,
    };
    await Promise.all([
      writeFile(footprintStdoutPath, '').catch(() => {}),
      writeFile(footprintStderrPath, '').catch(() => {}),
      writeFootprintStatus(result),
    ]);
    return { result };
  };
  if (platform() !== 'darwin') {
    return failed('macOS footprint is only available on Darwin');
  }
  if (startupError) return failed(String(startupError));
  if (!Number.isInteger(browserPid)) {
    return failed('CDP did not report a browser PID');
  }

  const stdout = [];
  const stderr = [];
  let spawnError = null;
  let child;
  try {
    child = spawn(base.command, base.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (cause) {
    return failed(String(cause));
  }
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.on('error', (cause) => { spawnError = String(cause); });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return { base, child, stdout, stderr, closed, get spawnError() { return spawnError; }, result: null, stopPromise: null };
}

async function writeFootprintStatus(result) {
  await writeFile(footprintStatusPath, JSON.stringify(result, null, 2)).catch(() => {});
}

async function stopFootprint(session = footprintSession) {
  if (!session) return null;
  if (session.result) return session.result;
  if (session.stopPromise) return session.stopPromise;
  session.stopPromise = (async () => {
    const child = session.child;
    if (!child) return session.result;
    let requestedStopSignal = null;
    let closeResult = null;
    const waitForClose = async (timeoutMs) => {
      let timer;
      const timed = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
      const result = await Promise.race([session.closed, timed]);
      clearTimeout(timer);
      return result;
    };

    if (child.exitCode === null && child.signalCode === null) {
      requestedStopSignal = 'SIGINT';
      try { child.kill(requestedStopSignal); } catch {}
      closeResult = await waitForClose(3000);
    } else {
      closeResult = await waitForClose(0);
    }
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (closeResult || child.exitCode !== null || child.signalCode !== null) break;
      requestedStopSignal = signal;
      try { child.kill(signal); } catch {}
      closeResult = await waitForClose(signal === 'SIGTERM' ? 2000 : 1000);
    }

    await Promise.all([
      writeFile(footprintStdoutPath, Buffer.concat(session.stdout)).catch((cause) => { session.logWriteError = String(cause); }),
      writeFile(footprintStderrPath, Buffer.concat(session.stderr)).catch((cause) => { session.logWriteError = String(cause); }),
    ]);
    let jsonValid = false;
    let jsonSamples = null;
    let jsonError = null;
    let parsed = null;
    try {
      parsed = JSON.parse(await readFile(footprintJsonPath, 'utf8'));
      jsonValid = true;
      jsonSamples = Array.isArray(parsed.samples) ? parsed.samples.length : null;
    } catch (cause) {
      jsonError = String(cause);
    }
    const stderrText = Buffer.concat(session.stderr).toString('utf8');
    const analysisFailureLines = stderrText.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
      /Unable to analyze process|Failed to analyze process|Could not analyze process|analysis failed/i.test(line));
    const analysisFailurePids = [...new Set(analysisFailureLines.flatMap((line) =>
      [...line.matchAll(/process with pid (\d+)/gi)].map((match) => Number(match[1]))))].sort((a, b) => a - b);
    const jsonSampleDiagnostics = (parsed?.samples ?? []).flatMap((sample, sampleIndex) => [
      ...(sample.errors ?? []).map((detail) => ({ sampleIndex, kind: 'error', detail })),
      ...(sample.warnings ?? []).map((detail) => ({ sampleIndex, kind: 'warning', detail })),
    ]);
    const rssPidSampleCounts = {};
    for (const sample of memorySamples) {
      for (const { pid } of sample.processes) rssPidSampleCounts[pid] = (rssPidSampleCounts[pid] ?? 0) + 1;
    }
    const footprintPidSampleCounts = {};
    for (const sample of parsed?.samples ?? []) {
      for (const { pid } of sample.processes ?? []) footprintPidSampleCounts[pid] = (footprintPidSampleCounts[pid] ?? 0) + 1;
    }
    const rssPids = Object.keys(rssPidSampleCounts).map(Number).sort((a, b) => a - b);
    const footprintPids = Object.keys(footprintPidSampleCounts).map(Number).sort((a, b) => a - b);
    const missingFromFootprint = rssPids.filter((pid) => !footprintPidSampleCounts[pid]);
    const footprintOnlyPids = footprintPids.filter((pid) => !rssPidSampleCounts[pid]);
    const timedOut = !closeResult && child.exitCode === null && child.signalCode === null;
    const collectorFinished = !!closeResult || child.exitCode !== null || child.signalCode !== null;
    const collectorStatus = session.spawnError ? 'failed-to-start' : timedOut ? 'stop-timeout' : collectorFinished ? 'finished' : 'unknown';
    const nonzeroExit = closeResult?.code !== null && closeResult?.code !== undefined
      ? closeResult.code !== 0
      : child.exitCode !== null && child.exitCode !== 0;
    const coverageStatus = !jsonValid ? 'unknown'
      : analysisFailureLines.length || jsonSampleDiagnostics.length || missingFromFootprint.length || jsonSamples === null || jsonSamples === 0 || nonzeroExit ? 'partial'
        : 'complete';
    const status = collectorStatus === 'failed-to-start' ? 'failed'
      : collectorStatus !== 'finished' || !jsonValid || timedOut || (requestedStopSignal === 'SIGKILL') ? 'incomplete'
        : coverageStatus === 'partial' ? 'partial'
          : 'complete';
    const result = {
      ...session.base,
      status,
      collectorStatus,
      coverageStatus,
      requestedStopSignal,
      exitCode: closeResult?.code ?? child.exitCode,
      signal: closeResult?.signal ?? child.signalCode,
      spawnError: session.spawnError,
      nonzeroExit,
      timedOut,
      jsonValid,
      jsonSamples,
      jsonError,
      vmObjectDirtyAnalysis: parsed?.vm_object_dirty_analysis ?? null,
      coverage: {
        rssPids,
        footprintPids,
        rssPidSampleCounts,
        footprintPidSampleCounts,
        missingFromFootprint,
        footprintOnlyPids,
        analysisFailurePids,
        analysisFailureLines,
        jsonSampleDiagnostics,
      },
      logWriteError: session.logWriteError ?? null,
    };
    session.result = result;
    await writeFootprintStatus(result);
    return result;
  })();
  return session.stopPromise;
}

try {
  browser = await chromium.launch(launchOptions);
  browserCdp = await browser.newBrowserCDPSession();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    const state = {
      skin: { gate: true, pending: [], decoded: [], failures: [] },
      audioDecodes: [],
      waveformChunks: [],
    };
    Object.defineProperty(window, '__v5', { value: state });

    const imageDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const url = this.currentSrc || this.src;
      if (!state.skin.gate || !url.includes('/assets/visual-maimai/')) return imageDecode.call(this);
      return new Promise((resolve, reject) => {
        const item = {
          url,
          release() {
            imageDecode.call(this.image).then(() => {
              state.skin.decoded.push(url);
              resolve();
            }, (cause) => {
              state.skin.failures.push({ url, error: String(cause) });
              reject(cause);
            });
          },
          image: this,
        };
        state.skin.pending.push(item);
      });
    };

    const audioPrototype = window.AudioContext?.prototype;
    if (audioPrototype) {
      const decode = audioPrototype.decodeAudioData;
      audioPrototype.decodeAudioData = function (encoded, ...callbacks) {
        const startedAt = performance.now();
        return decode.call(this, encoded, ...callbacks).then((buffer) => {
          state.audioDecodes.push({
            durationMs: performance.now() - startedAt,
            sampleRateHz: buffer.sampleRate,
            frameCount: buffer.length,
            channelCount: buffer.numberOfChannels,
            durationSeconds: buffer.duration,
            decodedBytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
          });
          return buffer;
        }, (cause) => {
          state.audioDecodes.push({ durationMs: performance.now() - startedAt, error: String(cause) });
          throw cause;
        });
      };
    }

    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, transfer) {
        if (message && Number.isInteger(message.startBin) && Array.isArray(message.channels)
          && Number.isInteger(message.frameCount) && Number.isInteger(message.samplesPerBaseBin)) {
          state.waveformChunks.push({
            startBin: message.startBin,
            frameCount: message.frameCount,
            samplesPerBaseBin: message.samplesPerBaseBin,
            channelCount: message.channels.length,
          });
        }
        return super.postMessage(message, transfer);
      }
    };
  });

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/assets/visual-maimai/') && /\.(png|webp|json)(\?|$)/i.test(url))
      skinResponses.set(url, { status: response.status() });
  });

  await page.goto('about:blank');
  if (footprintEnabled) {
    try {
      const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
      const browserPid = Number(processInfo.find(({ type }) => type === 'browser')?.id);
      footprintSession = await startFootprint(browserPid);
    } catch (cause) {
      footprintSession = await startFootprint(Number.NaN, cause);
    }
  }
  await sleep(2500); // Let Chromium create its startup processes before taking the RSS baseline.
  startedAt = Date.now();
  const blankSamples = await sampleMilestone('about-blank-baseline', 11); // Span at least 1 s to align with multiple footprint samples.
  const blankRss = median(blankSamples.map((sample) => sample.rssBytes));
  sampleTimer = setInterval(() => { void sampleProcesses(activePhase).catch((cause) => samplingErrors.push(String(cause))); }, sampleEveryMs);
  sampleTimer.unref?.();

  activePhase = 'app-navigation';
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.tool-icon').first().waitFor({ timeout: 30_000 });
  const requiredSkins = await page.evaluate(async () => {
    const root = new URL('./assets/visual-maimai/', document.baseURI);
    const [main, embedded] = await Promise.all([
      fetch(new URL('manifest.json', root)).then((response) => response.json()),
      fetch(new URL('embedded/manifest.json', root)).then((response) => response.json()),
    ]);
    return [...main.assets, ...embedded.assets]
      .filter(({ key }) => /^(tap|hold|touch|touchhold)\./.test(key))
      .map((asset) => ({
        key: asset.key,
        url: new URL(asset.outputPath.replace('apps/web/public/assets/visual-maimai/', ''), root).href,
        width: asset.width,
        height: asset.height,
      }));
  });
  assert.equal(requiredSkins.length, 21, 'the resource study expects the current 21 core note sprites');
  const expectedUrls = requiredSkins.map((asset) => asset.url);
  await waitForSkinRequests(expectedUrls);
  const preDecodeSamples = await sampleMilestone('app-and-skin-bytes-before-decode');
  const preDecodeRss = median(preDecodeSamples.map((sample) => sample.rssBytes));

  activePhase = 'app-core-skin-image-decode';
  await page.evaluate(() => {
    window.__v5.skin.gate = false;
    for (const item of window.__v5.skin.pending) item.release.call(item);
  });
  await page.waitForFunction((urls) => {
    const decoded = new Set(window.__v5.skin.decoded);
    return urls.every((url) => decoded.has(url)) && window.__v5.skin.failures.length === 0;
  }, expectedUrls, { timeout: 60_000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.tool-icon')].length >= 4);
  const decodedSkinSamples = await sampleMilestone('app-core-skin-decoded');
  const skinReadyRss = median(decodedSkinSamples.map((sample) => sample.rssBytes));
  const appCoreSpritesReady = await page.evaluate(() => new Set(window.__v5.skin.decoded).size);

  activePhase = 'core-preview-startup';
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await page.locator('.document-heading .status').filter({ hasText: 'v0 ·' }).waitFor();
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor({ timeout: 120_000 });
  const previewState = await page.evaluate(() => ({
    canvasCount: document.querySelectorAll('.circular-preview-canvas canvas').length,
    distEntryScriptUrls: [...document.querySelectorAll('script[type="module"][src]')].map((script) => script.src),
    wasmResources: performance.getEntriesByType('resource')
      .filter((entry) => /\.wasm(?:\?|$)/i.test(entry.name))
      .map((entry) => ({ name: entry.name, durationMs: entry.duration, transferSize: entry.transferSize, decodedBodySize: entry.decodedBodySize })),
  }));
  assert(previewState.canvasCount > 0, 'the ready circular preview should have a rendered canvas');
  const previewReadySamples = await sampleMilestone('core-preview-ready', 4);
  const previewReadyRss = median(previewReadySamples.map((sample) => sample.rssBytes));

  const readyRss = [];
  const audioLoads = [];
  for (let index = 0; index < loadCount; index += 1) {
    const { path, filename } = audioPaths[index];
    activePhase = `audio-${String(index).padStart(2, '0')}-decode-and-waveform`;
    const before = await page.evaluate(() => ({
      decodes: window.__v5.audioDecodes.length,
      chunks: window.__v5.waveformChunks.length,
    }));
    const selectionStarted = Date.now();
    await page.getByLabel('歌曲文件', { exact: true }).setInputFiles(path);
    const trackInfo = await waitForAudioReady(filename);
    const stable = await sampleMilestone(`audio-${String(index).padStart(2, '0')}-waveform-ready`, 4);
    const after = await page.evaluate((offset) => ({
      decode: window.__v5.audioDecodes[offset.decodes] ?? null,
      decodeCount: window.__v5.audioDecodes.length - offset.decodes,
      waveformChunks: window.__v5.waveformChunks.slice(offset.chunks),
      waveformChunkCount: window.__v5.waveformChunks.length - offset.chunks,
    }), before);
    assert.equal(after.decodeCount, 1, `${filename} should be decoded once`);
    assert(!after.decode?.error, `${filename} decode failed: ${after.decode?.error ?? ''}`);
    assert(after.waveformChunkCount > 0, `${filename} should build a real waveform summary in a Worker`);
    audioLoads.push({
      index,
      filename,
      inputToWaveformReadyMs: Date.now() - selectionStarted,
      trackInfo,
      decode: after.decode,
      waveform: {
        chunkCount: after.waveformChunkCount,
        frameCount: after.waveformChunks.reduce((sum, chunk) => sum + chunk.frameCount, 0),
        inputPcmBytesTransferred: after.waveformChunks.reduce((sum, chunk) => sum + chunk.frameCount * chunk.channelCount * Float32Array.BYTES_PER_ELEMENT, 0),
        samplesPerBaseBin: after.waveformChunks.at(0)?.samplesPerBaseBin,
        channels: [...new Set(after.waveformChunks.map((chunk) => chunk.channelCount))],
        requests: after.waveformChunks,
      },
      stableRssBytes: median(stable.map((sample) => sample.rssBytes)),
    });
    readyRss.push(audioLoads.at(-1).stableRssBytes);
  }

  assert.equal(audioLoads.length, 11);
  assert(audioLoads.every((load) => Math.abs(load.decode.durationSeconds - durationSeconds) < 0.01));
  assert(audioLoads.every((load) => load.decode.channelCount === channelCount));
  assert(audioLoads.every((load) => load.waveform.chunkCount > 1));
  assert.deepEqual(pageErrors, [], 'the production app should not emit uncaught browser errors');
  const alert = await page.locator('[role="alert"]').allInnerTexts();
  assert.deepEqual(alert, [], 'the production app should not show audio or skin loading errors');

  footprintResult = await stopFootprint();
  activePhase = 'page-close';
  await page.close();
  const afterPageCloseSamples = await sampleMilestone('after-page-close', 4);
  const afterPageCloseRss = median(afterPageCloseSamples.map((sample) => sample.rssBytes));

  const validSamples = memorySamples.filter((sample) => Number.isFinite(sample.rssBytes));
  const phasePeaks = {};
  for (const sample of validSamples) phasePeaks[sample.phase] = Math.max(phasePeaks[sample.phase] ?? 0, sample.rssBytes);
  const peak = validSamples.reduce((maximum, sample) => sample.rssBytes > maximum.rssBytes ? sample : maximum, validSamples[0]);
  const trend = fitLinearTrend(readyRss);
  const report = {
    startedAtEpochMs: startedAt,
    environment: {
      appUrl: baseUrl,
      browser: browser.version(),
      mode: 'headless Chromium, actual production app, no CPU/network throttling',
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      viewport: [1440, 1000],
      deviceScaleFactor: 1,
      distEntryScriptUrls: previewState.distEntryScriptUrls,
      processMeasurement: 'CDP SystemInfo.getProcessInfo PIDs plus ps RSS; browser process set, sampled every 100 ms',
    },
    footprint: footprintResult,
    skin: {
      requiredCount: requiredSkins.length,
      requiredAssets: requiredSkins,
      appCoreSpritesReady,
      aboutBlankBaselineRssBytes: blankRss,
      appBytesBeforeSkinDecodeRssBytes: preDecodeRss,
      appSkinReadyRssBytes: skinReadyRss,
      decodedSkinIncrementBytes: skinReadyRss - preDecodeRss,
      appPlusCoreSkinOverBlankBytes: skinReadyRss - blankRss,
      corePreviewReadyRssBytes: previewReadyRss,
      previewOverSkinReadyBytes: previewReadyRss - skinReadyRss,
      corePreviewReady: true,
      previewCanvasCount: previewState.canvasCount,
      wasmResources: previewState.wasmResources,
      interpretation: 'Increment compares app with all required PNG response bodies loaded but decode() held against the same page after release. Browser may decode/cache image bytes independently; this is a process-RSS estimate, not exact decoded pixel allocation.',
    },
    audio: {
      source: 'Generated silent PCM16 WAV; loaded through the production app song file input.',
      durationSeconds,
      inputSampleRateHz: sampleRateHz,
      channelCount,
      encodedBytes: wav.byteLength,
      theoreticalFloatPcmBytes: durationSeconds * sampleRateHz * channelCount * Float32Array.BYTES_PER_ELEMENT,
      sequence: 'one initial track plus ten sequential replacements; each next selection waits until the song label shows the new track, which follows load() and buildCurrentWaveform() completion in App.openFiles().',
      loads: audioLoads,
    },
    memory: {
      sampleIntervalMs: sampleEveryMs,
      baselineRssBytes: blankRss,
      blankBaselineWindow: {
        sampleCount: blankSamples.length,
        firstSampleAt: blankSamples[0]?.sampledAt ?? null,
        lastSampleAt: blankSamples.at(-1)?.sampledAt ?? null,
        firstElapsedMs: blankSamples[0]?.elapsedMs ?? null,
        lastElapsedMs: blankSamples.at(-1)?.elapsedMs ?? null,
      },
      peakRssBytes: peak?.rssBytes ?? null,
      peakPhase: peak?.phase ?? null,
      peakDeltaFromBlankBytes: peak ? peak.rssBytes - blankRss : null,
      phasePeakRssBytes: phasePeaks,
      corePreviewReadyRssBytes: previewReadyRss,
      stableReadyRssBytes: readyRss,
      tenReplacementNetGrowthBytes: readyRss.at(-1) - readyRss[0],
      linearTrendBytesPerReplacement: trend.slopeBytesPerReplacement,
      linearTrendRSquared: trend.rSquared,
      adjacentReadySamplesIncreasing: readyRss.slice(1).filter((rss, index) => rss > readyRss[index]).length,
      afterPageCloseRssBytes: afterPageCloseRss,
      limitations: 'RSS can count shared pages more than once and includes Chromium, renderer, GPU, decoder, allocator and image-cache memory. Sampling can miss short peaks. Skin decode is gated at HTMLImageElement.decode(), but browser-internal decode/cache behavior is not fully controllable. RSS and its linear fit do not identify retained objects or prove a leak; the ten-replacement trend is a bounded observation, not a long-duration leak test.',
    },
    pageErrors,
    samplingErrors,
    memorySamples: validSamples,
  };
  await writeFile(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    reportPath: resultPath,
    browser: report.environment.browser,
    skin: { decodedSprites: report.skin.appCoreSpritesReady, decodedIncrementBytes: report.skin.decodedSkinIncrementBytes, previewReadyRssBytes: report.skin.corePreviewReadyRssBytes },
    audio: { tracks: report.audio.loads.length, durationSeconds, waveformChunksPerTrack: report.audio.loads.map(({ waveform }) => waveform.chunkCount) },
    memory: { peakRssBytes: report.memory.peakRssBytes, peakPhase: report.memory.peakPhase, tenReplacementNetGrowthBytes: report.memory.tenReplacementNetGrowthBytes, linearTrendBytesPerReplacement: report.memory.linearTrendBytesPerReplacement, linearTrendRSquared: report.memory.linearTrendRSquared, stableReadyRssBytes: report.memory.stableReadyRssBytes },
    footprint: report.footprint ? { status: report.footprint.status, collectorStatus: report.footprint.collectorStatus, coverageStatus: report.footprint.coverageStatus, analysisFailurePids: report.footprint.coverage?.analysisFailurePids ?? [], jsonPath: report.footprint.jsonPath, stdoutPath: report.footprint.stdoutPath, stderrPath: report.footprint.stderrPath, error: report.footprint.error ?? report.footprint.spawnError ?? report.footprint.jsonError ?? null } : { enabled: false },
  }, null, 2));
} finally {
  sampling = false;
  if (sampleTimer) clearInterval(sampleTimer);
  if (footprintSession && !footprintResult) footprintResult = await stopFootprint().catch((cause) => ({ enabled: true, status: 'failed', error: String(cause) }));
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const { path } of audioPaths) await unlink(path).catch(() => {});
  await unlink(masterAudioPath).catch(() => {});
  await import('node:fs/promises').then(({ rm }) => rm(tempDir, { recursive: true, force: true }));
}
