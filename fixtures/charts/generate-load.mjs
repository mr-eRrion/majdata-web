import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 300 seconds, 9,600 subdivisions at 120 BPM; no media or third-party chart. */
export function generateLoad(noteCount = 1_000, { mixedSlide = false } = {}) {
  if (mixedSlide && noteCount !== 1_000) throw new Error('The mixed-slide workload is defined for exactly 1000 notes.');
  const groups = 9_600;
  const cells = [];
  let emitted = 0;
  let holdCount = 0;
  let slideSegments = 0;
  let wifiCount = 0;
  for (let group = 0; group < groups; group++) {
    const target = Math.floor(((group + 1) * noteCount) / groups);
    const notes = [];
    while (emitted < target) {
      const lane = (emitted % 8) + 1;
      // 1-indexed notes 10, 20, ... are replaced; existing every-100th Holds remain.
      const slideIndex = mixedSlide && emitted % 10 === 9 ? slideSegments : -1;
      if (slideIndex >= 0) {
        const command = ['-', '<', 'w'][slideIndex % 3];
        const distance = command === '-' ? 2 : command === '<' ? 3 : 4;
        const endLane = ((lane - 1 + distance) % 8) + 1;
        notes.push(`${lane}${command}${endLane}[0.5##1]`);
        slideSegments++;
        if (command === 'w') wifiCount++;
      } else {
        const hold = emitted % 100 === 0;
        notes.push(`${lane}${hold ? 'h[4:4]' : ''}`);
        if (hold) holdCount++;
      }
      emitted++;
    }
    cells.push(notes.join('/'));
  }
  const title = `Synthetic ${noteCount} notes / 300 seconds${mixedSlide ? ' (mixed slides)' : ''}`;
  return {
    text: `&title=${title}\n&first=0\n&inote_1=(120){64}${cells.join(',')},E\n`,
    workload: {
      noteCount, holdCount, slideSegments, wifiCount, durationSeconds: 300,
      subdivisionCount: groups, maxSimultaneousStarts: Math.ceil(noteCount / groups),
      note: mixedSlide
        ? 'Synthetic read-only mixed Tap/Hold/Slide load; slides use fixed 0.5-second wait and 1-second movement.'
        : 'Synthetic supported Tap/Hold load. Slide performance is outside the current unverified scope.',
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = Number(process.argv[2] ?? 1_000);
  if (![1_000, 10_000].includes(count)) throw new Error('Choose the normal 1000 or stress 10000 workload.');
  const outputPath = process.argv[3];
  if (!outputPath) throw new Error('Usage: node fixtures/charts/generate-load.mjs 1000 /tmp/load.maidata.txt [tap-hold|mixed-slide]');
  const mode = process.argv[4] ?? 'tap-hold';
  if (!['tap-hold', 'mixed-slide'].includes(mode)) throw new Error('Choose tap-hold or mixed-slide mode.');
  const { text, workload } = generateLoad(count, { mixedSlide: mode === 'mixed-slide' });
  writeFileSync(outputPath, text);
  process.stdout.write(`${JSON.stringify({ ...workload, bytes: Buffer.byteLength(text), outputPath }, null, 2)}\n`);
}
