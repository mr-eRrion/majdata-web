import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BPM = 120;
const SUBDIVISION = 64;
const CELL_COUNT = 9_600;
const CELLS_PER_SECOND = BPM * SUBDIVISION / 240;
const CHART_SECONDS = CELL_COUNT / CELLS_PER_SECOND;
const SLIDE_COUNT = 100;
const NORMAL_COUNT = 900;
const WAIT_SECONDS = 0.5;
const MOVE_SECONDS = 8;
const HOLD_SOURCE = 'h[4:4]';
const HOLD_SECONDS = 2;

function slideCells(dense) {
  if (!dense) {
    return Array.from({ length: SLIDE_COUNT }, (_, index) =>
      Math.round(index * (291 * CELLS_PER_SECOND) / (SLIDE_COUNT - 1)));
  }

  const earlyCount = 20;
  const earlyLastCell = 4 * CELLS_PER_SECOND - 1;
  const laterFirstCell = 4 * CELLS_PER_SECOND;
  const lastCell = 291 * CELLS_PER_SECOND;
  const early = Array.from({ length: earlyCount }, (_, index) =>
    Math.round(index * earlyLastCell / (earlyCount - 1)));
  const later = Array.from({ length: SLIDE_COUNT - earlyCount }, (_, index) =>
    Math.round(laterFirstCell + index * (lastCell - laterFirstCell) / (SLIDE_COUNT - earlyCount - 1)));
  return [...early, ...later];
}

function normalCells() {
  const firstStartCell = 1;
  const lastStartCell = 298 * CELLS_PER_SECOND;
  return Array.from({ length: NORMAL_COUNT }, (_, index) =>
    Math.round(firstStartCell + index * (lastStartCell - firstStartCell) / (NORMAL_COUNT - 1)));
}

function nextLane(lane, distance) {
  return ((lane - 1 + distance) % 8) + 1;
}

function makePath(startLane, commands, { distance = 2, slideBreak = false } = {}) {
  let previous = startLane;
  const segments = commands.map((command) => {
    const endPosition = nextLane(previous, distance);
    const segment = { startPosition: previous, command, endPosition };
    previous = endPosition;
    return segment;
  });
  const [first, ...rest] = segments;
  return {
    command: first.command,
    endPosition: first.endPosition,
    continuations: rest.map(({ command, endPosition }) => ({ command, endPosition })),
    segmentCount: segments.length,
    endLane: previous,
    slideBreak,
    source: `${first.command}${first.endPosition}${rest.map(({ command, endPosition }) => `${command}${endPosition}`).join('')}${slideBreak ? 'b' : ''}[${WAIT_SECONDS}##${MOVE_SECONDS}]`,
  };
}

function makeSlide(index) {
  const lane = (index % 8) + 1;
  const straight = makePath(lane, ['-', '-', '-', '-'], { slideBreak: index % 20 === 0 });
  const arc = makePath(lane, ['<', '>', '<', '>'], { slideBreak: index % 20 === 1 });
  const wifi = makePath(lane, ['w'], { distance: 4, slideBreak: index % 20 === 2 });
  const headFlags = index % 25 === 0 ? 'xb' : index % 25 === 1 ? 'x' : '';
  const source = `${lane}${headFlags}${straight.source}*${arc.source}*${wifi.source}`;
  return {
    index,
    lane,
    source,
    paths: [straight, arc, wifi],
  };
}

function assertWorkload(events, slideNotes, slidesByCell, normalPositions, dense) {
  assert.equal(events.length, SLIDE_COUNT + NORMAL_COUNT);
  assert.equal(slideNotes.length, SLIDE_COUNT);
  assert(slideNotes.every(({ paths }) => paths.length === 3));
  assert.equal(slideNotes.reduce((sum, note) => sum + note.paths.length, 0), 300);
  assert.equal(slideNotes.reduce((sum, note) => sum
    + note.paths.filter((path) => path.command !== 'w').reduce((count, path) => count + path.segmentCount, 0), 0), 800);
  assert.equal(slideNotes.reduce((sum, note) => sum
    + note.paths.filter((path) => path.command === 'w').length, 0), 100);
  assert(slideNotes.every(({ source }) => (source.match(/\*/g) ?? []).length === 2));
  assert(slideNotes.every(({ paths }) => paths[0].segmentCount === 4
    && paths[1].segmentCount === 4 && paths[2].segmentCount === 1));
  assert(slideNotes.every(({ paths, lane }) => paths[0].endLane === lane && paths[1].endLane === lane));
  assert(slideNotes.every(({ paths, lane }) => paths[2].endLane === nextLane(lane, 4)));

  const latestSlideStart = Math.max(...slidesByCell) / CELLS_PER_SECOND;
  assert.equal(slidesByCell[0], 0);
  assert.equal(latestSlideStart, 291);
  assert(latestSlideStart + WAIT_SECONDS + MOVE_SECONDS <= CHART_SECONDS);
  assert.equal(normalPositions[0], 1);
  assert.notEqual(normalPositions[0], slidesByCell[0], 'the first normal note must not share the first Slide beat');
  assert.equal(normalPositions.at(-1), 298 * CELLS_PER_SECOND);
  assert(normalPositions.at(-1) / CELLS_PER_SECOND + HOLD_SECONDS <= CHART_SECONDS);
  if (dense) {
    assert.equal(slidesByCell[19], 4 * CELLS_PER_SECOND - 1);
    assert.equal(slidesByCell[20], 4 * CELLS_PER_SECOND);
  }
}

