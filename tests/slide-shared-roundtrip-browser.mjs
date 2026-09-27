import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage();
try {
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5175/');
  const results = await page.evaluate(async () => {
    const { createMajSimaiParser } = await import('/@fs/Users/errion/Work/Projects/maijdata/packages/majsimai-browser/src/bridge.ts');
    const parser = await createMajSimaiParser(new URL('/wasm/', location.href));
    const output = [];
    for (const head of ['', '@', '!']) for (const flags of ['', 'b', 'x', 'xb']) {
      const token = `1${head}${flags}-5b[4:1]*<7[0.25##1.5]*w5b[240#8:1]`;
      const result = await parser.parse(`&first=0\n&inote_1=(120){4}${token},E\n`);
      output.push({ token, head: head === '@' ? 'tap' : head === '!' ? 'none' : 'star', flags,
        schemaVersion: result.schemaVersion, chart: result.charts[0] });
    }
    for (const token of ['1-5[4:1]*', '1-5[4:1]**<7[4:1]', '1-5[4:1]*x<7[4:1]',
      '1-5[4:1]*<7[4:1]-3[4:1]', '1-5[4:1]*p7[4:1]']) {
      const result = await parser.parse(`&first=0\n&inote_1=(120){4}${token},E\n`);
      output.push({ token, unsupported: true, chart: result.charts[0] });
    }
    return output;
  });
  for (const result of results) {
    if (result.unsupported) { assert.equal(result.chart.editable, false, result.token); assert.equal(result.chart.notes.length, 0); continue; }
    assert.equal(result.schemaVersion, 4);
    assert.equal(result.chart.editable, true, JSON.stringify(result));
    assert.equal(result.chart.notes.length, 1);
    const note = result.chart.notes[0];
    assert.equal(note.slide.head, result.head);
    assert.deepEqual(note.modifiers, { break: result.flags.includes('b'), ex: result.flags.includes('x') });
    assert.equal(note.durationSeconds, 1.75); assert.equal(note.moveStartSeconds, .5);
    assert.equal(note.slide.slideBreak, true);
    assert.deepEqual(note.slide.additionalPaths.map(path => [path.command, path.endPosition, path.slideBreak]), [['<', 7, false], ['w', 5, true]]);
    assert.deepEqual(note.slide.additionalPaths[0].wait, { kind: 'seconds', seconds: .25 });
    assert.deepEqual(note.slide.additionalPaths[0].move, { kind: 'seconds', seconds: 1.5 });
  }
  await writeFile('/tmp/maijdata-slide-shared-roundtrip-results.json', JSON.stringify({ browser: browser.version(), results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, supported: 12, rejected: 5 }));
} finally { await browser.close(); }
