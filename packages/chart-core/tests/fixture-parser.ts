import type { ParserChart, ParserResult } from '../../majsimai-browser/src/types.js';
import type { BpmEvent, Note, SourceField } from '../src/types.js';

interface Line { start: number; contentEnd: number; nextStart: number; name?: string; equals?: number }

function sourceFields(text: string): SourceField[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const nextStart = newline < 0 ? text.length : newline + 1;
    let contentEnd = newline < 0 ? text.length : newline;
    if (contentEnd > start && text[contentEnd - 1] === '\r') contentEnd--;
    let contentStart = start;
    if (contentStart === 0 && text[contentStart] === '\uFEFF') contentStart++;
    while (contentStart < contentEnd && /\s/.test(text[contentStart])) contentStart++;
    if (text[contentStart] === '&') {
      const equals = text.indexOf('=', contentStart);
      if (equals > contentStart) lines.push({ start, contentEnd, nextStart, name: text.slice(contentStart + 1, equals), equals });
      else lines.push({ start, contentEnd, nextStart });
    } else lines.push({ start, contentEnd, nextStart });
    start = nextStart;
  }
  if (text.length === 0 || text.endsWith('\n')) lines.push({ start: text.length, contentEnd: text.length, nextStart: text.length });

  const headers = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.name !== undefined);
  return headers.map(({ line, index }, headerIndex) => {
    const nextHeader = headers[headerIndex + 1]?.line.start ?? text.length;
    const end = line.name!.startsWith('inote_') ? nextHeader : line.nextStart;
    const valueStart = line.equals! + 1;
    return {
      name: line.name!,
      range: { start: line.start, end },
      valueRange: { start: valueStart, end },
      rawValue: text.slice(valueStart, end),
    };
  });
}

