import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5175/';
const resultPath = '/tmp/maijdata-slide-roundtrip-results.json';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrls = {
  serialize: `/@fs${projectRoot}/packages/chart-core/src/serialize.ts`,
  bridge: `/@fs${projectRoot}/packages/majsimai-browser/src/bridge.ts`,
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(baseUrl);
  const cases = await page.evaluate(async (urls) => {
    const [{ serializeChart }, { createMajSimaiParser }] = await Promise.all([
      import(urls.serialize),
      import(urls.bridge),
    ]);
    const parser = await createMajSimaiParser(new URL('/wasm/', location.href));
    const bpm = 120;
    const baseWait = { kind: 'beatsAtStartBpm', division: 4, beats: 1 };
    const baseMove = { kind: 'beatsAtStartBpm', division: 4, beats: 2 };
    const durationForms = [
      {
        name: 'default-beat-wait-and-move',
        wait: baseWait,
        move: baseMove,
        expectedToken: '1-5[4:2]',
      },
      {
        name: 'designated-bpm-wait-and-move',
        wait: { kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 },
        move: { kind: 'beatsAtBpm', bpm: 240, division: 8, beats: 1 },
        expectedToken: '1-5[240#8:1]',
      },
      {
        name: 'fixed-wait-and-source-bpm-move',
        wait: { kind: 'seconds', seconds: 0.25 },
        move: { kind: 'beatsAtStartBpm', division: 8, beats: 1 },
        expectedToken: '1-5[0.25##8:1]',
      },
      {
        name: 'fixed-wait-and-designated-bpm-move',
        wait: { kind: 'seconds', seconds: 0.25 },
        move: { kind: 'beatsAtBpm', bpm: 240, division: 8, beats: 1 },
        expectedToken: '1-5[0.25##240#8:1]',
      },
      {
        name: 'designated-bpm-wait-and-fixed-move',
        wait: { kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 },
        move: { kind: 'seconds', seconds: 0.5 },
        expectedToken: '1-5[240#0.5]',
      },
      {
        name: 'fixed-wait-and-fixed-move',
        wait: { kind: 'seconds', seconds: 0.25 },
        move: { kind: 'seconds', seconds: 0.5 },
        expectedToken: '1-5[0.25##0.5]',
      },
    ];

    function chartFor(slide, modifiers) {
      return {
        difficulty: 1,
        editable: true,
        diagnostics: [],
        notes: [{
          id: 'slide-roundtrip',
          kind: 'slide',
          beat: { numerator: 0, denominator: 1 },
          position: 1,
          order: 0,
          modifiers,
          slide,
        }],
        bpms: [{ beat: { numerator: 0, denominator: 1 }, bpm }],
        endBeat: { numerator: 1, denominator: 1 },
        sourceRange: { start: 0, end: 0 },
        modified: false,
      };
    }

    async function roundTrip(name, slide, modifiers, expectedToken) {
      let generatedText;
      try {
        generatedText = serializeChart(chartFor(slide, modifiers));
        const sourceText = `&title=Slide round trip\n&first=0\n&lv_1=1\n&inote_1=${generatedText}\n`;
        const result = await parser.parse(sourceText);
        const chart = result.charts.find((item) => item.difficulty === 1);
        const note = chart?.notes.find((item) => item.kind === 'slide');
        return {
          name,
          generatedText,
          sourceText,
          expectedToken,
          schemaVersion: result.schemaVersion,
          chartEditable: chart?.editable,
          diagnosticCodes: chart?.diagnostics.map(({ code }) => code) ?? [],
          parsedNote: note ? {
            kind: note.kind,
            position: note.position,
            startSeconds: note.startSeconds,
            moveStartSeconds: note.moveStartSeconds,
            durationSeconds: note.durationSeconds,
            duration: note.duration,
            modifiers: note.modifiers,
            slide: note.slide,
          } : null,
          parserDiagnostics: result.diagnostics.map(({ code }) => code),
        };
      } catch (error) {
        return { name, generatedText, expectedToken, error: String(error) };
      }
    }

    const durationResults = [];
    for (const value of durationForms) {
      const slide = {
        command: '-', endPosition: 5, head: 'star', slideBreak: false,
        wait: value.wait, move: value.move,
      };
      durationResults.push(await roundTrip(value.name, slide, { break: false, ex: false }, value.expectedToken));
    }

    const modifierResults = [];
    for (const head of ['star', 'tap', 'none']) {
      for (const breakFlag of [false, true]) {
        for (const exFlag of [false, true]) {
          for (const slideBreak of [false, true]) {
            const marker = head === 'tap' ? '@' : head === 'none' ? '!' : '';
            const expectedToken = `1${marker}${exFlag ? 'x' : ''}${breakFlag ? 'b' : ''}-5${slideBreak ? 'b' : ''}[4:2]`;
            const slide = { command: '-', endPosition: 5, head, slideBreak, wait: baseWait, move: baseMove };
            modifierResults.push(await roundTrip(
              `head=${head};break=${breakFlag};ex=${exFlag};slideBreak=${slideBreak}`,
              slide,
              { break: breakFlag, ex: exFlag },
              expectedToken,
            ));
          }
        }
      }
    }

    parser.dispose();
    return { durationResults, modifierResults };
  }, moduleUrls);

  const report = {
    baseUrl,
    browser: browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    durationForms: cases.durationResults,
    modifierCombinations: cases.modifierResults,
    pageErrors,
  };
  await writeFile(resultPath, JSON.stringify(report, null, 2));

  function checkCase(result) {
    assert.ifError(result.error ? new Error(result.error) : undefined);
    assert.equal(result.generatedText, `(120){4}${result.expectedToken},E`, `${result.name}: serializer output`);
    assert.equal(result.schemaVersion, 4, `${result.name}: parser schema`);
    assert.equal(result.chartEditable, true, `${result.name}: supported single-segment Slide chart is editable`);
    assert(result.diagnosticCodes.includes('slide-validation-pending'), `${result.name}: pending diagnostic`);
    assert(!result.diagnosticCodes.includes('upstream-result-mismatch'), `${result.name}: MajSimai cross-check`);
    assert(result.parsedNote, `${result.name}: parsed Slide note`);
    assert.equal(result.parsedNote.kind, 'slide', `${result.name}: note kind`);
    assert.equal(result.parsedNote.duration, undefined, `${result.name}: no Hold duration`);
    assert.equal(result.parsedNote.startSeconds, 0, `${result.name}: hit time`);
    assert.equal(result.parsedNote.position, 1, `${result.name}: start lane`);
    assert.equal(result.parsedNote.slide.endPosition, 5, `${result.name}: end lane`);
    assert.equal(result.parsedNote.slide.command, '-', `${result.name}: command`);
    assert.deepEqual(result.parsedNote.slide.wait, result.expectedWait, `${result.name}: wait DTO`);
    assert.deepEqual(result.parsedNote.slide.move, result.expectedMove, `${result.name}: move DTO`);
  }

  const durationExpected = [
    [{ kind: 'beatsAtStartBpm', division: 4, beats: 1 }, { kind: 'beatsAtStartBpm', division: 4, beats: 2 }],
    [{ kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 }, { kind: 'beatsAtBpm', bpm: 240, division: 8, beats: 1 }],
    [{ kind: 'seconds', seconds: 0.25 }, { kind: 'beatsAtStartBpm', division: 8, beats: 1 }],
    [{ kind: 'seconds', seconds: 0.25 }, { kind: 'beatsAtBpm', bpm: 240, division: 8, beats: 1 }],
    [{ kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 }, { kind: 'seconds', seconds: 0.5 }],
    [{ kind: 'seconds', seconds: 0.25 }, { kind: 'seconds', seconds: 0.5 }],
  ];
  for (let index = 0; index < cases.durationResults.length; index++) {
    const result = cases.durationResults[index];
    [result.expectedWait, result.expectedMove] = durationExpected[index];
    checkCase(result);
    const waitSeconds = seconds(result.expectedWait, 120);
    const moveSeconds = seconds(result.expectedMove, 120);
    near(result.parsedNote.moveStartSeconds, waitSeconds, `${result.name}: move start`);
    near(result.parsedNote.durationSeconds, waitSeconds + moveSeconds, `${result.name}: total duration`);
  }

  for (const result of cases.modifierResults) {
    result.expectedWait = { kind: 'beatsAtStartBpm', division: 4, beats: 1 };
    result.expectedMove = { kind: 'beatsAtStartBpm', division: 4, beats: 2 };
    checkCase(result);
    const [, headName, breakText, exText, slideBreakText] = result.name.match(/^head=(.*);break=(.*);ex=(.*);slideBreak=(.*)$/);
    assert.equal(result.parsedNote.slide.head, headName, `${result.name}: head`);
    assert.equal(result.parsedNote.modifiers.break, breakText === 'true', `${result.name}: head BREAK`);
    assert.equal(result.parsedNote.modifiers.ex, exText === 'true', `${result.name}: EX`);
    assert.equal(result.parsedNote.slide.slideBreak, slideBreakText === 'true', `${result.name}: path BREAK`);
    near(result.parsedNote.moveStartSeconds, 0.5, `${result.name}: move start`);
    near(result.parsedNote.durationSeconds, 1.5, `${result.name}: total duration`);
  }

  assert.equal(cases.durationResults.length, 6);
  assert.equal(cases.modifierResults.length, 24);
  assert.deepEqual(pageErrors, []);
  report.verification = { outcome: 'PASS', durationForms: 6, modifierCombinations: 24, total: 30 };
  await writeFile(resultPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    resultPath,
    browser: report.browser,
    durationForms: report.durationForms.length,
    modifierCombinations: report.modifierCombinations.length,
    total: report.durationForms.length + report.modifierCombinations.length,
    outcome: 'PASS',
  }, null, 2));
} finally {
  await browser.close();
}

function seconds(duration, sourceBpm) {
  switch (duration.kind) {
    case 'seconds': return duration.seconds;
    case 'beatsAtStartBpm': return duration.beats * 4 / duration.division * 60 / sourceBpm;
    case 'beatsAtBpm': return duration.beats * 4 / duration.division * 60 / duration.bpm;
    default: assert.fail(`unsupported duration kind ${duration.kind}`);
  }
}

function near(actual, expected, label) {
  assert(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}
