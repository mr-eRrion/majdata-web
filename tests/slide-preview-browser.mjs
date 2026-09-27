import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5175/';
const reportPath = '/tmp/maijdata-slide-preview-results.json';
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const notes = [
  { id: 'straight-1-5', command: '-', position: 1, endPosition: 5 },
  { id: 'arc-2-6', command: '<', position: 2, endPosition: 6 },
  { id: 'wifi-1-5', command: 'w', position: 1, endPosition: 5 },
].map(({ id, command, position, endPosition }) => ({
  id,
  kind: 'slide',
  beat: { numerator: 0, denominator: 1 },
  position,
  order: 0,
  modifiers: { break: false, ex: false },
  slide: {
    command,
    endPosition,
    head: 'star',
    slideBreak: false,
    wait: { kind: 'seconds', seconds: 0.5 },
    move: { kind: 'seconds', seconds: 1 },
  },
  startSeconds: 0,
  moveStartSeconds: 0.5,
  endSeconds: 1.5,
  bpm: 120,
}));

try {
  await page.goto(baseUrl);
  const rendered = await page.evaluate(async (notes) => {
    const pixiSource = await (await fetch('/src/skin/pixi.ts')).text();
    const pixiSpecifier = pixiSource.match(/from ["']([^"']*pixi__js[^"']*)["']/)?.[1];
    if (!pixiSpecifier) throw new Error('Could not resolve the Vite Pixi module URL');
    const { Application } = await import(pixiSpecifier);
    const { PixiSlideLayer, preloadSlideTextures } = await import('/src/skin/pixi-slide.ts');

    const app = new Application();
    await app.init({
      width: 640,
      height: 640,
      autoStart: false,
      backgroundColor: 0x202020,
      preference: 'webgl',
      preserveDrawingBuffer: true,
    });
    document.body.appendChild(app.canvas);
    await preloadSlideTextures(notes);

    const canvasPixels = async (dataUrl) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 640;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, 640, 640).data;
    };
    const changedPixels = (left, right) => {
      let changed = 0;
      for (let offset = 0; offset < left.length; offset += 4) {
        if (Math.max(
          Math.abs(left[offset] - right[offset]),
          Math.abs(left[offset + 1] - right[offset + 1]),
          Math.abs(left[offset + 2] - right[offset + 2]),
        ) > 10) changed += 1;
      }
      return changed;
    };
    const capture = () => {
      app.render();
      return app.canvas.toDataURL('image/png');
    };

    let layer = new PixiSlideLayer();
    app.stage.addChild(layer.container);
    layer.render([], 0.25, 320, 320, 45);
    const blankPng = capture();
    const blankPixels = await canvasPixels(blankPng);
    const cases = [];
    let wifiParts = null;

    for (const note of notes) {
      const stages = [];
      for (const [name, now] of [
        ['before-hit', -0.1],
        ['waiting', 0.25],
        ['moving', 1],
        ['ended', 1.5],
        ['seek-waiting', 0.25],
      ]) {
        layer.render([note], now, 320, 320, 45);
        const png = capture();
        const pixels = await canvasPixels(png);
        stages.push({ name, now, png, changedPixels: changedPixels(pixels, blankPixels) });

        if (note.slide.command === 'w' && name === 'moving') {
          const arrowParts = layer.arrows?.notes?.get(note.id)?.parts ?? [];
          const starParts = layer.stars?.notes?.get(note.id)?.parts ?? [];
          const keys = [...arrowParts, ...starParts].map(({ signature }) => signature.split(':', 1)[0]);
          wifiParts = {
            totalSprites: keys.length,
            arrows: keys.filter((key) => key.startsWith('wifi.')).length,
            stars: keys.filter((key) => key.startsWith('star.')).length,
          };
        }
      }

      const waiting = stages.find((stage) => stage.name === 'waiting');
      layer.render([note], waiting.now, 320, 320, 45);
      const replayPng = capture();
      const replayPixels = await canvasPixels(replayPng);
      const seek = stages.find((stage) => stage.name === 'seek-waiting');
      const moving = stages.find((stage) => stage.name === 'moving');
      cases.push({
        id: note.id,
        command: note.slide.command,
        stages,
        waitMovePixelDifference: changedPixels(
          await canvasPixels(waiting.png),
          await canvasPixels(moving.png),
        ),
        seekMatchesWaitPng: seek.png === waiting.png,
        replayMatchesWaitPng: replayPng === waiting.png,
        replayChangedPixels: changedPixels(replayPixels, blankPixels),
      });
    }

    const wifi = notes.find((note) => note.slide.command === 'w');
    layer.destroy();
    layer = new PixiSlideLayer();
    app.stage.addChild(layer.container);
    layer.render([wifi], 0.25, 320, 320, 45);
    const rebuiltPng = capture();
    const rebuiltPixels = await canvasPixels(rebuiltPng);
    const wifiWaiting = cases.find((item) => item.command === 'w').stages.find((stage) => stage.name === 'waiting');
    const rebuild = {
      matchesWifiWaitPng: rebuiltPng === wifiWaiting.png,
      changedPixels: changedPixels(rebuiltPixels, blankPixels),
      png: rebuiltPng,
    };

    layer.destroy();
    app.destroy(true, { children: true, texture: false, textureSource: false });
    return { cases, blankPng, wifiParts, rebuild };
  }, notes);

  const report = {
    status: 'pass',
    baseUrl,
    browserVersion: browser.version(),
    dimensions: '640x640',
    notes: rendered.cases.map(({ id, command, stages, waitMovePixelDifference, seekMatchesWaitPng,
      replayMatchesWaitPng, replayChangedPixels }) => ({
      id,
      command,
      stages: stages.map(({ name, now, changedPixels, png }) => {
        const bytes = Buffer.from(png.split(',')[1], 'base64');
        const path = `/tmp/maijdata-slide-preview-${id}-${name}.png`;
        return writeFile(path, bytes).then(() => ({
          name,
          now,
          changedPixels,
          path,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          byteLength: bytes.byteLength,
        }));
      }),
      waitMovePixelDifference,
      seekMatchesWaitPng,
      replayMatchesWaitPng,
      replayChangedPixels,
    })),
    wifiMidpointSpriteCounts: rendered.wifiParts,
    rebuildWithCachedTextures: rendered.rebuild,
    pageErrors,
    limitations: ['没有目标参考图；只验证可见性、状态差异、绝对时间 seek 和缓存重建，不声明像素一致。'],
  };

  for (const note of report.notes) note.stages = await Promise.all(note.stages);
  const blankBytes = Buffer.from(rendered.blankPng.split(',')[1], 'base64');
  report.blank = {
    path: '/tmp/maijdata-slide-preview-blank.png',
    sha256: createHash('sha256').update(blankBytes).digest('hex'),
    byteLength: blankBytes.byteLength,
  };
  await writeFile(report.blank.path, blankBytes);
  const rebuildBytes = Buffer.from(report.rebuildWithCachedTextures.png.split(',')[1], 'base64');
  report.rebuildWithCachedTextures.png = undefined;
  report.rebuildWithCachedTextures.path = '/tmp/maijdata-slide-preview-wifi-rebuilt.png';
  report.rebuildWithCachedTextures.sha256 = createHash('sha256').update(rebuildBytes).digest('hex');
  report.rebuildWithCachedTextures.byteLength = rebuildBytes.byteLength;
  await writeFile(report.rebuildWithCachedTextures.path, rebuildBytes);

  let failure;
  try {
    for (const note of report.notes) {
      const stage = (name) => note.stages.find((item) => item.name === name);
      assert(stage('before-hit').changedPixels > 0, `${note.id}: pre-hit frame is blank`);
      assert(stage('waiting').changedPixels > 100, `${note.id}: waiting frame is blank`);
      assert(stage('moving').changedPixels > 100, `${note.id}: moving frame is blank`);
      assert(stage('ended').changedPixels === 0, `${note.id}: ended frame is not blank`);
      assert(note.waitMovePixelDifference > 0, `${note.id}: wait and move frames are identical`);
      assert(note.seekMatchesWaitPng, `${note.id}: backward seek did not reproduce the waiting PNG bytes`);
      assert(note.replayMatchesWaitPng, `${note.id}: a repeated waiting render did not reproduce the PNG bytes`);
    }
    assert.deepEqual(report.wifiMidpointSpriteCounts, { totalSprites: 9, arrows: 6, stars: 3 });
    assert(report.rebuildWithCachedTextures.matchesWifiWaitPng, 'rebuilt layer did not reproduce the Wi-Fi waiting PNG bytes');
    assert(report.rebuildWithCachedTextures.changedPixels > 100, 'rebuilt Wi-Fi waiting frame is blank');
    assert.deepEqual(pageErrors, [], 'browser reported page errors');
  } catch (error) {
    failure = error;
    report.status = 'fail';
    report.failure = error instanceof Error ? error.message : String(error);
  }

  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    reportPath,
    pngCount: report.notes.reduce((sum, note) => sum + note.stages.length, 0) + 2,
    cases: report.notes.map(({ id, stages, waitMovePixelDifference, seekMatchesWaitPng }) => ({
      id,
      changedPixels: Object.fromEntries(stages.map(({ name, changedPixels }) => [name, changedPixels])),
      waitMovePixelDifference,
      seekMatchesWaitPng,
    })),
    wifiMidpointSpriteCounts: report.wifiMidpointSpriteCounts,
    rebuildWithCachedTextures: report.rebuildWithCachedTextures,
    pageErrors,
  }));
  if (failure) throw failure;
} finally {
  await browser.close();
}