/** Deterministic 5-minute workload: 100 shared-head connected Slides and 900 Tap/Hold notes. */
export function generateConnectedLoad({ dense = false } = {}) {
  if (typeof dense !== 'boolean') throw new TypeError('dense must be a boolean');
  const starts = dense ? slideCells(true) : slideCells(false);
  const normalStarts = normalCells();
  const cells = Array.from({ length: CELL_COUNT }, () => []);
  const slideNotes = starts.map((cell, index) => ({ ...makeSlide(index), cell }));
  const normalNotes = normalStarts.map((cell, index) => {
    const lane = ((index + 1) % 8) + 1;
    const hold = index % 10 === 9;
    return { cell, kind: hold ? 'hold' : 'tap', source: `${lane}${hold ? HOLD_SOURCE : ''}` };
  });

  for (const note of slideNotes) cells[note.cell].push(note.source);
  for (const note of normalNotes) cells[note.cell].push(note.source);
  const source = `&title=Synthetic connected Slide workload (${dense ? 'dense' : 'default'})\n`
    + '&artist=maijdata performance fixture\n'
    + '&first=0\n'
    + `&inote_1=(${BPM}){${SUBDIVISION}}${cells.map((notes) => notes.join('/')).join(',')},E\n`;

  const eventCounts = cells.map((notes) => notes.length);
  const maximumSimultaneousStarts = Math.max(...eventCounts);
  assert.equal(maximumSimultaneousStarts, 2);
  const slideStartRange = { first: starts[0] / CELLS_PER_SECOND, last: starts.at(-1) / CELLS_PER_SECOND };
  const normalStartRange = { first: normalStarts[0] / CELLS_PER_SECOND, last: normalStarts.at(-1) / CELLS_PER_SECOND };
  const headBreakCount = slideNotes.filter(({ index }) => index % 25 === 0).length;
  const headExCount = slideNotes.filter(({ index }) => index % 25 === 0 || index % 25 === 1).length;
  const pathBreakCount = slideNotes.reduce((sum, { index }) => sum
    + (index % 20 <= 2 ? 1 : 0), 0);

  assertWorkload([...slideNotes, ...normalNotes], slideNotes, starts, normalStarts, dense);

  const workload = {
    mode: dense ? 'dense' : 'default',
    noteCount: SLIDE_COUNT + NORMAL_COUNT,
    logicalNoteCount: SLIDE_COUNT + NORMAL_COUNT,
    slideNoteCount: SLIDE_COUNT,
    ordinaryNoteCount: NORMAL_COUNT,
    pathCount: SLIDE_COUNT * 3,
    segmentCount: SLIDE_COUNT * 8,
    segmentCountDefinition: 'connected non-Wi-Fi line segments; atomic Wi-Fi paths are counted separately',
    wifiCount: SLIDE_COUNT,
    holdCount: normalNotes.filter(({ kind }) => kind === 'hold').length,
    tapCount: normalNotes.filter(({ kind }) => kind === 'tap').length,
    maximumSimultaneousStarts,
    maxSimultaneousStarts: maximumSimultaneousStarts,
    firstSlide: {
      seconds: slideStartRange.first,
      beat: starts[0] / 16,
      position: slideNotes[0].lane,
      startLane: slideNotes[0].lane,
    },
    startLaneOrder: 'Slides 1..8 cyclic; ordinary notes 2..8,1 cyclic',
    placement: {
      chartSeconds: CHART_SECONDS,
      cellCount: CELL_COUNT,
      cellSeconds: 1 / CELLS_PER_SECOND,
      slideStartsSeconds: slideStartRange,
      slideEndsSeconds: { first: slideStartRange.first + WAIT_SECONDS + MOVE_SECONDS,
        last: slideStartRange.last + WAIT_SECONDS + MOVE_SECONDS },
      denseClusterSeconds: dense
        ? { count: 20, first: starts[0] / CELLS_PER_SECOND, last: starts[19] / CELLS_PER_SECOND }
        : null,
      normalStartsSeconds: normalStartRange,
      latestHoldEndSeconds: normalStartRange.last + HOLD_SECONDS,
    },
    parameters: {
      bpm: BPM,
      subdivision: SUBDIVISION,
      slidePathsPerNote: ['4-segment straight', '4-segment alternating <> arc', '1 atomic Wi-Fi'],
      slideWaitSeconds: WAIT_SECONDS,
      slideTotalMoveSeconds: MOVE_SECONDS,
      slideWaitMoveSource: '0.5##8',
      holdSource: HOLD_SOURCE,
      holdSeconds: HOLD_SECONDS,
      headBreakCount,
      headExCount,
      slideBreakPathCount: pathBreakCount,
      modifiersAreSerializedOncePerLogicalSlide: true,
    },
  };
  return { text: source, workload };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'default';
  if (mode !== 'default' && mode !== 'dense') throw new Error('Choose default or dense mode.');
  const outputPath = process.argv[3];
  const { text, workload } = generateConnectedLoad({ dense: mode === 'dense' });
  if (outputPath) writeFileSync(outputPath, text);
  process.stdout.write(`${JSON.stringify({ ...workload, bytes: Buffer.byteLength(text), outputPath: outputPath ?? null }, null, 2)}\n`);
}
