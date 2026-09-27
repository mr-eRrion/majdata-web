import type { ParserChart, ParserResult } from '../../majsimai-browser/src/types.js';
import { compile, chartEndAfterNotes, compareNotesByBeat } from './compile.js';
import {
  addRational,
  compareRational,
  rational,
  rationalKey,
  rationalToNumber,
  subtractRational,
  validateRational,
} from './rational.js';
import { beatToSeconds, bpmAtBeat, durationToSeconds } from './time.js';
import { slideSegmentLength } from './slide-length.js';
import { serializeChart } from './serialize.js';
import type {
  BpmEvent,
  Chart,
  ChartDocument,
  Checkpoint,
  Diagnostic,
  DisplayChart,
  DisplayNote,
  DisplaySnapshot,
  EditCommand,
  EditRequest,
  ExportResult,
  HoldDuration,
  Note,
  Rational,
  SlideSegmentData,
  SlideData,
  SlidePathData,
  SourceField,
  SourceRange,
} from './types.js';

const HISTORY_LIMIT = 100;
const MAX_NOTES_PER_CHART = 100_000;
const MAX_SLIDE_PATHS = 64;
const MAX_SLIDE_SEGMENTS = 64;
const MAX_SOURCE_LENGTH_UTF16 = 2_000_000;
const METADATA_FIELDS = [
  'title', 'artist', 'des',
  'lv_1', 'lv_2', 'lv_3', 'lv_4', 'lv_5', 'lv_6', 'lv_7',
  'des_1', 'des_2', 'des_3', 'des_4', 'des_5', 'des_6', 'des_7',
] as const;
const UTF8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class ChartCoreError extends Error {
  constructor(readonly code: string, message: string, readonly diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'ChartCoreError';
  }
}

interface NoteReplacement { before: Note; after: Note }
interface ChartDelta {
  difficulty: number;
  added: Note[];
  removed: Note[];
  updated: NoteReplacement[];
  bpmsBefore?: BpmEvent[];
  bpmsAfter?: BpmEvent[];
  endBeatBefore: Rational;
  endBeatAfter: Rational;
  modifiedBefore: boolean;
  modifiedAfter: boolean;
}
interface TransactionDelta {
  charts: ChartDelta[];
  first?: { before: number; after: number };
  metadata?: { field: string; before: string; after: string };
}
interface PreparedChart { index: number; chart: Chart }
interface SourceEdit { start: number; end: number; value: string }

function cloneRange(range: SourceRange): SourceRange { return { start: range.start, end: range.end }; }

function cloneSlidePath(path: SlidePathData): SlidePathData {
  return {
    command: path.command,
    endPosition: path.endPosition,
    slideBreak: path.slideBreak,
    wait: { ...path.wait },
    move: { ...path.move },
    ...(path.continuations?.length ? { continuations: path.continuations.map((segment) => ({ ...segment })) } : {}),
  };
}

function cloneSlide(slide: SlideData): SlideData {
  const additionalPaths = slide.additionalPaths?.map(cloneSlidePath);
  return {
    ...cloneSlidePath(slide),
    head: slide.head,
    ...(additionalPaths?.length ? { additionalPaths } : {}),
  };
}

function cloneNote(note: Note): Note {
  return {
    ...note,
    beat: { ...note.beat },
    duration: note.duration ? { ...note.duration } : undefined,
    slide: note.slide ? cloneSlide(note.slide) : undefined,
    modifiers: { ...note.modifiers },
    sourceRange: note.sourceRange ? cloneRange(note.sourceRange) : undefined,
  };
}

function cloneChart(chart: Chart): Chart {
  return {
    ...chart,
    diagnostics: chart.diagnostics.map(cloneDiagnostic),
    notes: chart.notes.map(cloneNote),
    bpms: chart.bpms.map((event) => ({ ...event, beat: { ...event.beat } })),
    endBeat: { ...chart.endBeat },
    sourceRange: cloneRange(chart.sourceRange),
  };
}

function validateRange(range: SourceRange, length: number, label: string): void {
  if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start < 0 || range.end < range.start || range.end > length)
    throw new ChartCoreError('invalid-parser-range', `${label} is outside the source text`);
}

function cloneDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return { ...diagnostic, range: cloneRange(diagnostic.range) };
}

function chartDiagnostics(
  diagnostics: readonly Diagnostic[],
  notes: readonly Note[],
  sourceRange: SourceRange,
  difficulty: number,
): Diagnostic[] {
  const result = diagnostics.filter((item) => item.code !== 'slide-validation-pending').map(cloneDiagnostic);
  if (notes.some((note) => note.kind === 'slide')) {
    result.push({
      code: 'slide-validation-pending',
      message: 'Slide runtime behavior in the target player has not been validated.',
      severity: 'warning',
      range: cloneRange(sourceRange),
      difficulty,
    });
  }
  return result;
}

function isMetadataField(field: string): field is typeof METADATA_FIELDS[number] {
  return (METADATA_FIELDS as readonly string[]).includes(field);
}

function emptyMetadata(): Record<string, string> {
  return Object.fromEntries(METADATA_FIELDS.map((field) => [field, '']));
}

function isSingleLine(value: string): boolean {
  return !/[\r\n\u2028\u2029]/.test(value);
}

function sourceBody(rawValue: string): string {
  return rawValue.slice(0, rawValue.length - sourceSuffix(rawValue).length);
}

function metadataFromFields(fields: readonly SourceField[]): { values: Record<string, string>; editable: boolean } {
  const values = emptyMetadata();
  let editable = true;
  for (const field of METADATA_FIELDS) {
    const matches = fields.filter((candidate) => candidate.name === field);
    if (matches.length > 1) editable = false;
    if (matches.length === 1) {
      values[field] = sourceBody(matches[0].rawValue);
      if (!isSingleLine(values[field])) editable = false;
    }
  }
  return { values, editable };
}

function metadataBaseline(document: ChartDocument): Record<string, string> {
  return metadataFromFields(document.fields).values;
}

function validateMetadataRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ChartCoreError('invalid-metadata', 'Checkpoint metadata must be an object');
  const entries = Object.entries(value);
  if (entries.length !== METADATA_FIELDS.length)
    throw new ChartCoreError('invalid-metadata', 'Checkpoint metadata has an incomplete field set');
  const result = emptyMetadata();
  for (const [field, text] of entries) {
    if (!isMetadataField(field) || typeof text !== 'string')
      throw new ChartCoreError('invalid-metadata', `Checkpoint metadata field ${field} is invalid`);
    result[field] = text;
  }
  return result;
}

function normalizeDuration(value: HoldDuration | undefined): HoldDuration | undefined {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'short': return { kind: 'short' };
    case 'seconds':
      if (!Number.isFinite(value.seconds) || value.seconds < 0) throw new ChartCoreError('invalid-duration', 'Hold seconds must be finite and non-negative');
      return { kind: 'seconds', seconds: value.seconds };
    case 'beatsAtStartBpm':
      if (!Number.isSafeInteger(value.division) || value.division <= 0 || !Number.isSafeInteger(value.beats) || value.beats < 0)
        throw new ChartCoreError('invalid-duration', 'Hold division and beats must be non-negative safe integers with a positive division');
      return { kind: 'beatsAtStartBpm', division: value.division, beats: value.beats };
    case 'beatsAtBpm':
      if (!Number.isFinite(value.bpm) || value.bpm <= 0 || !Number.isSafeInteger(value.division) || value.division <= 0
        || !Number.isSafeInteger(value.beats) || value.beats < 0)
        throw new ChartCoreError('invalid-duration', 'Hold BPM must be positive and division/beats must be valid integers');
      return { kind: 'beatsAtBpm', bpm: value.bpm, division: value.division, beats: value.beats };
    default:
      throw new ChartCoreError('invalid-duration', 'Unsupported Hold duration kind');
  }
}

function validSlideDistance(command: SlidePathData['command'], distance: number): boolean {
  if (command === '-') return distance >= 2 && distance <= 6;
  if (command === 'w' || command === 's' || command === 'z') return distance === 4;
  if (command === 'v') return distance !== 0 && distance !== 4;
  return true;
}

function invalidSlideDistanceMessage(command: SlidePathData['command']): string {
  if (command === '-') return 'Straight Slides must span two through six ring positions.';
  if (command === 'w') return 'Wi-Fi Slides must end opposite their start position.';
  if (command === 'v') return 'v Slides cannot end at their start or opposite position.';
  if (command === 's' || command === 'z') return `${command} Slides must end opposite their start position.`;
  return 'Slide path has an invalid endpoint distance.';
}

