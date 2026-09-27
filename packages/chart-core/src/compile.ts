import type { BpmEvent, Chart, DisplayChart, DisplayNote, DisplaySlidePath, Note, Rational, SlidePathData } from './types.js';
import { addRational, compareRational, rational, rationalKey } from './rational.js';
import { beatToSeconds, bpmAtBeat, durationToSeconds } from './time.js';
import { slideSegmentLength } from './slide-length.js';

const prefixMaxEnd = new WeakMap<DisplayChart, number[]>();

function compileSlidePath(path: SlidePathData, startPosition: number, startSeconds: number, bpm: number): DisplaySlidePath {
  const moveStartSeconds = startSeconds + durationToSeconds(path.wait, bpm);
  const moveSeconds = durationToSeconds(path.move, bpm);
  const endSeconds = moveStartSeconds + moveSeconds;
  const compiled: DisplaySlidePath = {
    command: path.command,
    endPosition: path.endPosition,
    slideBreak: path.slideBreak,
    wait: { ...path.wait },
    move: { ...path.move },
    ...(path.continuations?.length ? { continuations: path.continuations.map((segment) => ({ ...segment })) } : {}),
    moveStartSeconds,
    endSeconds,
  };
  if (path.command === 'w') return compiled;

  const segments = [{ command: path.command, endPosition: path.endPosition }, ...(path.continuations ?? [])];
  const segmentLengths = segments.map((segment, index) => slideSegmentLength(segment, index === 0
    ? startPosition
    : segments[index - 1].endPosition));
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isFinite(totalLength) || totalLength <= 0)
    throw new RangeError('A Slide route must have positive finite serialized path length');

  let segmentStart = startPosition;
  let segmentMoveStart = moveStartSeconds;
  compiled.segments = segments.map((segment, index) => {
    const segmentEnd = index === segments.length - 1
      ? endSeconds
      : segmentMoveStart + moveSeconds * segmentLengths[index] / totalLength;
    const result = {
      startPosition: segmentStart,
      command: segment.command,
      endPosition: segment.endPosition,
      moveStartSeconds: segmentMoveStart,
      endSeconds: segmentEnd,
    };
    segmentStart = segment.endPosition;
    segmentMoveStart = segmentEnd;
    return result;
  });
  return compiled;
}

/** Rebuild all timing and path views, including transient drag previews. */
export function compileNote(note: Note, bpms: readonly BpmEvent[]): DisplayNote {
  const bpm = bpmAtBeat(note.beat, bpms);
  const startSeconds = beatToSeconds(note.beat, bpms);
  if (note.kind === 'slide' && !note.slide) throw new RangeError('Slide notes need path data');
  const slidePathData = note.kind === 'slide' ? [note.slide!, ...(note.slide!.additionalPaths ?? [])] : [];
  const slidePaths = slidePathData.map((path) => compileSlidePath(path, note.position, startSeconds, bpm));
  const moveStartSeconds = slidePaths[0]?.moveStartSeconds;
  const durationSeconds = note.kind === 'slide' ? Math.max(...slidePaths.map((path) => path.endSeconds - startSeconds))
    : note.kind === 'hold' || note.kind === 'touchHold' ? durationToSeconds(note.duration ?? { kind: 'short' }, bpm) : 0;
  const endSeconds = note.kind === 'slide' ? Math.max(...slidePaths.map((path) => path.endSeconds)) : startSeconds + durationSeconds;
  if (!Number.isFinite(endSeconds)) throw new RangeError('Compiled note time exceeds the finite seconds range');
  return {
    ...note,
    beat: { ...note.beat },
    duration: note.duration ? { ...note.duration } : undefined,
    slide: note.slide ? {
      command: note.slide.command,
      endPosition: note.slide.endPosition,
      head: note.slide.head,
      slideBreak: note.slide.slideBreak,
      wait: { ...note.slide.wait },
      move: { ...note.slide.move },
      ...(note.slide.continuations?.length ? {
        continuations: note.slide.continuations.map((segment) => ({ ...segment })),
      } : {}),
      ...(note.slide.additionalPaths?.length ? {
        additionalPaths: note.slide.additionalPaths.map((path) => ({
          command: path.command,
          endPosition: path.endPosition,
          slideBreak: path.slideBreak,
          wait: { ...path.wait },
          move: { ...path.move },
          ...(path.continuations?.length ? {
            continuations: path.continuations.map((segment) => ({ ...segment })),
          } : {}),
        })),
      } : {}),
    } : undefined,
    slidePaths: note.kind === 'slide' ? slidePaths : undefined,
    modifiers: { ...note.modifiers },
    sourceRange: note.sourceRange ? { ...note.sourceRange } : undefined,
    startSeconds,
    moveStartSeconds,
    endSeconds,
    bpm,
  };
}

