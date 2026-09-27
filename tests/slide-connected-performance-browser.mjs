import assert from 'node:assert/strict';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { generateConnectedLoad } from '../fixtures/charts/generate-connected-load.mjs';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const dense = process.argv.includes('--dense');
const audioMode = process.argv.includes('--audio');
const baseUrl = process.argv.find(arg => /^https?:\/\//i.test(arg)) ?? 'http://127.0.0.1:4173/';
const workload = generateConnectedLoad({ dense });
const durationSeconds = 300;
const sampleRateHz = 48_000;
const channelCount = 2;
const bytesPerSample = 2;
const audioName = 'connected-load-5m-stereo-silence.wav';
const audioDataBytes = durationSeconds * sampleRateHz * channelCount * bytesPerSample;
const audioBytes = 44 + audioDataBytes;
const audioSuffix = audioMode ? '-audio' : '';
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];
async function writeSilentWav(path) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + audioDataBytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * channelCount * bytesPerSample, 28);
  header.writeUInt16LE(channelCount * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(audioDataBytes, 40);
  const file = await open(path, 'w');
  try {
    await file.writeFile(header);
    await file.truncate(audioBytes);
  } finally {
    await file.close();
  }
  assert.equal((await stat(path)).size, audioBytes);
}

let tempDir;
let browser;
let page;
const errors = [];
const tool = name => page.getByRole('button', { name, exact: true }).click();
const version = n => page.locator('.document-heading .status').filter({ hasText: `v${n} ·` }).waitFor();
try {
  if (audioMode) {
    tempDir = await mkdtemp(join(tmpdir(), 'maijdata-slide-connected-audio-'));
    await writeSilentWav(join(tempDir, audioName));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30000);
  page.on('dialog', dialog => void dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  async function seek(seconds) {
    const measured = await page.evaluate(value => new Promise(resolve => {
      const input = document.querySelector('input[aria-label="播放位置"]');
      const started = performance.now();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles:true }));
      input.dispatchEvent(new Event('change', { bubbles:true }));
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({elapsed:performance.now()-started,
        softwareSeconds:Number.parseFloat(document.querySelector('.transport output')?.textContent ?? 'NaN')})));
    }), seconds);
    if (audioMode) assert(Math.abs(measured.softwareSeconds-seconds)<0.002,
      `software clock ${measured.softwareSeconds} must match ${seconds} within the measured two frames`);
    return measured.elapsed;
  }
  await page.addInitScript(() => {
    window.__perf = { samples: [], snapshot: null, measureStart: null, commit: null,
      waveform: { requests: [], responses: [] } };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      requests = new Map();
      isWaveform = false;
      constructor(url, options) {
        super(url, options);
        const workerUrl = String(url);
        const isChart = /chart\.worker/i.test(workerUrl);
        this.isWaveform = /waveform[.-]worker/i.test(workerUrl);
        if (!isChart && !this.isWaveform) return;
        this.addEventListener('message', ({data}) => {
          if (this.isWaveform) {
            const request = this.requests.get(data.id);
            window.__perf.waveform.responses.push({ id: data.id, startBin: data.startBin,
              frameCount: request?.frameCount, channels: request?.channels, error: data.error ?? null });
            this.requests.delete(data.id);
          }
          const request = this.requests.get(data.requestId);
          if (request) {
            window.__perf.samples.push({ type: request.type, ms:performance.now()-request.start, ok:data.ok });
            this.requests.delete(data.requestId);
          }
          if (data.ok && data.type === 'snapshot') {
            window.__perf.snapshot = data.snapshot;
            if (request?.type === 'edit' && request.commandType === 'update' && window.__perf.measureStart !== null) {
              const started = window.__perf.measureStart;
              window.__perf.measureStart = null;
              requestAnimationFrame(() => requestAnimationFrame(() => {
                window.__perf.commit = performance.now()-started;
              }));
            }
          }
        });
      }
      postMessage(message, ...rest) {
        if (this.isWaveform && message?.id) {
          const request = { id: message.id, frameCount: message.frameCount, channels: message.channels?.length ?? 0 };
          window.__perf.waveform.requests.push(request);
          this.requests.set(message.id, request);
        }
        if (message.requestId) this.requests.set(message.requestId, {
          type: message.type, commandType: message.command?.type, start:performance.now(),
        });
        super.postMessage(message, ...rest);
      }
    };
  });
  await page.goto(baseUrl);
  const readyImports=[];
  const observedReadyImports=[];
  await page.getByLabel('谱面文件', {exact:true}).evaluate(input=>input.addEventListener('change',()=>{
    window.__importStart=performance.now();
    window.__importReadyMs=null;
    const expectedName=input.files[0].name;
    const started=window.__importStart;
    const ready=()=>{
      const heading=document.querySelector('.document-heading');
      if(heading?.textContent.includes(expectedName)
        && heading.querySelector('.status')?.textContent.includes('v0 ·')
        && document.querySelector('.circular-preview-panel[data-skin-ready="true"]')) {
        requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__importReadyMs=performance.now()-started;}));
      } else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  },{capture:true}));
  for (let run=0; run<12; run++) {
    const name = `connected-load-${dense?'dense':'uniform'}-${run}.txt`;
    await page.getByLabel('谱面文件', {exact:true}).setInputFiles({ name, mimeType:'text/plain', buffer:Buffer.from(workload.text) });
    await page.locator('.document-heading').getByText(name,{exact:true}).waitFor();
    await version(0);
    await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
    observedReadyImports.push(await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-window.__importStart))))));
    await page.waitForFunction(()=>window.__importReadyMs !== null);
    readyImports.push(await page.evaluate(()=>window.__importReadyMs));
  }
  const chart = await page.evaluate(() => window.__perf.snapshot.charts.find(c=>c.difficulty===1));
  assert(chart.editable); assert.equal(chart.notes.length,1000);
  assert.equal(chart.visualChecks?.available, true, chart.visualChecks?.reason);
  assert(chart.visualChecks.results.length > 0, "performance load must exercise collision checks");
  const slides = chart.notes.filter(n=>n.kind==='slide');
  assert.equal(slides.length,100); assert(slides.every(n=>n.slidePaths.length===3));
  await page.locator('.circular-preview-canvas').evaluate(host=>host.setAttribute('data-measure-slides',''));
  let audioEvidence = null;
  if (audioMode) {
    const audioPath = join(tempDir, audioName);
    await page.getByLabel('歌曲文件', { exact:true }).setInputFiles(audioPath);
    await page.waitForFunction(name => document.querySelector('.song-info strong')?.textContent?.trim() === name,
      audioName);
    await page.waitForFunction(() => {
      const info = document.querySelector('.song-info p')?.textContent ?? '';
      const waveform = window.__perf.waveform;
      return info.includes('300.0 秒') && info.includes('48 kHz') && info.includes('2 声道')
        && waveform.requests.length > 0
        && waveform.requests.reduce((sum, request) => sum + request.frameCount, 0) === 300 * 48_000
        && waveform.responses.length === waveform.requests.length
        && waveform.responses.every(response => response.error === null);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    audioEvidence = await page.evaluate(() => {
      const info = document.querySelector('.song-info p').textContent;
      const waveform = window.__perf.waveform;
      return { info, requests: waveform.requests.length, responses: waveform.responses.length,
        framesSummarized: waveform.responses.reduce((sum, response) => sum + (response.frameCount ?? 0), 0),
        channelCounts: [...new Set(waveform.requests.map(request => request.channels))] };
    });
    assert.equal(audioEvidence.framesSummarized, durationSeconds * sampleRateHz,
      'waveform worker responses must cover all decoded song frames');
    assert.deepEqual(audioEvidence.channelCounts, [channelCount]);
    assert.equal(await page.getByRole('alert').count(), 0, 'song decode and waveform generation must complete without errors');
  }
  await seek(0);
  await tool('播放');
  if (audioMode) await page.getByRole('button', { name:'暂停', exact:true }).waitFor();
  console.log(`${dense?'dense':'uniform'}: measuring 15 seconds of playback`);
  const frames = await page.evaluate(() => new Promise(resolve=>{
    const samples=[]; let previous; let peak=0;
    const started=performance.now();
    function tick(now) {
      if(previous!==undefined) samples.push(now-previous);
      previous=now;
      peak=Math.max(peak,Number(document.querySelector('.circular-preview-canvas').dataset.slideStrips)||0);
      if(now-started>=15000) resolve({samples,peak}); else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }));
  assert(Number.isFinite(frames.peak) && frames.peak > 0, 'playback must record rendered strips');
  const softwarePositionAfterPlayback = Number.parseFloat(await page.locator('.transport output').textContent());
  if (audioMode) {
    assert(softwarePositionAfterPlayback > 10 && softwarePositionAfterPlayback < 20,
      `the 15s playback sample must remain active on the 300s song (clock=${softwarePositionAfterPlayback})`);
  }
  await tool('暂停');
  // Each route's mesh count only decreases after appearance, so new appearances are the candidate maxima.
  const onsetTimes = [...new Set(slides.map(n=>n.startSeconds-.199))].sort((a,b)=>a-b);
  const stripSweep = await page.evaluate(async ({times,verifyClock})=>{
    const input=document.querySelector('input[aria-label="播放位置"]');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    const samples=[];
    for(const seconds of times) {
      setter.call(input,String(seconds));
      input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(verifyClock) await new Promise((resolve,reject)=>{
        const deadline=performance.now()+1000;
        const check=()=>{
          const softwareSeconds=Number.parseFloat(document.querySelector('.transport output').textContent);
          if(Math.abs(softwareSeconds-seconds)<0.002) resolve();
          else if(performance.now()>=deadline) reject(new Error(`software clock ${softwareSeconds} did not reach seek target ${seconds}`));
          else requestAnimationFrame(check);
        };
        check();
      });
      samples.push({seconds,count:Number(document.querySelector('.circular-preview-canvas').dataset.slideStrips),
        softwareSeconds:Number.parseFloat(document.querySelector('.transport output').textContent)});
    }
    return samples;
  },{times:onsetTimes,verifyClock:audioMode});
  if (audioMode) assert(stripSweep.every(sample => Math.abs(sample.softwareSeconds - sample.seconds) < 0.002),
    'appearance-sweep seeks must update the software playback position to each target');
  const peak = stripSweep.reduce((best,sample)=>sample.count>best.count?sample:best,{count:0,seconds:0});
  assert(peak.count>0,'opt-in mesh counter must observe real rendered strips');
  await seek(peak.seconds);
  await page.screenshot({path:`/tmp/maijdata-slide-load-${dense?'dense':'uniform'}${audioSuffix}-peak.png`});
  const seeks=[];
  for(const seconds of [240,30,180,0,120,299,100,60,200,1]) seeks.push(await seek(seconds));

  const first=slides[0];
  await seek(Math.max(-.5,first.startSeconds-.25));
  await tool('选择'); await clickTimeline(page,first.startSeconds,first.position);
  if(await page.getByLabel('Slide 共享头路径').count()) await page.getByLabel('Slide 共享头路径').selectOption('0');
  const commits=[], feedback=[];
  for(let run=0;run<10;run++) {
    await tool('编辑连续路线');
    const dialog=page.getByRole('dialog');
    await dialog.locator('[data-preview-ready="true"]').waitFor();
    await dialog.getByRole('button',{name:'撤回末段',exact:true}).click();
    const save=dialog.getByRole('button',{name:'保存整条路线',exact:true});
    await save.evaluate(button=>{
      window.__perf.commit=null;
      window.__perf.feedback=null;
      button.addEventListener('pointerdown',()=>{
        const start=performance.now();
        requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__perf.feedback=performance.now()-start;}));
      },{once:true});
      button.addEventListener('click',()=>{window.__perf.measureStart=performance.now();},{once:true,capture:true});
    });
    await save.click();
    await version(run*2+1);
    await page.waitForFunction(()=>window.__perf.commit!==null&&window.__perf.feedback!==null);
    const result=await page.evaluate(()=>({commit:window.__perf.commit,feedback:window.__perf.feedback,
      segments:window.__perf.snapshot.charts[0].notes.find(n=>n.kind==='slide').slide.continuations.length}));
    assert.equal(result.segments,2);
    commits.push(result.commit); feedback.push(result.feedback);
    await tool('撤销 ⌘Z'); await version(run*2+2);
    await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  }
  const samples=await page.evaluate(()=>window.__perf.samples);
  const imports=samples.filter(s=>s.type==='import').slice(2);
  assert.equal(imports.length,10); assert.equal(readyImports.length,12); assert(imports.every(s=>s.ok)); assert.deepEqual(errors,[]);
  const report={
    environment:{browser:browser.version(),mode:`headless foreground, no CPU/network throttling, ${audioMode?'loaded 300s/48kHz/stereo silent WAV':'no media'}`,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,viewport:[1920,1080],dpr:1,entry:await page.locator('script[type="module"]').getAttribute('src')},
    workload:workload.workload,
    visualChecks:{available:chart.visualChecks.available,resultCount:chart.visualChecks.results.length},
    role:dense?'dense Slide stress observation':'uniform mixed 1k workload',
    warmImportReady:{samples:readyImports.length-2,p95Ms:percentile(readyImports.slice(2),.95),scope:`native file change through matching document v0, skin-ready and two animation frames, measured inside the page; ${audioMode?'song is loaded afterward':'no media loaded'}`},
    automationObservedReady:{samples:observedReadyImports.length-2,p95Ms:percentile(observedReadyImports.slice(2),.95),scope:'previous polling-based metric, retained for comparison; includes automation round trips'},
    warmImport:{samples:imports.length,medianMs:percentile(imports.map(s=>s.ms),.5),p95Ms:percentile(imports.map(s=>s.ms),.95),scope:`postMessage through WASM/Core to snapshot; excludes file read, React paint and skin preload; ${audioMode?'song is loaded afterward':'no media loaded'}`},
    frames:{durationMs:15000,count:frames.samples.length,medianMs:percentile(frames.samples,.5),p95Ms:percentile(frames.samples,.95),over33_3Fraction:frames.samples.filter(ms=>ms>33.3).length/frames.samples.length},
    visibleStrips:{playbackPeak:frames.peak,appearanceSweepPeak:peak,samples:stripSweep.length,scope:'actual nonzero-alpha Pixi line meshes; Wi-Fi arrows and stars excluded; opt-in counter only'},
    seek:{p95Ms:percentile(seeks,.95),scope:`input event to two animation frames; ${audioMode?'loaded 300s song and checked software clock against each requested target':'no loaded media'}`},
    ...(audioMode ? { audio:{file:audioName,encodedBytes:audioBytes,durationSeconds,sampleRateHz,channelCount,
      waveformChunks:audioEvidence.requests,waveformResponses:audioEvidence.responses,
      summarizedFrames:audioEvidence.framesSummarized,channelCounts:audioEvidence.channelCounts,
      softwarePositionAfter15sPlayback:softwarePositionAfterPlayback,scope:'actual decoded silent WAV and completed waveform-worker summary; validates software clock only, not physical audio/video synchronization'} } : {}),
    inputFeedback:{samples:feedback.length,p95Ms:percentile(feedback,.95),scope:'route-save pointerdown to two animation frames'},
    routeCommit:{samples:commits.length,p95Ms:percentile(commits,.95),scope:'real save click through Worker snapshot and two animation frames; one segment removed, then undone'},
    errors,
  };
  await writeFile(`/tmp/maijdata-slide-performance-${dense?'dense':'uniform'}${audioSuffix}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    if (tempDir) await rm(tempDir, { recursive:true, force:true });
  }
}
