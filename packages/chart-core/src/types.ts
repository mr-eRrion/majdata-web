/** Quarter-note beats, reduced with positive denominator. */
export interface Rational { numerator: number; denominator: number }
export interface SourceRange { start: number; end: number }
export interface Diagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  range: SourceRange;
  difficulty?: number;
}
export type HoldDuration =
  | { kind: 'short' }
  | { kind: 'beatsAtStartBpm'; division: number; beats: number }
  | { kind: 'beatsAtBpm'; bpm: number; division: number; beats: number }
  | { kind: 'seconds'; seconds: number };
export interface SlideSegmentData {
  command: '-' | '<' | '>' | 'v' | 's' | 'z';
  endPosition: number;
}
export interface SlidePathData {
  command: '-' | '<' | '>' | 'w' | 'v' | 's' | 'z';
  endPosition: number;
  slideBreak: boolean;
  wait: Exclude<HoldDuration, { kind: 'short' }>;
  move: Exclude<HoldDuration, { kind: 'short' }>;
  /** Following segments of one continuous route; move is the whole-route duration. */
  continuations?: SlideSegmentData[];
}
export interface SlideData extends SlidePathData {
  head: 'star' | 'tap' | 'none';
  /** Independent paths from the same head, after the first top-level path. */
  additionalPaths?: SlidePathData[];
}
export interface DisplaySlidePath extends SlidePathData {
  moveStartSeconds: number;
  endSeconds: number;
  segments?: DisplaySlideSegment[];
}
export interface DisplaySlideSegment extends SlideSegmentData {
  startPosition: number;
  moveStartSeconds: number;
  endSeconds: number;
}
export interface Note {
  id: string;
  kind: 'tap' | 'hold' | 'touch' | 'touchHold' | 'slide';
  beat: Rational;
  /** Ring lane, or numbered touch sensor. Center C uses position 0. */
  position: number;
  /** Required for Touch/TouchHold; absent for ring notes. */
  touchArea?: 'A' | 'B' | 'C' | 'D' | 'E';
  /** Touch Firework (`f`); omitted legacy checkpoints mean false. */
  firework?: boolean;
  /** Static star Tap (`$`); omitted legacy checkpoints mean false. */
  forceStar?: boolean;
  order: number;
  duration?: HoldDuration;
  slide?: SlideData;
  modifiers: { break: boolean; ex: boolean };
  sourceRange?: SourceRange;
}
export interface BpmEvent { beat: Rational; bpm: number }
export interface Chart {
  difficulty: number;
  editable: boolean;
  diagnostics: Diagnostic[];
  notes: Note[];
  bpms: BpmEvent[];
  endBeat: Rational;
  sourceRange: SourceRange;
  modified: boolean;
}
export interface SourceField {
  name: string;
  range: SourceRange;
  valueRange: SourceRange;
  rawValue: string;
}
/** Only the Worker owns this mutable document. UI receives DisplaySnapshot. */
export interface ChartDocument {
  generation: string;
  version: number;
  originalBytes: Uint8Array;
  originalText: string;
  fields: SourceField[];
  globalEditable: boolean;
  firstSeconds: number;
  originalFirstSeconds: number;
  /** Editable descriptive fields only; original source remains in fields. */
  metadata: Record<string, string>;
  metadataEditable: boolean;
  charts: Chart[];
  diagnostics: Diagnostic[];
}
export type EditCommand =
  | { type: 'add'; difficulty: number; notes: Omit<Note, 'id' | 'order'>[] }
  | { type: 'update'; difficulty: number; changes: { id: string; patch: Partial<Pick<Note, 'beat' | 'position' | 'touchArea' | 'firework' | 'forceStar' | 'duration' | 'slide' | 'modifiers'>> }[] }
  | { type: 'delete'; difficulty: number; ids: string[] }
  /** Atomic clipboard edit; bpms, when present, replaces the chart's BPM event list. */
  | { type: 'edit-events'; difficulty: number; addNotes?: Omit<Note, 'id' | 'order'>[]; removeNoteIds?: string[]; bpms?: BpmEvent[] }
  | { type: 'set-bpms'; difficulty: number; bpms: BpmEvent[] }
  | { type: 'set-first'; seconds: number }
  | { type: 'set-metadata'; field: string; value: string }
  | { type: 'undo' }
  | { type: 'redo' };
export interface DisplayNote extends Note {
  /** Derived simultaneous-note appearance; never serialized as a modifier. */
  isEach?: boolean;
  /** Same-beat Slide paths, including headless paths; independent of head Each. */
  isSlideEach?: boolean;
  startSeconds: number;
  /** Slide movement begins after its explicit wait; absent on other notes. */
  moveStartSeconds?: number;
  /** All shared-head paths, in source order. */
  slidePaths?: DisplaySlidePath[];
  endSeconds: number;
  bpm: number;
}
/** Derived Visual Maimai checks; never stored in a document or checkpoint. */
export interface VisualCheckResult {
  beat: Rational;
  code: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  severity: 'bad' | 'warning';
}
export type VisualChecks =
  | { available: true; results: VisualCheckResult[] }
  | { available: false; results: []; reason: string };
export interface DisplayChart {
  visualChecks?: VisualChecks;
  difficulty: number;
  editable: boolean;
  diagnostics: Diagnostic[];
  notes: DisplayNote[];
  bpms: BpmEvent[];
  endBeat: Rational;
}
export interface DisplaySnapshot {
  generation: string;
  version: number;
  firstSeconds: number;
  metadata: Record<string, string>;
  metadataEditable: boolean;
  charts: DisplayChart[];
  diagnostics: Diagnostic[];
  canUndo: boolean;
  canRedo: boolean;
  modified: boolean;
}
export interface ExportResult {
  generation: string;
  version: number;
  bytes: Uint8Array;
  text: string;
  diagnostics: Diagnostic[];
}
export interface Checkpoint {
  schemaVersion: 3 | 4 | 5;
  createdAt: string;
  document: ChartDocument;
}
export interface EditRequest {
  generation: string;
  requestId: number;
  baseVersion: number;
  command: EditCommand;
}
