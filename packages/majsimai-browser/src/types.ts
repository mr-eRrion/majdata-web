import type {
  BpmEvent,
  Chart,
  Diagnostic,
  Note,
  SourceField,
} from '../../chart-core/src/types.js';

export interface ParserNote extends Note {
  /** Derived from the locked MajSimai BPM/subdivision rules. */
  startSeconds: number;
  /** Slide movement start; absent for all non-Slide notes. */
  moveStartSeconds?: number;
  /** Slide wait + move, ordinary note duration, or zero for point notes. */
  durationSeconds: number;
}

export interface ParserBpmEvent extends BpmEvent {
  sourceRange?: { start: number; end: number };
}

export interface ParserChart extends Omit<Chart, 'notes' | 'bpms'> {
  level: string;
  designer: string;
  /** Range of the complete &inote_N field block, including its line endings. */
  fieldRange: { start: number; end: number };
  notes: ParserNote[];
  bpms: ParserBpmEvent[];
}

/**
 * Returned by the one-call C# bridge. Ranges are UTF-16 half-open offsets
 * into the original input string, so the TypeScript owner can preserve every
 * unedited source span without reparsing chart syntax.
 */
export interface ParserResult {
  schemaVersion: 4;
  parserCommit: string;
  sourceLengthUtf16: number;
  globalEditable: boolean;
  firstSeconds: number;
  fields: SourceField[];
  charts: ParserChart[];
  diagnostics: Diagnostic[];
}
