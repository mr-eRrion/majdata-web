import assert from 'node:assert/strict';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { clickTimeline } from './timeline-browser-helpers.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, 'dist'));
const prefix = '/maijdata/';
const bytesPerSecond = 20_000_000 / 8;
const chunkBytes = 16 * 1024;
const requestLog = [];

const requiredReleaseFiles = [
  'index.html',
  'source.tar.gz',
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.md',
  'DEPENDENCY-LICENSES.txt',
  'wasm/DOTNET-LICENSE.txt',
  'wasm/DOTNET-THIRD-PARTY-NOTICES.txt',
];
for (const file of requiredReleaseFiles) {
  await access(path.join(releaseRoot, file));
}

const sourceArchive = path.join(releaseRoot, 'source.tar.gz');
const tar = await import('node:child_process');
const { execFile } = tar;
const archiveEntries = await new Promise((resolve, reject) => {
  execFile('tar', ['-tzf', sourceArchive], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout.split('\n').filter(Boolean));
  });
});
for (const required of [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'pnpm-lock.yaml',
  '.node-version',
  'global.json',
  'tools/dotnet/setup.sh',
  'packages/majsimai-browser/host/StrictSimaiParser.cs',
  'packages/chart-core/src/engine.ts',
  'apps/web/src/worker/chart.worker.ts',
  'tests/release-browser.mjs',
  'vendor/MajdataPlay-geometry/LICENSE',
  'apps/web/public/assets/visual-maimai/manifest.json',
  'apps/web/public/assets/visual-maimai/tap.png',
  'apps/web/public/assets/visual-maimai/embedded/hold_end.png',
]) {
  assert(archiveEntries.includes(required), `source archive is missing ${required}`);
}
assert(!archiveEntries.some((name) => /(^|\/)(node_modules|obj|bin|dist|__pycache__)(\/|$)|\.pyc$|(^|\/)\.DS_Store$/.test(name)),
  'source archive must not include dependency or generated build directories');
const dependencyLicenses = await readFile(path.join(releaseRoot, 'DEPENDENCY-LICENSES.txt'), 'utf8');
for (const packageName of ['react', 'react-dom', 'pixi.js']) {
  assert(dependencyLicenses.includes(packageName), `dependency notices are missing ${packageName}`);
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

const staticResponses = new Map();
async function cacheReleaseFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await cacheReleaseFiles(filename);
    } else if (entry.isFile()) {
      const original = await readFile(filename);
      staticResponses.set(filename, {
        original,
        compressed: gzipSync(original, { level: 6 }),
      });
    }
  }
}
await cacheReleaseFiles(releaseRoot);