function normalizeSegment(value: SlideSegmentData, startPosition: number): SlideSegmentData {
  if (!value || !['-', '<', '>', 'v', 's', 'z'].includes(value.command))
    throw new ChartCoreError('invalid-slide-segment', 'Connected Slide segments support -, <, >, v, s, and z commands only');
  if (!Number.isInteger(value.endPosition) || value.endPosition < 1 || value.endPosition > 8)
    throw new ChartCoreError('invalid-slide-end-position', 'Slide segment endpoint must be a ring position from 1 to 8');
  const distance = (value.endPosition - startPosition + 8) % 8;
  if (!validSlideDistance(value.command, distance))
    throw new ChartCoreError('invalid-slide-path', invalidSlideDistanceMessage(value.command));
  try {
    slideSegmentLength(value, startPosition);
  } catch {
    throw new ChartCoreError('invalid-slide-path', `No serialized path geometry exists for ${value.command} ${startPosition}→${value.endPosition}`);
  }
  return { command: value.command, endPosition: value.endPosition };
}

function normalizeSlidePath(value: SlidePathData, startPosition: number): SlidePathData {
  if (!value || !['-', '<', '>', 'w', 'v', 's', 'z'].includes(value.command))
    throw new ChartCoreError('invalid-slide', 'Slide needs a supported path command');
  if (!Number.isInteger(value.endPosition) || value.endPosition < 1 || value.endPosition > 8)
    throw new ChartCoreError('invalid-slide-end-position', 'Slide endpoint must be a ring position from 1 to 8');
  const distance = (value.endPosition - startPosition + 8) % 8;
  if (!validSlideDistance(value.command, distance))
    throw new ChartCoreError('invalid-slide-path', invalidSlideDistanceMessage(value.command));
  if (value.command !== 'w') {
    try {
      slideSegmentLength({ command: value.command, endPosition: value.endPosition }, startPosition);
    } catch {
      throw new ChartCoreError('invalid-slide-path', `No serialized path geometry exists for ${value.command} ${startPosition}→${value.endPosition}`);
    }
  }
  if (typeof value.slideBreak !== 'boolean') throw new ChartCoreError('invalid-slide-break', 'Slide break flag must be boolean');
  const wait = normalizeDuration(value.wait);
  const move = normalizeDuration(value.move);
  if (!wait || wait.kind === 'short' || !move || move.kind === 'short')
    throw new ChartCoreError('invalid-slide-duration', 'Slide wait and move need explicit non-short duration expressions');
  if (value.continuations !== undefined
    && (!Array.isArray(value.continuations) || value.continuations.length + 1 > MAX_SLIDE_SEGMENTS))
    throw new ChartCoreError('slide-segment-count', `A continuous Slide path can contain at most ${MAX_SLIDE_SEGMENTS} segments`);
  if (value.command === 'w' && value.continuations?.length)
    throw new ChartCoreError('wifi-continuation', 'Wi-Fi Slides cannot contain connected segments');
  let previousPosition = value.endPosition;
  const continuations = value.continuations?.map((segment) => {
    const normalized = normalizeSegment(segment, previousPosition);
    previousPosition = normalized.endPosition;
    return normalized;
  });
  return {
    command: value.command,
    endPosition: value.endPosition,
    slideBreak: value.slideBreak,
    wait,
    move,
    ...(continuations?.length ? { continuations } : {}),
  };
}

function normalizeSlide(value: Note['slide'], startPosition: number): SlideData {
  if (!value) throw new ChartCoreError('invalid-slide', 'Slide needs a supported path command');
  if (value.head !== 'star' && value.head !== 'tap' && value.head !== 'none')
    throw new ChartCoreError('invalid-slide-head', 'Slide head must be star, tap, or none');
  if (value.additionalPaths !== undefined
    && (!Array.isArray(value.additionalPaths) || value.additionalPaths.length + 1 > MAX_SLIDE_PATHS))
    throw new ChartCoreError('slide-path-count', `A Slide can contain at most ${MAX_SLIDE_PATHS} paths`);
  const primary = normalizeSlidePath(value, startPosition);
  const additionalPaths = value.additionalPaths?.length
    ? value.additionalPaths.map((path) => normalizeSlidePath(path, startPosition))
    : undefined;
  return {
    ...primary,
    head: value.head,
    ...(additionalPaths?.length ? { additionalPaths } : {}),
  };
}

function validateChartNoteBudget(notes: readonly Note[]): void {
  const expandedCount = notes.reduce((count, note) => {
    if (note.kind !== 'slide' || !note.slide) return count + 1;
    return count + [note.slide, ...(note.slide.additionalPaths ?? [])]
      .reduce((pathCount, path) => pathCount + 1 + (path.continuations?.length ?? 0), 0);
  }, 0);
  if (notes.length > MAX_NOTES_PER_CHART
    || expandedCount > MAX_NOTES_PER_CHART)
    throw new ChartCoreError('too-many-notes', `A difficulty exceeds the ${MAX_NOTES_PER_CHART} upstream note/segment limit`);
}

function validateNote(note: Note, ids: Set<string>, sourceLength: number, allowGenerated: boolean): Note {
  if (!note || typeof note.id !== 'string' || note.id.length === 0 || ids.has(note.id))
    throw new ChartCoreError('invalid-note-id', 'Note IDs must be non-empty and unique within a difficulty');
  ids.add(note.id);
  if (note.kind !== 'tap' && note.kind !== 'hold' && note.kind !== 'touch' && note.kind !== 'touchHold' && note.kind !== 'slide')
    throw new ChartCoreError('invalid-note-kind', 'Unsupported note kind');
  const beat = validateRational(note.beat);
  if (compareRational(beat, rational(0)) < 0) throw new ChartCoreError('invalid-note-beat', 'Note beat cannot be negative');
  const isTouch = note.kind === 'touch' || note.kind === 'touchHold';
  const isHold = note.kind === 'hold' || note.kind === 'touchHold';
  const isSlide = note.kind === 'slide';
  if (note.forceStar !== undefined && typeof note.forceStar !== 'boolean')
    throw new ChartCoreError('invalid-force-star', 'Static star Tap flag must be a boolean value');
  const forceStar = note.forceStar ?? false;
  if (forceStar && note.kind !== 'tap')
    throw new ChartCoreError('force-star-note-kind', 'Static star is supported only for Tap notes');
  if (note.firework !== undefined && typeof note.firework !== 'boolean')
    throw new ChartCoreError('invalid-firework', 'Touch Firework must be a boolean value');
  const firework = note.firework ?? false;
  if (firework && !isTouch)
    throw new ChartCoreError('firework-note-kind', 'Firework is supported only for Touch and Touch Hold notes');
  if (isTouch) {
    if (!['A', 'B', 'C', 'D', 'E'].includes(note.touchArea ?? ''))
      throw new ChartCoreError('invalid-touch-area', 'Touch notes need an A–E sensor area');
    const validPosition = note.touchArea === 'C'
      ? note.position === 0
      : Number.isInteger(note.position) && note.position >= 1 && note.position <= 8;
    if (!validPosition) throw new ChartCoreError('invalid-touch-position', 'Touch C uses position 0; other areas use positions 1–8');
    if (note.modifiers?.ex) throw new ChartCoreError('touch-ex-unsupported', 'EX Touch and Touch Hold notes are not supported');
  } else {
    if (note.touchArea !== undefined) throw new ChartCoreError('unexpected-touch-area', 'Ring notes cannot have a touch area');
    if (!Number.isInteger(note.position) || note.position < 1 || note.position > 8)
      throw new ChartCoreError('invalid-note-position', 'Ring note position must be between 1 and 8');
  }
  if (!Number.isSafeInteger(note.order) || note.order < 0) throw new ChartCoreError('invalid-note-order', 'Note order must be a non-negative safe integer');
  if (!note.modifiers || typeof note.modifiers.break !== 'boolean' || typeof note.modifiers.ex !== 'boolean')
    throw new ChartCoreError('invalid-note-modifiers', 'Note modifiers must be boolean values');
  const duration = normalizeDuration(note.duration);
  if (!isHold && duration !== undefined) throw new ChartCoreError('tap-duration', 'Only Hold notes can have a Hold duration');
  if (note.kind === 'hold' && duration === undefined && !allowGenerated)
    throw new ChartCoreError('hold-duration', 'Hold notes need a duration expression');
  if (note.kind === 'touchHold' && (duration === undefined || duration.kind === 'short'))
    throw new ChartCoreError('touchhold-duration', 'Touch Hold notes need an explicit non-short duration');
  if (isSlide && duration !== undefined) throw new ChartCoreError('slide-duration', 'Slides use separate wait and move duration expressions');
  const slide = isSlide ? normalizeSlide(note.slide, note.position) : undefined;
  if (!isSlide && note.slide !== undefined) throw new ChartCoreError('unexpected-slide', 'Only Slide notes can have Slide data');
  if (note.sourceRange) validateRange(note.sourceRange, sourceLength, 'Note source range');
  return {
    id: note.id,
    kind: note.kind,
    beat,
    position: note.position,
    touchArea: isTouch ? note.touchArea : undefined,
    firework,
    forceStar,
    order: note.order,
    duration: isHold ? duration ?? { kind: 'short' } : undefined,
    slide,
    modifiers: { ...note.modifiers },
    sourceRange: note.sourceRange ? cloneRange(note.sourceRange) : undefined,
  };
}

