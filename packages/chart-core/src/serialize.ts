import type { BpmEvent, Chart, Note, Rational, SlidePathData } from './types.js';
import { compareRational, rational, rationalKey, subtractRational } from './rational.js';

const MAX_SERIALIZED_CELLS = 1_000_000;

function decimalFromRatio(numerator: bigint, denominator: bigint): string | undefined {
  if (denominator <= 0n) return undefined;
  let reducedNumerator = numerator;
  let reducedDenominator = denominator;
  const gcd = gcdBig(reducedNumerator < 0n ? -reducedNumerator : reducedNumerator, reducedDenominator);
  reducedNumerator /= gcd;
  reducedDenominator /= gcd;
  let twos = 0;
  let fives = 0;
  while (reducedDenominator % 2n === 0n) { reducedDenominator /= 2n; twos++; }
  while (reducedDenominator % 5n === 0n) { reducedDenominator /= 5n; fives++; }
  if (reducedDenominator !== 1n) return undefined;
  const scale = Math.max(twos, fives);
  if (scale > 24) return undefined;
  let scaled = reducedNumerator * (2n ** BigInt(scale - twos)) * (5n ** BigInt(scale - fives));
  const sign = scaled < 0n ? '-' : '';
  if (scaled < 0n) scaled = -scaled;
  let digits = scaled.toString().padStart(scale + 1, '0');
  if (scale === 0) return `${sign}${digits}`;
  const split = digits.length - scale;
  const fractional = digits.slice(split).replace(/0+$/, '');
  return fractional.length === 0 ? `${sign}${digits.slice(0, split)}` : `${sign}${digits.slice(0, split)}.${fractional}`;
}