function field(text: string, fields: SourceField[], name: string): SourceField {
  const result = fields.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Fixture field &${name} is missing`);
  return result;
}

function bodyRange(value: SourceField): { start: number; end: number } {
  const body = value.rawValue;
  let startOffset = 0;
  while (startOffset < body.length && /\s/.test(body[startOffset])) startOffset++;
  let endOffset = body.length;
  while (endOffset > startOffset && /\s/.test(body[endOffset - 1])) endOffset--;
  return { start: value.valueRange.start + startOffset, end: value.valueRange.start + endOffset };
}

function note(id: string, kind: Note['kind'], beat: number, position: number, order: number, duration?: Note['duration']): Note & { startSeconds: number; durationSeconds: number } {
  const startSeconds = beat === 0 ? 0 : beat === 1 ? 0.5 : beat === 2 ? 1 : beat === 2.5 ? 1.125 : 1.25;
  const durationSeconds = kind === 'hold' ? duration?.kind === 'seconds' ? duration.seconds : duration?.kind === 'beatsAtStartBpm' ? duration.beats * 0.5 : 0 : 0;
  return { id, kind, beat: { numerator: Math.round(beat * 2), denominator: 2 }, position, order, duration, modifiers: { break: false, ex: false }, startSeconds, durationSeconds };
}

export function fixtureParserResult(text: string, movedLane3 = false): ParserResult {
  const fields = sourceFields(text);
  const inote1 = field(text, fields, 'inote_1');
  const inote2 = field(text, fields, 'inote_2');
  const source1 = bodyRange(inote1);
  const source2 = bodyRange(inote2);
  const bpms: BpmEvent[] = [
    { beat: { numerator: 0, denominator: 1 }, bpm: 120 },
    { beat: { numerator: 2, denominator: 1 }, bpm: 240 },
  ];
  const notes = [
    note('1:0:0', 'tap', 0, 1, 0),
    note('1:2:1', 'tap', 0, 1, 1),
    note('1:24:0', 'hold', 1, 2, 2, { kind: 'beatsAtStartBpm', division: 4, beats: 4 }),
    note('1:38:0', 'tap', movedLane3 ? 2.5 : 2, 3, 3),
    note('1:46:0', 'hold', 3, 4, 4, { kind: 'seconds', seconds: 0.25 }),
  ];
  const chart1: ParserChart = {
    difficulty: 1,
    level: '1',
    designer: '',
    editable: true,
    modified: false,
    sourceRange: source1,
    fieldRange: inote1.range,
    endBeat: { numerator: 5, denominator: 1 },
    notes,
    bpms,
    diagnostics: [],
  };
  const warning = {
    code: 'unsupported-syntax',
    message: 'Connected Slide remains read-only in this fixture.',
    severity: 'error' as const,
    range: source2,
    difficulty: 2,
  };
  const chart2: ParserChart = {
    difficulty: 2,
    level: '2',
    designer: '',
    editable: false,
    modified: false,
    sourceRange: source2,
    fieldRange: inote2.range,
    endBeat: { numerator: 1, denominator: 1 },
    notes: [],
    bpms: [{ beat: { numerator: 0, denominator: 1 }, bpm: 120 }],
    diagnostics: [warning],
  };
  const firstRaw = fields.find((candidate) => candidate.name === 'first')?.rawValue;
  const firstSeconds = firstRaw === undefined ? 0 : Number(firstRaw.trim());
  return {
    schemaVersion: 4,
    parserCommit: 'fixture-manual-dto',
    sourceLengthUtf16: text.length,
    globalEditable: true,
    firstSeconds,
    fields,
    charts: [chart1, chart2],
    diagnostics: [warning],
  };
}

export function simpleParserResult(text: string, addedNote = false, lateBpm = false): ParserResult {
  const fields = sourceFields(text);
  const chartField = field(text, fields, 'inote_1');
  const chart: ParserChart = {
    difficulty: 1,
    level: '1',
    designer: '',
    editable: true,
    modified: false,
    sourceRange: bodyRange(chartField),
    fieldRange: chartField.range,
    endBeat: { numerator: lateBpm ? 2 : 1, denominator: 1 },
    notes: [
      note('1:note', 'tap', 0, 1, 0),
      ...(addedNote ? [note('1:added', 'tap', 0, 2, 1)] : []),
    ],
    bpms: [
      { beat: { numerator: 0, denominator: 1 }, bpm: 120 },
      ...(lateBpm ? [{ beat: { numerator: 1, denominator: 1 }, bpm: 240 }] : []),
    ],
    diagnostics: [],
  };
  const firstRaw = fields.find((candidate) => candidate.name === 'first')?.rawValue;
  return {
    schemaVersion: 4,
    parserCommit: 'fixture-manual-dto',
    sourceLengthUtf16: text.length,
    globalEditable: true,
    firstSeconds: firstRaw === undefined ? 0 : Number(firstRaw.trim()),
    fields,
    charts: [chart],
    diagnostics: [],
  };
}

/** Tiny, fixed Touch/Touch Hold fixture used to exercise Firework preservation. */
export function fireworkParserResult(text: string): ParserResult {
  const fields = sourceFields(text);
  const inote = field(text, fields, 'inote_1');
  const sourceRange = bodyRange(inote);
  const body = text.slice(sourceRange.start, sourceRange.end);
  const touchStart = text.indexOf('A1', sourceRange.start);
  const holdStart = text.indexOf('A2', sourceRange.start);
  if (touchStart < 0 || holdStart < 0) throw new Error('Firework fixture is missing its Touch notes');
  const chart: ParserChart = {
    difficulty: 1,
    level: '1',
    designer: '',
    editable: true,
    modified: false,
    sourceRange,
    fieldRange: inote.range,
    endBeat: { numerator: 2, denominator: 1 },
    notes: [
      {
        id: '1:touch', kind: 'touch', beat: { numerator: 0, denominator: 1 }, position: 1,
        touchArea: 'A', firework: body.includes('A1f'), order: 0,
        sourceRange: { start: touchStart, end: touchStart + 3 }, startSeconds: 0, durationSeconds: 0,
        modifiers: { break: false, ex: false },
      },
      {
        id: '1:touch-hold', kind: 'touchHold', beat: { numerator: 1, denominator: 1 }, position: 2,
        touchArea: 'A', firework: body.includes('A2fh'), order: 1,
        duration: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
        sourceRange: { start: holdStart, end: holdStart + 3 }, startSeconds: 0.5, durationSeconds: 0.5,
        modifiers: { break: false, ex: false },
      },
    ],
    bpms: [{ beat: { numerator: 0, denominator: 1 }, bpm: 120 }],
    diagnostics: [],
  };
  return {
    schemaVersion: 4,
    parserCommit: 'fixture-touch-firework',
    sourceLengthUtf16: text.length,
    globalEditable: true,
    firstSeconds: 0,
    fields,
    charts: [chart],
    diagnostics: [],
  };
}