function normalizeParserChart(source: ParserChart, sourceLength: number, globalEditable: boolean): Chart {
  if (!Number.isInteger(source.difficulty) || source.difficulty < 1 || source.difficulty > 7)
    throw new ChartCoreError('invalid-difficulty', 'Parser returned a difficulty outside the supported range');
  validateRange(source.sourceRange, sourceLength, `Difficulty ${source.difficulty} source range`);
  validateRange(source.fieldRange, sourceLength, `Difficulty ${source.difficulty} field range`);
  const ids = new Set<string>();
  const notes = source.notes.map((note) => validateNote(note, ids, sourceLength, false));
  validateChartNoteBudget(notes);
  const bpms = source.bpms.map((event) => {
    const beat = validateRational(event.beat);
    if (compareRational(beat, rational(0)) < 0 || !Number.isFinite(event.bpm) || event.bpm <= 0)
      throw new ChartCoreError('invalid-bpm', `Difficulty ${source.difficulty} contains an invalid BPM event`);
    if (event.sourceRange) validateRange(event.sourceRange, sourceLength, 'BPM source range');
    return { beat, bpm: event.bpm };
  });
  const endBeat = validateRational(source.endBeat);
  if (compareRational(endBeat, rational(0)) < 0) throw new ChartCoreError('invalid-end-beat', 'Chart end beat cannot be negative');
  const diagnostics = chartDiagnostics(source.diagnostics, notes, source.sourceRange, source.difficulty);
  const hasBlockingDiagnostic = diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const editable = source.editable && globalEditable && !hasBlockingDiagnostic;
  if (editable) {
    if (notes.some((note) => compareRational(note.beat, endBeat) >= 0))
      throw new ChartCoreError('invalid-end-beat', 'Editable parser notes must precede the terminal chart beat');
    // Empty, valid charts still need a known time origin for future commands.
    if (bpms.length === 0 || !bpms.some((event) => compareRational(event.beat, rational(0)) === 0))
      throw new ChartCoreError('invalid-bpm', 'Editable charts need a BPM event at beat zero');
  }
  return {
    difficulty: source.difficulty,
    editable,
    diagnostics,
    notes,
    bpms,
    endBeat,
    sourceRange: cloneRange(source.sourceRange),
    modified: false,
  };
}

function normalizeParserResult(result: ParserResult, text: string, bytes: Uint8Array, generation: string): ChartDocument {
  if (!result || result.schemaVersion !== 4 || result.sourceLengthUtf16 !== text.length
    || typeof result.parserCommit !== 'string' || typeof result.globalEditable !== 'boolean'
    || !Number.isFinite(result.firstSeconds) || !Array.isArray(result.fields) || !Array.isArray(result.charts)
    || !Array.isArray(result.diagnostics))
    throw new ChartCoreError('invalid-parser-result', 'Parser result does not match the frozen schema');

  const fields: SourceField[] = result.fields.map((field) => {
    validateRange(field.range, text.length, `Field &${field.name} range`);
    validateRange(field.valueRange, text.length, `Field &${field.name} value range`);
    if (field.valueRange.start < field.range.start || field.valueRange.end > field.range.end
      || text.slice(field.valueRange.start, field.valueRange.end) !== field.rawValue)
      throw new ChartCoreError('invalid-parser-field', `Parser source range for &${field.name} is inconsistent`);
    return { name: field.name, range: cloneRange(field.range), valueRange: cloneRange(field.valueRange), rawValue: field.rawValue };
  });
  const seenDifficulties = new Set<number>();
  const charts = result.charts.map((source) => {
    const chart = normalizeParserChart(source, text.length, result.globalEditable);
    if (seenDifficulties.has(chart.difficulty)) throw new ChartCoreError('duplicate-difficulty', `Parser returned duplicate difficulty ${chart.difficulty}`);
    seenDifficulties.add(chart.difficulty);
    return chart;
  });
  const parsedMetadata = metadataFromFields(fields);
  return {
    generation,
    version: 0,
    originalBytes: bytes.slice(),
    originalText: text,
    fields,
    globalEditable: result.globalEditable,
    firstSeconds: result.firstSeconds,
    originalFirstSeconds: result.firstSeconds,
    metadata: parsedMetadata.values,
    metadataEditable: result.globalEditable && parsedMetadata.editable,
    charts,
    diagnostics: result.diagnostics.map(cloneDiagnostic),
  };
}

function validateChartState(chart: Chart, sourceLength: number): Chart {
  if (!Number.isInteger(chart.difficulty) || chart.difficulty < 1 || chart.difficulty > 7 || typeof chart.editable !== 'boolean')
    throw new ChartCoreError('invalid-chart', 'Chart difficulty or editability is invalid');
  validateRange(chart.sourceRange, sourceLength, 'Chart source range');
  const ids = new Set<string>();
  const notes = chart.notes.map((note) => validateNote(note, ids, sourceLength, true));
  validateChartNoteBudget(notes);
  const bpms = chart.bpms.map((event) => {
    const beat = validateRational(event.beat);
    if (compareRational(beat, rational(0)) < 0 || !Number.isFinite(event.bpm) || event.bpm <= 0)
      throw new ChartCoreError('invalid-bpm', `Difficulty ${chart.difficulty} contains an invalid BPM event`);
    return { beat, bpm: event.bpm };
  }).sort((a, b) => compareRational(a.beat, b.beat));
  const endBeat = validateRational(chart.endBeat);
  if (compareRational(endBeat, rational(0)) < 0) throw new ChartCoreError('invalid-end-beat', 'Chart end beat cannot be negative');
  if (chart.editable) {
    if (bpms.length === 0 || !bpms.some((event) => compareRational(event.beat, rational(0)) === 0))
      throw new ChartCoreError('invalid-bpm', 'Editable charts need a BPM event at beat zero');
    if (notes.some((note) => compareRational(note.beat, endBeat) >= 0))
      throw new ChartCoreError('invalid-end-beat', 'Every editable note must precede the terminal chart beat');
  }
  const diagnostics = chartDiagnostics(chart.diagnostics, notes, chart.sourceRange, chart.difficulty);
  const editable = chart.editable && !diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return {
    ...chart,
    editable,
    notes,
    bpms,
    endBeat,
    diagnostics,
    sourceRange: cloneRange(chart.sourceRange),
  };
}

function durationEquivalent(a: HoldDuration | undefined, b: HoldDuration | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'short': return b.kind === 'short';
    case 'seconds': return b.kind === 'seconds' && a.seconds === b.seconds;
    case 'beatsAtStartBpm': return b.kind === 'beatsAtStartBpm'
      && a.division === b.division && a.beats === b.beats;
    case 'beatsAtBpm': return b.kind === 'beatsAtBpm' && a.bpm === b.bpm
      && a.division === b.division && a.beats === b.beats;
  }
}

function noteDurationEquivalent(a: Note, b: Note): boolean {
  return durationEquivalent(a.duration, b.duration);
}

function slidePathEquivalent(a: SlidePathData, b: SlidePathData): boolean {
  const aContinuations = a.continuations ?? [];
  const bContinuations = b.continuations ?? [];
  return a.command === b.command && a.endPosition === b.endPosition
    && a.slideBreak === b.slideBreak && durationEquivalent(a.wait, b.wait) && durationEquivalent(a.move, b.move)
    && aContinuations.length === bContinuations.length
    && aContinuations.every((segment, index) =>
      segment.command === bContinuations[index].command && segment.endPosition === bContinuations[index].endPosition);
}