let nextSendAt = 0;
let firstEditAt = Number.POSITIVE_INFINITY;
const serverStart = performance.now();
const server = http.createServer(async (request, response) => {
  const receivedAt = performance.now();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (pathname === prefix.slice(0, -1)) {
    response.writeHead(308, { location: prefix }).end();
    return;
  }
  if (!pathname.startsWith(prefix)) {
    response.writeHead(404).end();
    return;
  }

  const relativePath = pathname.slice(prefix.length);
  const filename = path.resolve(releaseRoot, relativePath || 'index.html');
  if (filename !== releaseRoot && !filename.startsWith(`${releaseRoot}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }

  const resource = staticResponses.get(filename);
  if (!resource) {
    response.writeHead(404).end();
    return;
  }
  const record = {
    path: pathname,
    status: 200,
    uncompressedBytes: resource.original.byteLength,
    compressedBytes: resource.compressed.byteLength,
    bytesSent: 0,
    receivedMs: receivedAt - serverStart,
    firstByteMs: null,
    finishedMs: null,
  };
  requestLog.push(record);

  try {
    await delay(50);
    if (response.destroyed) return;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-encoding': 'gzip',
      'content-length': resource.compressed.byteLength,
      'content-type': contentTypes.get(path.extname(filename)) ?? 'application/octet-stream',
      vary: 'accept-encoding',
    });
    for (let offset = 0; offset < resource.compressed.byteLength; offset += chunkBytes) {
      const chunk = resource.compressed.subarray(offset, Math.min(offset + chunkBytes, resource.compressed.byteLength));
      const now = performance.now();
      const sendAt = Math.max(now, nextSendAt);
      nextSendAt = sendAt + (chunk.byteLength / bytesPerSecond) * 1000;
      if (sendAt > now) await delay(sendAt - now);
      if (response.destroyed) return;
      if (record.firstByteMs === null) record.firstByteMs = performance.now() - serverStart;
      record.bytesSent += chunk.byteLength;
      if (!response.write(chunk)) {
        await new Promise((resolve) => {
          response.once('drain', resolve);
          response.once('close', resolve);
        });
      }
    }
    response.end();
    record.finishedMs = performance.now() - serverStart;
  } catch (error) {
    if (!response.destroyed) response.destroy(error);
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}${prefix}`;

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(projectRoot, '.tools/playwright');
const { chromium } = await import('@playwright/test');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
let browser;
let page;
try {
  await access(executablePath);
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const navigationStart = performance.now();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const status = page.locator('.document-heading .status');
  await page.getByRole('button', { name: '打开示例', exact: true }).click();
  await status.filter({ hasText: 'v0 ·' }).waitFor({ timeout: 30_000 });
  await page.locator('.circular-preview-panel[data-skin-ready="true"]').waitFor();
  await page.getByRole('button', { name: 'Tap', exact: true }).click();

  await clickTimeline(page, 1.75, 6);
  await status.filter({ hasText: 'v1 ·' }).waitFor({ timeout: 30_000 });
  firstEditAt = performance.now();
  const firstEditRequests = requestLog.map((request) => ({ ...request }));
  const compressedBytesAtEdit = firstEditRequests.reduce((sum, request) => sum + request.bytesSent, 0);
  const wasmRequests = firstEditRequests.filter((request) => request.path.includes('/wasm/_framework/'));
  const workerRequests = firstEditRequests.filter((request) => /\/assets\/chart\.worker-[^/]+\.js$/.test(request.path));
  const skinRequests = firstEditRequests.filter((request) => request.path.includes('/assets/visual-maimai/') && request.path.endsWith('.png'));
  assert(skinRequests.length >= 20, 'first edit must include decoded core skin and embedded Hold endpoints');
  assert(skinRequests.every((request) => request.path.startsWith(prefix)), 'skin images must load beneath the deployment prefix');
  assert(workerRequests.length > 0, 'release page did not load its chart Worker beneath /maijdata/');
  assert(wasmRequests.some((request) => request.path.endsWith('.wasm')), 'release page did not load WebAssembly beneath /maijdata/');
  assert.equal(pageErrors.length, 0, `browser page errors: ${pageErrors.join('; ')}`);

  const report = {
    deploymentPrefix: prefix,
    browserVersion: browser.version(),
    browserExecutable: executablePath,
    viewport: '1920x1080, DPR 1',
    cache: 'fresh Chromium process and context; HTTP responses use no-store',
    networkModel: {
      responseLatencyMs: 50,
      throughputMbps: 20,
      scope: 'one shared server-side response shaper includes document, main-thread assets, dedicated Worker, and WASM requests',
      limitations: '50 ms is an injected per-response server delay, not packet-level RTT; DNS, TLS, and browser-side upload latency are not modeled',
    },
    firstEditMs: Number((firstEditAt - navigationStart).toFixed(1)),
    compressedBytesAtFirstEdit: compressedBytesAtEdit,
    compressedMiBAtFirstEdit: Number((compressedBytesAtEdit / 1024 / 1024).toFixed(2)),
    initialDownloadTargetMiB: 6,
    initialDownloadTargetMet: compressedBytesAtEdit <= 6 * 1024 * 1024,
    over10MiBReviewGate: compressedBytesAtEdit > 10 * 1024 * 1024,
    wasmRequests: wasmRequests.map(({ path, compressedBytes, bytesSent, finishedMs }) => ({ path, compressedBytes, bytesSent, finishedMs })),
    workerRequests: workerRequests.map(({ path, compressedBytes, bytesSent, finishedMs }) => ({ path, compressedBytes, bytesSent, finishedMs })),
    releaseFiles: Object.fromEntries(await Promise.all(requiredReleaseFiles.map(async (file) => [
      file,
      (await stat(path.join(releaseRoot, file))).size,
    ]))),
    sourceArchiveEntries: archiveEntries.length,
    pageErrors,
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.RELEASE_REPORT_PATH) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.RELEASE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  if (page) await page.screenshot({ path: '/tmp/maijdata-release-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

assert(Number.isFinite(firstEditAt), 'first edit was not recorded');
