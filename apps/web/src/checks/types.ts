import type { Note, Rational } from '../../../../packages/chart-core/src/types';

/** Visual Maimai's imported beat-domain data, separate from Simai playback durations. */
export interface VisualCheckPath {
  start: Rational;
  end: Rational;
  segments: { command: NonNullable<Note['slide']>['command']; startPosition: number; endPosition: number }[];
}
export interface VisualCheckNote {
  id: string;
  kind: Note['kind'];
  position: number;
  touchArea?: Note['touchArea'];
  hit: Rational;
  end: Rational;
  ex: boolean;
  head: boolean;
  paths: VisualCheckPath[];
}
export type { VisualCheckResult } from '../../../../packages/chart-core/src/types';