function slideEquivalent(a: Note['slide'], b: Note['slide']): boolean {
  if (!a || !b) return a === b;
  const aPaths = [a, ...(a.additionalPaths ?? [])];
  const bPaths = [b, ...(b.additionalPaths ?? [])];
  return a.head === b.head && aPaths.length === bPaths.length
    && aPaths.every((path, index) => slidePathEquivalent(path, bPaths[index]));
}

function assertChartSemantics(expected: Chart, actual: Chart, parserNotes?: ParserChart['notes']): void {
  if (expected.difficulty !== actual.difficulty || expected.editable !== actual.editable
    || !equalRational(expected.endBeat, actual.endBeat))
    throw new ChartCoreError('export-semantic-mismatch', `Difficulty ${expected.difficulty} changed structure while exporting`);
  if (expected.bpms.length !== actual.bpms.length || expected.bpms.some((event, index) =>
    !equalRational(event.beat, actual.bpms[index].beat) || event.bpm !== actual.bpms[index].bpm))
    throw new ChartCoreError('export-semantic-mismatch', `Difficulty ${expected.difficulty} changed BPM events while exporting`);
  const left = [...expected.notes].sort(compareNotesByBeat);
  const right = [...actual.notes].sort(compareNotesByBeat);
  if (left.length !== right.length) throw new ChartCoreError('export-semantic-mismatch', `Difficulty ${expected.difficulty} changed the note count while exporting`);
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a.kind !== b.kind || !equalRational(a.beat, b.beat) || a.position !== b.position || a.touchArea !== b.touchArea
      || (a.firework ?? false) !== (b.firework ?? false)
      || (a.forceStar ?? false) !== (b.forceStar ?? false)
      || a.modifiers.break !== b.modifiers.break || a.modifiers.ex !== b.modifiers.ex || !noteDurationEquivalent(a, b)
      || !slideEquivalent(a.slide, b.slide))
      throw new ChartCoreError('export-semantic-mismatch', `Difficulty ${expected.difficulty} changed note ${index + 1} while exporting`);
  }
  if (parserNotes) {
    const byOrder = [...left];
    for (let index = 0; index < byOrder.length; index++) {
      const expectedNote = byOrder[index];
      const parserNote = parserNotes[index];
      const expectedStart = beatToSeconds(expectedNote.beat, expected.bpms);
      const startBpm = bpmAtBeat(expectedNote.beat, expected.bpms);
      const slidePaths = expectedNote.kind === 'slide'
        ? [expectedNote.slide!, ...(expectedNote.slide!.additionalPaths ?? [])]
        : [];
      const expectedMoveStart = slidePaths.length > 0
        ? expectedStart + durationToSeconds(slidePaths[0].wait, startBpm)
        : undefined;
      const expectedEnd = slidePaths.length > 0
        ? Math.max(...slidePaths.map((path) => expectedStart
          + durationToSeconds(path.wait, startBpm) + durationToSeconds(path.move, startBpm)))
        : expectedStart;
      const expectedDuration = slidePaths.length > 0
        ? expectedEnd - expectedStart
        : expectedNote.kind === 'hold' || expectedNote.kind === 'touchHold'
        ? durationToSeconds(expectedNote.duration ?? { kind: 'short' }, bpmAtBeat(expectedNote.beat, expected.bpms))
        : 0;
      const moveStartMatches = expectedMoveStart === undefined
        ? parserNote.moveStartSeconds == null
        : parserNote.moveStartSeconds !== undefined && Number.isFinite(parserNote.moveStartSeconds)
          && close(parserNote.moveStartSeconds, expectedMoveStart);
      if (!close(parserNote.startSeconds, expectedStart) || !close(parserNote.durationSeconds, expectedDuration) || !moveStartMatches)
        throw new ChartCoreError('export-timing-mismatch', `Difficulty ${expected.difficulty} timing changed while exporting`);
    }
  }
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b)) * 1e-10);
}

function equalRational(a: Rational, b: Rational): boolean {
  return compareRational(a, b) === 0;
}

function bpmArraysEqual(a: readonly BpmEvent[], b: readonly BpmEvent[]): boolean {
  return a.length === b.length && a.every((event, index) =>
    equalRational(event.beat, b[index].beat) && event.bpm === b[index].bpm);
}

function sourceSuffix(rawValue: string): string {
  return /(?:(?:\r\n|\n|\r))*$/.exec(rawValue)?.[0] ?? '';
}

function lineEnding(text: string): string {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\n')) return '\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

function changedMetadataFields(document: ChartDocument): string[] {
  const baseline = metadataBaseline(document);
  return METADATA_FIELDS.filter((field) => document.metadata[field] !== baseline[field]);
}

function appendedFieldNames(document: ChartDocument, changedMetadata: readonly string[]): string[] {
  const names = changedMetadata.filter((field) => !document.fields.some((candidate) => candidate.name === field));
  if (document.firstSeconds !== document.originalFirstSeconds
    && !document.fields.some((candidate) => candidate.name === 'first')) names.push('first');
  return names;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new ChartCoreError('invalid-number', 'Cannot serialize a non-finite number');
  return value.toString();
}

function replaceSource(text: string, edits: SourceEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start
    || Number(a.start !== a.end) - Number(b.start !== b.end));
  let previousStart = text.length + 1;
  let candidate = text;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > text.length
      || edit.end > previousStart)
      throw new ChartCoreError('overlapping-source-edits', 'Generated field replacements overlap or exceed the source');
    candidate = `${candidate.slice(0, edit.start)}${edit.value}${candidate.slice(edit.end)}`;
    previousStart = edit.start;
  }
  return candidate;
}

function sourceEditsFor(document: ChartDocument): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const metadataChanges = changedMetadataFields(document);
  if (metadataChanges.length > 0 && !document.metadataEditable)
    throw new ChartCoreError('readonly-metadata', 'Metadata fields are read-only or ambiguous');
  const appended: string[] = [];

  for (const name of metadataChanges) {
    if (!isMetadataField(name) || !isSingleLine(document.metadata[name]))
      throw new ChartCoreError('invalid-metadata', `Metadata field ${name} must be a known single-line value`);
    const matches = document.fields.filter((candidate) => candidate.name === name);
    if (matches.length > 1) throw new ChartCoreError('duplicate-metadata-field', `Metadata field &${name} is ambiguous`);
    if (matches.length === 1) {
      const field = matches[0];
      edits.push({ start: field.valueRange.start, end: field.valueRange.end, value: `${document.metadata[name]}${sourceSuffix(field.rawValue)}` });
    } else if (document.metadata[name] !== '') {
      appended.push(`&${name}=${document.metadata[name]}`);
    }
  }

  for (const chart of document.charts) {
    if (!chart.modified) continue;
    if (!chart.editable) throw new ChartCoreError('readonly-chart', `Difficulty ${chart.difficulty} is read-only`);
    const field = document.fields.find((candidate) => candidate.name === `inote_${chart.difficulty}`);
    if (!field) throw new ChartCoreError('missing-chart-field', `Difficulty ${chart.difficulty} has no unique source field`);
    if (document.fields.filter((candidate) => candidate.name === field.name).length !== 1)
      throw new ChartCoreError('duplicate-chart-field', `Difficulty ${chart.difficulty} source field is ambiguous`);
    const replacement = `${serializeChart(chart)}${sourceSuffix(field.rawValue)}`;
    edits.push({ start: field.valueRange.start, end: field.valueRange.end, value: replacement });
  }

  if (document.firstSeconds !== document.originalFirstSeconds) {
    if (!document.globalEditable || document.charts.some((chart) => !chart.editable))
      throw new ChartCoreError('readonly-global-first', 'Global &first cannot change while the document or any difficulty is read-only');
    const firstFields = document.fields.filter((field) => field.name === 'first');
    if (firstFields.length > 1) throw new ChartCoreError('duplicate-first-field', 'Global &first field is ambiguous');
    if (firstFields.length === 1) {
      const field = firstFields[0];
      edits.push({ start: field.valueRange.start, end: field.valueRange.end, value: `${formatNumber(document.firstSeconds)}${sourceSuffix(field.rawValue)}` });
    } else {
      appended.push(`&first=${formatNumber(document.firstSeconds)}`);
    }
  }
  if (appended.length > 0) {
    const newline = lineEnding(document.originalText);
    const separator = document.originalText.length === 0 || document.originalText.endsWith('\n') || document.originalText.endsWith('\r') ? '' : newline;
    edits.push({ start: document.originalText.length, end: document.originalText.length, value: `${separator}${appended.join(newline)}${newline}` });
  }
  return edits;
}

