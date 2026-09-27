import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5175/');
  const cases = await page.evaluate(async root => {
    const { createMajSimaiParser } = await import(`/@fs${root}packages/majsimai-browser/src/bridge.ts`);
    const { ChartEngine } = await import(`/@fs${root}packages/chart-core/src/engine.ts`);
    const parser = await createMajSimaiParser(new URL('/wasm/', location.href));
    const engine = new ChartEngine(text => parser.parse(text));
    const output = [];
    for (const command of ['v', 's', 'z']) for (let start = 1; start <= 8; start++) for (let end = 1; end <= 8; end++) {
      const token = `${start}${command}${end}[4:2]`;
      const text = `&first=0\n&inote_1=(120){4}${token},E\n`;
      const generation = token;
      const snapshot = await engine.import(new TextEncoder().encode(text), generation);
      const chart = snapshot.charts[0];
      const note = chart.notes[0];
      const result = { token, command, start, end, editable: chart.editable,
        diagnostics: chart.diagnostics.map(d => d.code), notes: chart.notes.length };
      if (chart.editable) {
        const changed = engine.apply({ generation, baseVersion: 0, requestId: 1,
          command: { type: 'update', difficulty: 1, changes: [{ id: note.id, patch: { slide: { ...note.slide, slideBreak: true } } }] } });
        const exported = await engine.export(generation, changed.version);
        const reopened = await engine.import(exported.bytes, `${generation}-reopened`);
        result.exported = exported.text;
        result.note = reopened.charts[0].notes[0];
      } else {
        result.preserved = (await engine.export(generation, 0)).text === text;
      }
      output.push(result);
    }
    return output;
  }, root);
  let accepted = 0;
  for (const result of cases) {
    const distance = (result.end - result.start + 8) % 8;
    const supported = result.command === 'v' ? distance !== 0 && distance !== 4 : distance === 4;
    assert.equal(result.editable, supported, JSON.stringify(result));
    if (!supported) {
      assert.equal(result.notes, 0, result.token);
      assert.equal(result.preserved, true, result.token);
      assert(result.diagnostics.includes('unsupported-slide-path'), JSON.stringify(result));
      continue;
    }
    accepted++;
    assert.equal(result.notes, 1);
    assert(result.exported.includes(`${result.start}${result.command}${result.end}b[4:2]`), result.exported);
    assert.equal(result.note.position, result.start);
    assert.equal(result.note.slide.command, result.command);
    assert.equal(result.note.slide.endPosition, result.end);
    assert.equal(result.note.slide.slideBreak, true);
    assert.equal(result.note.moveStartSeconds, .5);
    assert.equal(result.note.endSeconds, 1.5);
  }
  assert.equal(accepted, 64);
  assert.deepEqual(errors, []);
  const report = { browser: browser.version(), accepted, rejected: cases.length - accepted, cases, errors };
  await writeFile('/tmp/maijdata-slide-vsz-roundtrip.json', JSON.stringify(report, null, 2));
  console.log({ accepted, rejected: report.rejected, errors });
} finally { await browser.close(); }