export function compile(chart: Chart): DisplayChart {
  const simultaneous = new Map<string, number>();
  const simultaneousSlides = new Map<string, number>();
  for (const note of chart.notes) {
    const key = rationalKey(note.beat);
    if (note.kind === 'slide') {
      simultaneousSlides.set(key, (simultaneousSlides.get(key) ?? 0) + 1 + (note.slide?.additionalPaths?.length ?? 0));
      if (note.slide?.head === 'none') continue;
    }
    simultaneous.set(key, (simultaneous.get(key) ?? 0) + 1);
  }
  const notes: DisplayNote[] = chart.notes.map((note) => ({
    ...compileNote(note, chart.bpms),
    isEach: !(note.kind === 'slide' && note.slide?.head === 'none')
      && (simultaneous.get(rationalKey(note.beat)) ?? 0) > 1,
    isSlideEach: note.kind === 'slide' && (simultaneousSlides.get(rationalKey(note.beat)) ?? 0) > 1,
  }));
  notes.sort((a, b) => a.startSeconds - b.startSeconds || a.order - b.order || a.id.localeCompare(b.id));
  const bpms = chart.bpms.map((event) => ({ ...event, beat: { ...event.beat } }));
  bpms.sort((a, b) => compareRational(a.beat, b.beat));
  return {
    difficulty: chart.difficulty,
    editable: chart.editable,
    diagnostics: chart.diagnostics.map((diagnostic) => ({ ...diagnostic, range: { ...diagnostic.range } })),
    notes,
    bpms,
    endBeat: { ...chart.endBeat },
  };
}

/** Returns notes whose point or duration intersects the chart-relative time window. */
export function queryVisible(chart: DisplayChart, startSeconds: number, endSeconds: number): DisplayNote[] {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds < startSeconds)
    throw new RangeError('Visible interval must be finite and ordered');
  let prefix = prefixMaxEnd.get(chart);
  if (!prefix) {
    prefix = new Array<number>(chart.notes.length);
    let maximum = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < chart.notes.length; index++) {
      maximum = Math.max(maximum, chart.notes[index].endSeconds);
      prefix[index] = maximum;
    }
    prefixMaxEnd.set(chart, prefix);
  }

  let low = 0;
  let high = chart.notes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (chart.notes[middle].startSeconds < startSeconds) low = middle + 1;
    else high = middle;
  }
  let first = low;
  while (first > 0 && prefix[first - 1] >= startSeconds) first--;
  const visible: DisplayNote[] = [];
  for (let index = first; index < chart.notes.length && chart.notes[index].startSeconds <= endSeconds; index++) {
    const note = chart.notes[index];
    if (note.endSeconds >= startSeconds) visible.push(note);
  }
  return visible;
}

export function compareNotesByBeat<T extends { beat: Rational; order: number; id: string }>(a: T, b: T): number {
  return compareRational(a.beat, b.beat) || a.order - b.order || a.id.localeCompare(b.id);
}

export function chartEndAfterNotes(chart: Chart): Rational {
  let end = rational(chart.endBeat.numerator, chart.endBeat.denominator);
  for (const note of chart.notes) {
    const after = addRational(note.beat, rational(1));
    if (compareRational(after, end) > 0) end = after;
  }
  return end;
}