function validateFieldsEqual(expected: readonly SourceField[], actual: readonly SourceField[], document: ChartDocument): void {
  const changedMetadata = changedMetadataFields(document);
  const appended = appendedFieldNames(document, changedMetadata);
  if (actual.length !== expected.length + appended.length)
    throw new ChartCoreError('export-structure-mismatch', 'Candidate export changed the source field count');
  const changed = new Set(changedMetadata);
  if (document.firstSeconds !== document.originalFirstSeconds) changed.add('first');
  for (let index = 0; index < expected.length; index++) {
    if (expected[index].name !== actual[index].name || expected[index].rawValue !== actual[index].rawValue
      && !changed.has(expected[index].name) && !expected[index].name.startsWith('inote_'))
      throw new ChartCoreError('export-structure-mismatch', `Candidate export changed unrelated field &${expected[index].name}`);
  }
  for (let index = 0; index < appended.length; index++) {
    const fieldName = appended[index];
    const field = actual[expected.length + index];
    const value = fieldName === 'first' ? formatNumber(document.firstSeconds) : document.metadata[fieldName];
    if (!field || field.name !== fieldName || sourceBody(field.rawValue) !== value)
      throw new ChartCoreError('export-structure-mismatch', `Candidate export changed appended field &${fieldName}`);
  }
}

function validateParserRanges(result: ParserResult, text: string): void {
  if (result.schemaVersion !== 4 || result.sourceLengthUtf16 !== text.length || !Array.isArray(result.charts) || !Array.isArray(result.fields))
    throw new ChartCoreError('invalid-parser-result', 'Candidate parser returned an incompatible result');
}

function noteEquivalent(a: Note, b: Note): boolean {
  return a.kind === b.kind && equalRational(a.beat, b.beat) && a.position === b.position && a.touchArea === b.touchArea
    && (a.firework ?? false) === (b.firework ?? false)
    && (a.forceStar ?? false) === (b.forceStar ?? false)
    && a.modifiers.break === b.modifiers.break && a.modifiers.ex === b.modifiers.ex
    && noteDurationEquivalent(a, b) && slideEquivalent(a.slide, b.slide);
}

function createChartDelta(
  before: Chart,
  after: Chart,
  changes: { added?: Note[]; removed?: Note[]; updated?: NoteReplacement[]; bpmsChanged?: boolean },
): ChartDelta {
  return {
    difficulty: before.difficulty,
    added: changes.added ?? [],
    removed: changes.removed ?? [],
    updated: changes.updated ?? [],
    bpmsBefore: changes.bpmsChanged ? before.bpms : undefined,
    bpmsAfter: changes.bpmsChanged ? after.bpms : undefined,
    endBeatBefore: before.endBeat,
    endBeatAfter: after.endBeat,
    modifiedBefore: before.modified,
    modifiedAfter: after.modified,
  };
}

function buildNotesAfter(chart: Chart, removed: readonly Note[], added: readonly Note[], updated: readonly NoteReplacement[]): Note[] {
  const removeIds = new Set(removed.map((note) => note.id));
  const replacements = new Map(updated.map((change) => [change.before.id, change.after]));
  const notes = chart.notes
    .filter((note) => !removeIds.has(note.id))
    .map((note) => replacements.get(note.id) ?? note);
  notes.push(...added);
  notes.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return notes;
}

function validateExternalDocument(value: unknown): ChartDocument {
  if (!value || typeof value !== 'object') throw new ChartCoreError('invalid-checkpoint', 'Checkpoint document is missing');
  const document = value as ChartDocument;
  if (!(document.originalBytes instanceof Uint8Array) || typeof document.originalText !== 'string'
    || !Array.isArray(document.fields) || !Array.isArray(document.charts) || !Array.isArray(document.diagnostics)
    || typeof document.globalEditable !== 'boolean' || !Number.isSafeInteger(document.version) || document.version < 0
    || typeof document.metadataEditable !== 'boolean'
    || !Number.isFinite(document.firstSeconds) || !Number.isFinite(document.originalFirstSeconds))
    throw new ChartCoreError('invalid-checkpoint', 'Checkpoint contains invalid document fields');
  let decoded: string | undefined;
  try { decoded = UTF8().decode(document.originalBytes); } catch { decoded = undefined; }
  if (decoded !== undefined && decoded !== document.originalText)
    throw new ChartCoreError('invalid-checkpoint', 'Checkpoint UTF-8 bytes do not match its source text');
  if (decoded === undefined && (document.originalText !== '' || document.fields.length || document.charts.length || document.globalEditable))
    throw new ChartCoreError('invalid-checkpoint', 'Undecodable source checkpoints must remain raw and read-only');
  const textLength = document.originalText.length;
  const fields: SourceField[] = document.fields.map((field) => {
    if (!field || typeof field.name !== 'string' || typeof field.rawValue !== 'string') throw new ChartCoreError('invalid-checkpoint', 'Checkpoint field is malformed');
    validateRange(field.range, textLength, 'Checkpoint field range');
    validateRange(field.valueRange, textLength, 'Checkpoint field value range');
    if (field.valueRange.start < field.range.start || field.valueRange.end > field.range.end
      || document.originalText.slice(field.valueRange.start, field.valueRange.end) !== field.rawValue)
      throw new ChartCoreError('invalid-checkpoint', `Checkpoint field &${field.name} does not match original text`);
    return { name: field.name, range: cloneRange(field.range), valueRange: cloneRange(field.valueRange), rawValue: field.rawValue };
  });
  const metadata = validateMetadataRecord(document.metadata);
  const parsedMetadata = metadataFromFields(fields);
  if (document.metadataEditable !== (document.globalEditable && parsedMetadata.editable))
    throw new ChartCoreError('invalid-checkpoint', 'Checkpoint metadata editability does not match its source fields');
  if (!document.metadataEditable && METADATA_FIELDS.some((field) => metadata[field] !== parsedMetadata.values[field]))
    throw new ChartCoreError('invalid-checkpoint', 'Read-only checkpoint metadata cannot be modified');
  if (document.metadataEditable && METADATA_FIELDS.some((field) => !isSingleLine(metadata[field])))
    throw new ChartCoreError('invalid-checkpoint', 'Editable checkpoint metadata must remain single-line');
  const seen = new Set<number>();
  const charts = document.charts.map((chart) => {
    if (!chart || seen.has(chart.difficulty)) throw new ChartCoreError('invalid-checkpoint', 'Checkpoint difficulty IDs must be unique');
    seen.add(chart.difficulty);
    const validated = validateChartState(chart, textLength);
    if (typeof chart.modified !== 'boolean') throw new ChartCoreError('invalid-checkpoint', 'Checkpoint modified state is invalid');
    return validated;
  });
  for (const diagnostic of document.diagnostics) {
    if (!diagnostic || typeof diagnostic.code !== 'string' || typeof diagnostic.message !== 'string'
      || (diagnostic.severity !== 'error' && diagnostic.severity !== 'warning'))
      throw new ChartCoreError('invalid-checkpoint', 'Checkpoint diagnostic is malformed');
    validateRange(diagnostic.range, textLength, 'Checkpoint diagnostic range');
  }
  if (document.firstSeconds !== document.originalFirstSeconds
    && (!document.globalEditable || charts.some((chart) => !chart.editable)))
    throw new ChartCoreError('invalid-checkpoint', 'Checkpoint changes &first while a difficulty is read-only');
  return {
    ...document,
    originalBytes: document.originalBytes.slice(),
    fields,
    metadata,
    charts,
    diagnostics: document.diagnostics.map(cloneDiagnostic),
  };
}

function upgradeLegacySlideEditability(baseline: ChartDocument, checkpoint: ChartDocument): ChartDocument {
  const charts = checkpoint.charts.map((chart) => {
    const original = baseline.charts.find((candidate) => candidate.difficulty === chart.difficulty);
    if (chart.editable || chart.modified || !original?.editable
      || !chart.notes.some((note) => note.kind === 'slide')
      || !original.notes.some((note) => note.kind === 'slide')) return chart;
    return validateChartState({ ...chart, editable: true }, checkpoint.originalText.length);
  });
  return { ...checkpoint, charts };
}