function gcdBig(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function subdivisionFor(delta: Rational): { text: string; commaCount: number } {
  const numerator = BigInt(delta.numerator);
  const denominator = BigInt(delta.denominator);
  if (numerator <= 0n) throw new RangeError('Chart event positions must strictly increase between cells');
  const exactDivision = decimalFromRatio(4n * denominator, numerator);
  if (exactDivision !== undefined) return { text: exactDivision, commaCount: 1 };
  const division = 4n * denominator;
  if (numerator > BigInt(MAX_SERIALIZED_CELLS))
    throw new RangeError('The exact beat spacing cannot be serialized within the chart cell limit');
  return { text: division.toString(), commaCount: Number(numerator) };
}

function holdSource(note: Note): string {
  if (note.kind !== 'hold' && note.kind !== 'touchHold') return '';
  const duration = note.duration ?? { kind: 'short' as const };
  switch (duration.kind) {
    case 'short': return 'h';
    case 'seconds': return `h[#${duration.seconds}]`;
    case 'beatsAtStartBpm': return `h[${duration.division}:${duration.beats}]`;
    case 'beatsAtBpm': return `h[${duration.bpm}#${duration.division}:${duration.beats}]`;
  }
}

function slideDurationSource(slide: SlidePathData): string {
  const { wait, move } = slide;
  if (wait.kind === 'beatsAtStartBpm' && wait.division === 4 && wait.beats === 1
    && move.kind === 'beatsAtStartBpm') {
    return `${move.division}:${move.beats}`;
  }
  if (wait.kind === 'beatsAtBpm' && wait.division === 4 && wait.beats === 1
    && move.kind === 'beatsAtBpm' && move.bpm === wait.bpm) {
    return `${wait.bpm}#${move.division}:${move.beats}`;
  }
  if (wait.kind === 'seconds' && move.kind === 'beatsAtStartBpm') {
    return `${wait.seconds}##${move.division}:${move.beats}`;
  }
  if (wait.kind === 'seconds' && move.kind === 'seconds') {
    return `${wait.seconds}##${move.seconds}`;
  }
  if (wait.kind === 'seconds' && move.kind === 'beatsAtBpm') {
    return `${wait.seconds}##${move.bpm}#${move.division}:${move.beats}`;
  }
  if (wait.kind === 'beatsAtBpm' && wait.division === 4 && wait.beats === 1 && move.kind === 'seconds') {
    return `${wait.bpm}#${move.seconds}`;
  }
  throw new RangeError('Slide wait/move pair has no verified MajSimai source representation');
}

function slidePathSource(path: SlidePathData): string {
  const breakSlide = path.slideBreak ? 'b' : '';
  const continuations = (path.continuations ?? []).map((segment) => `${segment.command}${segment.endPosition}`).join('');
  return `${path.command}${path.endPosition}${continuations}${breakSlide}[${slideDurationSource(path)}]`;
}

function slideSource(note: Note): string {
  const slide = note.slide;
  if (!slide) throw new Error('Slide data is required for Slide serialization');
  const head = slide.head === 'tap' ? '@' : slide.head === 'none' ? '!' : '';
  const noteFlags = `${note.modifiers.ex ? 'x' : ''}${note.modifiers.break ? 'b' : ''}`;
  return `${note.position}${head}${noteFlags}${slidePathSource(slide)}${(slide.additionalPaths ?? [])
    .map((path) => `*${slidePathSource(path)}`).join('')}`;
}

function noteSource(note: Note): string {
  if (note.kind === 'slide') return slideSource(note);
  const modifiers = `${note.modifiers.break ? 'b' : ''}${note.modifiers.ex ? 'x' : ''}`;
  const head = note.touchArea === undefined
    ? String(note.position)
    : note.touchArea === 'C' ? 'C' : `${note.touchArea}${note.position}`;
  const forceStar = note.kind === 'tap' && note.forceStar ? '$' : '';
  return `${head}${forceStar}${note.firework ? 'f' : ''}${modifiers}${holdSource(note)}`;
}

function groupEvents(chart: Chart): Array<{ beat: Rational; bpms: BpmEvent[]; notes: Note[]; terminal: boolean }> {
  const byBeat = new Map<string, { beat: Rational; bpms: BpmEvent[]; notes: Note[]; terminal: boolean }>();
  const ensure = (beat: Rational) => {
    const key = rationalKey(beat);
    let group = byBeat.get(key);
    if (!group) {
      group = { beat: { ...beat }, bpms: [], notes: [], terminal: false };
      byBeat.set(key, group);
    }
    return group;
  };
  for (const event of chart.bpms) ensure(event.beat).bpms.push(event);
  for (const note of chart.notes) ensure(note.beat).notes.push(note);
  const terminalBeat = rational(chart.endBeat.numerator, chart.endBeat.denominator);
  if (chart.notes.some((note) => compareRational(note.beat, terminalBeat) >= 0)
    || chart.bpms.some((event) => compareRational(event.beat, terminalBeat) > 0))
    throw new Error('Chart terminal beat must follow every note and BPM event');
  ensure(terminalBeat).terminal = true;
  const groups = [...byBeat.values()];
  for (const group of groups) {
    group.notes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    // Preserve declarations at a shared beat in their parser / command order.
  }
  groups.sort((a, b) => compareRational(a.beat, b.beat));
  return groups;
}

export function serializeChart(chart: Chart): string {
  if (!chart.editable) throw new Error(`Difficulty ${chart.difficulty} is read-only`);
  const groups = groupEvents(chart);
  if (groups.length === 0 || compareRational(groups[0].beat, rational(0)) !== 0)
    throw new Error('Chart needs an event at beat zero');
  const zero = groups.find((group) => compareRational(group.beat, rational(0)) === 0);
  if (!zero || zero.bpms.length === 0) throw new Error('Chart needs a BPM event at beat zero');
  const output: string[] = [];
  let cellCount = 0;

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    for (const bpm of group.bpms) output.push(`(${bpm.bpm})`);
    const next = groups[index + 1];
    let commaCount = 0;
    if (next) {
      const spacing = subdivisionFor(subtractRational(next.beat, group.beat));
      output.push(`{${spacing.text}}`);
      commaCount = spacing.commaCount;
      cellCount += commaCount;
      if (cellCount > MAX_SERIALIZED_CELLS) throw new RangeError('Generated chart exceeds the cell limit');
    }
    if (group.notes.length) output.push(group.notes.map(noteSource).join('/'));
    if (group.terminal) output.push('E');
    for (let comma = 0; comma < commaCount; comma++) output.push(',');
  }
  if (!groups.at(-1)?.terminal) throw new Error('Chart terminal position was not generated');
  return output.join('');
}