function assertBaseMatchesCheckpoint(base: ChartDocument, checkpoint: ChartDocument): void {
  if (base.globalEditable !== checkpoint.globalEditable || base.originalFirstSeconds !== checkpoint.originalFirstSeconds
    || base.metadataEditable !== checkpoint.metadataEditable
    || base.fields.length !== checkpoint.fields.length || base.charts.length !== checkpoint.charts.length)
    throw new ChartCoreError('invalid-checkpoint', 'Checkpoint structure does not match its original source');
  for (let index = 0; index < base.fields.length; index++) {
    const a = base.fields[index];
    const b = checkpoint.fields[index];
    if (a.name !== b.name || a.rawValue !== b.rawValue || a.range.start !== b.range.start || a.range.end !== b.range.end
      || a.valueRange.start !== b.valueRange.start || a.valueRange.end !== b.valueRange.end)
      throw new ChartCoreError('invalid-checkpoint', 'Checkpoint source fields do not match parser output');
  }
  if (!base.metadataEditable && METADATA_FIELDS.some((field) => base.metadata[field] !== checkpoint.metadata[field]))
    throw new ChartCoreError('invalid-checkpoint', 'Checkpoint changed metadata while it is read-only');
  for (const original of base.charts) {
    const current = checkpoint.charts.find((chart) => chart.difficulty === original.difficulty);
    if (!current) throw new ChartCoreError('invalid-checkpoint', `Checkpoint is missing difficulty ${original.difficulty}`);
    if (current.editable !== original.editable || current.sourceRange.start !== original.sourceRange.start
      || current.sourceRange.end !== original.sourceRange.end)
      throw new ChartCoreError('invalid-checkpoint', `Checkpoint changed the source identity of difficulty ${original.difficulty}`);
    if (!original.editable && current.modified)
      throw new ChartCoreError('invalid-checkpoint', `Read-only difficulty ${original.difficulty} cannot be modified`);
    if (!current.modified) assertChartSemantics(original, current);
  }
}

function hasConnectedSlideSegments(note: Note): boolean {
  if (!note.slide) return false;
  const paths = [note.slide, ...(Array.isArray(note.slide.additionalPaths) ? note.slide.additionalPaths : [])];
  return paths.some((path) => path !== null && typeof path === 'object'
    && Object.prototype.hasOwnProperty.call(path, 'continuations'));
}

export class ChartEngine {
  private document?: ChartDocument;
  private readonly undoStack: TransactionDelta[] = [];
  private readonly redoStack: TransactionDelta[] = [];
  private generatedId = 0;

  constructor(private readonly parse: (text: string) => Promise<ParserResult>) {}

  async import(bytes: Uint8Array, generation: string): Promise<DisplaySnapshot> {
    if (!(bytes instanceof Uint8Array) || generation.length === 0) throw new ChartCoreError('invalid-import', 'Import needs UTF-8 bytes and a non-empty generation');
    const rawBytes = bytes.slice();
    let text: string;
    try {
      text = UTF8().decode(rawBytes);
    } catch {
      const diagnostic: Diagnostic = {
        code: 'invalid-utf8',
        message: 'The source is not valid UTF-8. It is retained for raw download and remains read-only.',
        severity: 'error',
        range: { start: 0, end: 0 },
      };
      const candidate: ChartDocument = {
        generation,
        version: 0,
        originalBytes: rawBytes,
        originalText: '',
        fields: [],
        globalEditable: false,
        firstSeconds: 0,
        originalFirstSeconds: 0,
        metadata: emptyMetadata(),
        metadataEditable: false,
        charts: [],
        diagnostics: [diagnostic],
      };
      const snapshot = this.createSnapshot(candidate, false, false);
      this.commitImport(candidate);
      return snapshot;
    }

    const parserResult = await this.parse(text);
    const candidate = normalizeParserResult(parserResult, text, rawBytes, generation);
    const snapshot = this.createSnapshot(candidate, false, false);
    this.commitImport(candidate);
    return snapshot;
  }

  apply(request: EditRequest): DisplaySnapshot {
    const document = this.requireDocument();
    this.assertVersion(request.generation, request.baseVersion);
    if (!Number.isSafeInteger(request.requestId) || request.requestId < 0)
      throw new ChartCoreError('invalid-request-id', 'Edit request ID must be a non-negative safe integer');
    if (request.command.type === 'undo') return this.undo(document);
    if (request.command.type === 'redo') return this.redo(document);
    const { transaction, charts, firstSeconds, metadata, nextGeneratedId } = this.prepareCommand(document, request.command);
    if (!transaction) return this.snapshot();
    const nextDocument: ChartDocument = {
      ...document,
      version: document.version + 1,
      charts: charts ?? document.charts,
      firstSeconds: firstSeconds ?? document.firstSeconds,
      metadata: metadata ?? document.metadata,
    };
    const candidateText = replaceSource(nextDocument.originalText, sourceEditsFor(nextDocument));
    if (candidateText.length > MAX_SOURCE_LENGTH_UTF16)
      throw new ChartCoreError('source-too-large', `Generated source exceeds ${MAX_SOURCE_LENGTH_UTF16} UTF-16 code units`);
    const snapshot = this.createSnapshot(nextDocument, true, false);
    this.document = nextDocument;
    this.generatedId = nextGeneratedId;
    this.pushHistory(transaction);
    this.redoStack.length = 0;
    return snapshot;
  }

  async export(generation: string, baseVersion: number): Promise<ExportResult> {
    const document = this.requireDocument();
    this.assertVersion(generation, baseVersion);
    if (!this.isModified(document)) {
      const text = document.originalText;
      return { generation, version: document.version, bytes: document.originalBytes.slice(), text, diagnostics: document.diagnostics.map(cloneDiagnostic) };
    }
    if (document.originalText === '' && document.originalBytes.length !== 0)
      throw new ChartCoreError('readonly-encoding', 'An undecodable file can only be exported as its original bytes');

    const candidateText = replaceSource(document.originalText, sourceEditsFor(document));
    if (candidateText.length > MAX_SOURCE_LENGTH_UTF16)
      throw new ChartCoreError('source-too-large', `Generated source exceeds ${MAX_SOURCE_LENGTH_UTF16} UTF-16 code units`);
    const parserResult = await this.parse(candidateText);
    validateParserRanges(parserResult, candidateText);
    const parsed = normalizeParserResult(parserResult, candidateText, new TextEncoder().encode(candidateText), generation);
    validateFieldsEqual(document.fields, parsed.fields, document);
    if (parsed.globalEditable !== document.globalEditable || !close(parsed.firstSeconds, document.firstSeconds))
      throw new ChartCoreError('export-structure-mismatch', 'Candidate export changed document-level metadata');
    if (parsed.metadataEditable !== document.metadataEditable
      || METADATA_FIELDS.some((field) => parsed.metadata[field] !== document.metadata[field]))
      throw new ChartCoreError('export-structure-mismatch', 'Candidate export changed descriptive metadata');
    if (parsed.charts.length !== document.charts.length)
      throw new ChartCoreError('export-structure-mismatch', 'Candidate export changed the difficulty count');
    for (const expected of document.charts) {
      const actual = parsed.charts.find((chart) => chart.difficulty === expected.difficulty);
      if (!actual) throw new ChartCoreError('export-structure-mismatch', `Candidate export lost difficulty ${expected.difficulty}`);
      const parserChart = parserResult.charts.find((chart) => chart.difficulty === expected.difficulty);
      assertChartSemantics(expected, actual, parserChart?.notes);
    }

    const bytes = new TextEncoder().encode(candidateText);
    return {
      generation,
      version: document.version,
      bytes,
      text: candidateText,
      diagnostics: parserResult.diagnostics.map(cloneDiagnostic),
    };
  }

  checkpoint(generation: string, baseVersion: number): Checkpoint {
    const document = this.requireDocument();
    this.assertVersion(generation, baseVersion);
    return {
      schemaVersion: 5,
      createdAt: new Date().toISOString(),
      document: {
        ...document,
        originalBytes: document.originalBytes.slice(),
        metadata: { ...document.metadata },
        fields: document.fields.map((field) => ({
          ...field,
          range: cloneRange(field.range),
          valueRange: cloneRange(field.valueRange),
        })),
        charts: document.charts.map(cloneChart),
        diagnostics: document.diagnostics.map(cloneDiagnostic),
      },
    };
  }

  async restore(checkpoint: Checkpoint, generation: string): Promise<DisplaySnapshot> {
    if (!checkpoint || (checkpoint.schemaVersion !== 3 && checkpoint.schemaVersion !== 4 && checkpoint.schemaVersion !== 5)
      || !Number.isFinite(Date.parse(checkpoint.createdAt)) || generation.length === 0)
      throw new ChartCoreError('invalid-checkpoint', 'Checkpoint version, timestamp, or generation is invalid');
    if (checkpoint.schemaVersion <= 4 && Array.isArray(checkpoint.document?.charts)
      && checkpoint.document.charts.some((chart) => Array.isArray(chart?.notes)
        && chart.notes.some((note) => note?.kind === 'slide' && hasConnectedSlideSegments(note))))
      throw new ChartCoreError('invalid-checkpoint', 'Schema-3/4 checkpoints cannot contain connected Slide segments');
    if (checkpoint.schemaVersion === 3 && Array.isArray(checkpoint.document?.charts)
      && checkpoint.document.charts.some((chart) => Array.isArray(chart?.notes)
        && chart.notes.some((note) => note?.slide !== undefined
          && Object.prototype.hasOwnProperty.call(note.slide, 'additionalPaths'))))
      throw new ChartCoreError('invalid-checkpoint', 'Schema-3 checkpoints cannot contain additional shared-head Slide paths');
    let candidate = validateExternalDocument(checkpoint.document);
    let baseline: ChartDocument | undefined;
    if (candidate.originalText.length > 0 || candidate.originalBytes.length === 0) {
      const parserResult = await this.parse(candidate.originalText);
      baseline = normalizeParserResult(parserResult, candidate.originalText, candidate.originalBytes, generation);
      candidate = upgradeLegacySlideEditability(baseline, candidate);
      assertBaseMatchesCheckpoint(baseline, candidate);
    }
    const restoredText = replaceSource(candidate.originalText, sourceEditsFor(candidate));
    if (restoredText.length > MAX_SOURCE_LENGTH_UTF16)
      throw new ChartCoreError('source-too-large', `Generated source exceeds ${MAX_SOURCE_LENGTH_UTF16} UTF-16 code units`);
    candidate.generation = generation;
    const snapshot = this.createSnapshot(candidate, false, false);
    this.document = candidate;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.generatedId = 0;
    return snapshot;
  }

  private prepareCommand(document: ChartDocument, command: Exclude<EditCommand, { type: 'undo' | 'redo' }>): {
    transaction?: TransactionDelta;
    charts?: Chart[];
    firstSeconds?: number;
    metadata?: Record<string, string>;
    nextGeneratedId: number;
  } {
    if (command.type === 'set-metadata') {
      if (!isMetadataField(command.field)) throw new ChartCoreError('invalid-metadata-field', `Metadata field &${command.field} is not editable`);
      if (typeof command.value !== 'string' || !isSingleLine(command.value))
        throw new ChartCoreError('invalid-metadata-value', 'Metadata values must be single-line strings');
      if (!document.metadataEditable) throw new ChartCoreError('readonly-metadata', 'Metadata fields are read-only or ambiguous');
      const before = document.metadata[command.field];
      if (before === command.value) return { nextGeneratedId: this.generatedId };
      const metadata = { ...document.metadata, [command.field]: command.value };
      return {
        transaction: { charts: [], metadata: { field: command.field, before, after: command.value } },
        metadata,
        nextGeneratedId: this.generatedId,
      };
    }
    if (command.type === 'set-first') {
      if (!Number.isFinite(command.seconds)) throw new ChartCoreError('invalid-first', '&first must be finite');
      if (!document.globalEditable || document.charts.some((chart) => !chart.editable))
        throw new ChartCoreError('readonly-global-first', 'Global &first is disabled while any difficulty is read-only');
      if (command.seconds === document.firstSeconds) return { nextGeneratedId: this.generatedId };
      return {
        transaction: { charts: [], first: { before: document.firstSeconds, after: command.seconds } },
        firstSeconds: command.seconds,
        nextGeneratedId: this.generatedId,
      };
    }

    const chartIndex = document.charts.findIndex((chart) => chart.difficulty === command.difficulty);
    if (chartIndex < 0) throw new ChartCoreError('missing-difficulty', `Difficulty ${command.difficulty} does not exist`);
    const before = document.charts[chartIndex];
    if (!before.editable) throw new ChartCoreError('readonly-chart', `Difficulty ${command.difficulty} is read-only`);
    let notes = before.notes;
    let bpms = before.bpms;
    let endBeat = before.endBeat;
    let added: Note[] = [];
    let removed: Note[] = [];
    let updated: NoteReplacement[] = [];
    let bpmsChanged = false;
    let nextGeneratedId = this.generatedId;

    if (command.type === 'add') {
      if (!Array.isArray(command.notes) || command.notes.length === 0) throw new ChartCoreError('empty-edit', 'Add needs at least one note');
      if (before.notes.length + command.notes.length > MAX_NOTES_PER_CHART)
        throw new ChartCoreError('too-many-notes', `A difficulty exceeds ${MAX_NOTES_PER_CHART} notes`);
      const used = new Set(before.notes.map((note) => note.id));
      let order = before.notes.reduce((maximum, note) => Math.max(maximum, note.order), -1) + 1;
      added = command.notes.map((input) => {
        let id = `${document.generation}:n${nextGeneratedId++}`;
        while (used.has(id)) id = `${document.generation}:n${nextGeneratedId++}`;
        const note: Note = {
          ...input,
          id,
          order: order++,
          sourceRange: undefined,
        };
        const validated = validateNote(note, used, document.originalText.length, true);
        return validated;
      });
      notes = [...before.notes, ...added];
      endBeat = chartEndAfterNotes({ ...before, notes });
    } else if (command.type === 'update') {
      if (!Array.isArray(command.changes) || command.changes.length === 0) throw new ChartCoreError('empty-edit', 'Update needs at least one note change');
      const ids = new Set<string>();
      const currentById = new Map(before.notes.map((note) => [note.id, note]));
      const targets = new Set(command.changes.map((change) => change.id));
      const validatedIds = new Set(before.notes.filter((note) => !targets.has(note.id)).map((note) => note.id));
      for (const change of command.changes) {
        if (ids.has(change.id)) throw new ChartCoreError('duplicate-edit-target', `Note ${change.id} occurs more than once in the batch`);
        ids.add(change.id);
        const oldNote = currentById.get(change.id);
        if (!oldNote) throw new ChartCoreError('missing-note', `Note ${change.id} does not exist`);
        if (!change.patch || Object.keys(change.patch).length === 0) continue;
        const candidate = validateNote({
          ...oldNote,
          ...change.patch,
          id: oldNote.id,
          order: oldNote.order,
          modifiers: change.patch.modifiers ? { ...change.patch.modifiers } : oldNote.modifiers,
        }, validatedIds, document.originalText.length, true);
        if (noteEquivalent(oldNote, candidate)) continue;
        updated.push({ before: oldNote, after: candidate });
      }
      if (updated.length === 0) return { nextGeneratedId };
      const replacements = new Map(updated.map((change) => [change.before.id, change.after]));
      notes = before.notes.map((note) => replacements.get(note.id) ?? note);
      endBeat = chartEndAfterNotes({ ...before, notes });
    } else if (command.type === 'delete') {
      if (!Array.isArray(command.ids) || command.ids.length === 0) throw new ChartCoreError('empty-edit', 'Delete needs at least one note ID');
      const ids = new Set(command.ids);
      if (ids.size !== command.ids.length) throw new ChartCoreError('duplicate-edit-target', 'Delete IDs must be unique');
      removed = before.notes.filter((note) => ids.has(note.id));
      if (removed.length !== ids.size) throw new ChartCoreError('missing-note', 'Delete contains an unknown note ID');
      notes = before.notes.filter((note) => !ids.has(note.id));
    } else if (command.type === 'edit-events') {
      const addNotes = command.addNotes ?? [];
      const removeNoteIds = command.removeNoteIds ?? [];
      if (!Array.isArray(addNotes) || !Array.isArray(removeNoteIds)
        || (!addNotes.length && !removeNoteIds.length && command.bpms === undefined))
        throw new ChartCoreError('empty-edit', 'Event edit needs notes or BPM events to change');
      const removeIds = new Set(removeNoteIds);
      if (removeIds.size !== removeNoteIds.length) throw new ChartCoreError('duplicate-edit-target', 'Delete IDs must be unique');
      removed = before.notes.filter((note) => removeIds.has(note.id));
      if (removed.length !== removeIds.size) throw new ChartCoreError('missing-note', 'Delete contains an unknown note ID');
      notes = before.notes.filter((note) => !removeIds.has(note.id));
      if (notes.length + addNotes.length > MAX_NOTES_PER_CHART)
        throw new ChartCoreError('too-many-notes', `A difficulty exceeds ${MAX_NOTES_PER_CHART} notes`);
      const used = new Set(before.notes.map((note) => note.id));
      let order = before.notes.reduce((maximum, note) => Math.max(maximum, note.order), -1) + 1;
      added = addNotes.map((input) => {
        let id = `${document.generation}:n${nextGeneratedId++}`;
        while (used.has(id)) id = `${document.generation}:n${nextGeneratedId++}`;
        const note: Note = { ...input, id, order: order++, sourceRange: undefined };
        return validateNote(note, used, document.originalText.length, true);
      });
      notes = [...notes, ...added];
      if (addNotes.length || removeIds.size) endBeat = chartEndAfterNotes({ ...before, notes });
      if (command.bpms !== undefined) {
        if (!Array.isArray(command.bpms) || command.bpms.length === 0)
          throw new ChartCoreError('invalid-bpms', 'At least one BPM event is required');
        bpms = command.bpms.map((event) => ({ beat: validateRational(event.beat), bpm: event.bpm }))
          .sort((a, b) => compareRational(a.beat, b.beat));
        if (bpms.some((event) => !Number.isFinite(event.bpm) || event.bpm <= 0 || compareRational(event.beat, rational(0)) < 0))
          throw new ChartCoreError('invalid-bpms', 'BPM events need non-negative beats and positive finite BPM values');
        if (!bpms.some((event) => compareRational(event.beat, rational(0)) === 0))
          throw new ChartCoreError('invalid-bpms', 'A BPM event at beat zero is required');
        bpmsChanged = !bpmArraysEqual(before.bpms, bpms);
      }
      if (!added.length && !removed.length && !bpmsChanged) return { nextGeneratedId: this.generatedId };
    } else if (command.type === 'set-bpms') {
      if (!Array.isArray(command.bpms) || command.bpms.length === 0) throw new ChartCoreError('invalid-bpms', 'At least one BPM event is required');
      bpms = command.bpms.map((event) => ({ beat: validateRational(event.beat), bpm: event.bpm }))
        .sort((a, b) => compareRational(a.beat, b.beat));
      if (bpms.some((event) => !Number.isFinite(event.bpm) || event.bpm <= 0 || compareRational(event.beat, rational(0)) < 0))
        throw new ChartCoreError('invalid-bpms', 'BPM events need non-negative beats and positive finite BPM values');
      if (!bpms.some((event) => compareRational(event.beat, rational(0)) === 0))
        throw new ChartCoreError('invalid-bpms', 'A BPM event at beat zero is required');
      bpmsChanged = !bpmArraysEqual(before.bpms, bpms);
      if (!bpmsChanged) return { nextGeneratedId };
    } else {
      const never: never = command;
      throw new ChartCoreError('unsupported-command', `Unsupported command ${(never as { type: string }).type}`);
    }

    if (bpmsChanged) {
      // The strict parser requires E in its own comma cell, after every event.
      const lastBpmBeat = bpms[bpms.length - 1].beat;
      if (compareRational(lastBpmBeat, endBeat) >= 0) endBeat = addRational(lastBpmBeat, rational(1));
    }

    const after = validateChartState({
      ...before,
      notes,
      bpms,
      endBeat,
      modified: true,
    }, document.originalText.length);
    if (after.notes.some((note) => compareRational(note.beat, after.endBeat) >= 0))
      throw new ChartCoreError('invalid-end-beat', 'Editable notes must precede the terminal chart beat');
    const transaction: TransactionDelta = { charts: [createChartDelta(before, after, { added, removed, updated, bpmsChanged })] };
    const charts = [...document.charts];
    charts[chartIndex] = after;
    return { transaction, charts, nextGeneratedId };
  }

  private undo(document: ChartDocument): DisplaySnapshot {
    const transaction = this.undoStack.at(-1);
    if (!transaction) throw new ChartCoreError('nothing-to-undo', 'There is no edit to undo');
    const prepared = this.applyTransactionDelta(document, transaction, false);
    const snapshot = this.createSnapshot(prepared, this.undoStack.length > 1, true);
    this.undoStack.pop();
    this.redoStack.push(transaction);
    this.document = prepared;
    return snapshot;
  }

  private redo(document: ChartDocument): DisplaySnapshot {
    const transaction = this.redoStack.at(-1);
    if (!transaction) throw new ChartCoreError('nothing-to-redo', 'There is no edit to redo');
    const prepared = this.applyTransactionDelta(document, transaction, true);
    const snapshot = this.createSnapshot(prepared, true, this.redoStack.length > 1);
    this.redoStack.pop();
    this.pushHistory(transaction);
    this.document = prepared;
    return snapshot;
  }

  private applyTransactionDelta(document: ChartDocument, transaction: TransactionDelta, forward: boolean): ChartDocument {
    const preparedCharts: PreparedChart[] = [];
    for (const delta of transaction.charts) {
      const index = document.charts.findIndex((chart) => chart.difficulty === delta.difficulty);
      if (index < 0) throw new ChartCoreError('history-diverged', `Difficulty ${delta.difficulty} no longer exists`);
      const chart = document.charts[index];
      const remove = forward ? delta.removed : delta.added;
      const insert = forward ? delta.added : delta.removed;
      const updates = forward ? delta.updated : delta.updated.map(({ before, after }) => ({ before: after, after: before }));
      const notes = buildNotesAfter(chart, remove, insert, updates);
      const candidate = validateChartState({
        ...chart,
        notes,
        bpms: (forward ? delta.bpmsAfter : delta.bpmsBefore) ?? chart.bpms,
        endBeat: forward ? delta.endBeatAfter : delta.endBeatBefore,
        modified: forward ? delta.modifiedAfter : delta.modifiedBefore,
      }, document.originalText.length);
      preparedCharts.push({ index, chart: candidate });
    }
    let firstSeconds = document.firstSeconds;
    if (transaction.first) firstSeconds = forward ? transaction.first.after : transaction.first.before;
    let metadata = document.metadata;
    if (transaction.metadata) {
      if (!document.metadataEditable) throw new ChartCoreError('readonly-metadata', 'History cannot change read-only metadata');
      metadata = { ...document.metadata, [transaction.metadata.field]: forward ? transaction.metadata.after : transaction.metadata.before };
    }
    if (firstSeconds !== document.originalFirstSeconds && (!document.globalEditable || document.charts.some((chart) => !chart.editable)))
      throw new ChartCoreError('readonly-global-first', 'History cannot change &first while a difficulty is read-only');
    const charts = [...document.charts];
    for (const item of preparedCharts) charts[item.index] = item.chart;
    return { ...document, version: document.version + 1, charts, firstSeconds, metadata };
  }

  private pushHistory(transaction: TransactionDelta): void {
    this.undoStack.push(transaction);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
  }

  private commitImport(document: ChartDocument): void {
    this.document = document;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.generatedId = 0;
  }

  private snapshot(): DisplaySnapshot {
    const document = this.requireDocument();
    return this.createSnapshot(document, this.undoStack.length > 0, this.redoStack.length > 0);
  }

  private createSnapshot(document: ChartDocument, canUndo: boolean, canRedo: boolean): DisplaySnapshot {
    const diagnostics = document.diagnostics.filter((diagnostic) => diagnostic.code !== 'slide-validation-pending').map(cloneDiagnostic);
    for (const chart of document.charts)
      diagnostics.push(...chart.diagnostics.filter((diagnostic) => diagnostic.code === 'slide-validation-pending').map(cloneDiagnostic));
    return {
      generation: document.generation,
      version: document.version,
      firstSeconds: document.firstSeconds,
      metadata: { ...document.metadata },
      metadataEditable: document.metadataEditable,
      charts: document.charts.map(compile),
      diagnostics,
      canUndo,
      canRedo,
      modified: this.isModified(document),
    };
  }

  private isModified(document: ChartDocument): boolean {
    return document.firstSeconds !== document.originalFirstSeconds || changedMetadataFields(document).length > 0
      || document.charts.some((chart) => chart.modified);
  }

  private requireDocument(): ChartDocument {
    if (!this.document) throw new ChartCoreError('no-document', 'Import a chart before using the editor');
    return this.document;
  }

  private assertVersion(generation: string, version: number): void {
    const document = this.requireDocument();
    if (generation !== document.generation) throw new ChartCoreError('stale-generation', 'Request belongs to a different document generation');
    if (version !== document.version) throw new ChartCoreError('stale-version', `Request version ${version} does not match current version ${document.version}`);
  }
}
