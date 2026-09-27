import { describe, expect, it } from 'vitest';
import { ChartCoreError, ChartEngine, compileNote, rational, transformNotes } from '../src/index.js';
import { serializeChart } from '../src/serialize.js';
import type { Chart, Note, SlideData, SlidePathData } from '../src/types.js';
import type { ParserNote } from '../../majsimai-browser/src/types.js';
import { simpleParserResult } from './fixture-parser.js';

const modifiers = { break: false, ex: false };
const source = '&inote_1=(120){4}1,E\n';

function serializableChart(note: Note): Chart {
  return {
    difficulty: 1,
    editable: true,
    diagnostics: [],
    notes: [note],
    bpms: [{ beat: rational(0), bpm: 120 }],
    endBeat: rational(1),
    sourceRange: { start: 0, end: 0 },
    modified: false,
  };
}

function serializableSlide(slide: SlideData, modifiersOverride = modifiers): Note {
  return {
    id: 'slide-source', kind: 'slide', beat: rational(0), position: 1, order: 0,
    modifiers: modifiersOverride, slide,
  };
}

function slideNote(
  id: string,
  order: number,
  head: SlideData['head'],
  wait: SlideData['wait'],
  move: SlideData['move'],
  durationSeconds: number,
  moveStartSeconds: number,
): ParserNote {
  return {
    id,
    kind: 'slide',
    beat: rational(1),
    position: 1,
    order,
    modifiers,
    slide: { command: '-', endPosition: 5, head, slideBreak: false, wait, move },
    startSeconds: 0.5,
    moveStartSeconds,
    durationSeconds,
  };
}

const wait = { kind: 'seconds', seconds: 1 } as const;
const move = { kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 2 } as const;
const starSlide = slideNote('slide-star', 0, 'star', wait, move, 1.5, 1.5);
const hiddenSlide = slideNote(
  'slide-hidden', 1, 'none',
  { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
  { kind: 'beatsAtBpm', bpm: 120, division: 4, beats: 1 },
  1, 1,
);
const tap: ParserNote = {
  id: 'tap', kind: 'tap', beat: rational(1), position: 3, order: 2, modifiers,
  startSeconds: 0.5, durationSeconds: 0,
};

function parserResult(text: string, notes: ParserNote[] = [starSlide, hiddenSlide, tap]) {
  const parsed = simpleParserResult(text);
  const chart = parsed.charts[0];
  return {
    ...parsed,
    charts: [{
      ...chart,
      editable: true,
      endBeat: rational(4),
      bpms: [
        { beat: rational(0), bpm: 120 },
        { beat: rational(3, 2), bpm: 240 },
      ],
      notes,
    }],
  };
}

function editableSlideParserResult(text: string) {
  const parsed = simpleParserResult(text);
  const chart = parsed.charts[0];
  const body = text.slice(chart.sourceRange.start, chart.sourceRange.end);
  const slides = [...body.matchAll(/([1-8])([@!])?([xb]*)([-<>wvsz])([1-8])(b?)\[4:2\]/g)]
    .map((match, index): ParserNote => ({
      id: `slide:${index}`,
      kind: 'slide',
      beat: rational(0),
      position: Number(match[1]),
      order: chart.notes.length + index,
      modifiers: { break: match[3].includes('b'), ex: match[3].includes('x') },
      slide: {
        command: match[4] as SlideData['command'],
        endPosition: Number(match[5]),
        head: match[2] === '@' ? 'tap' : match[2] === '!' ? 'none' : 'star',
        slideBreak: match[6] === 'b',
        wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
        move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
      },
      startSeconds: 0,
      moveStartSeconds: 0.5,
      durationSeconds: 1.5,
    }));
  return {
    ...parsed,
    charts: [{ ...chart, editable: true, notes: [...chart.notes, ...slides] }],
  };
}

function unsupportedSlideParserResult(text: string) {
  const parsed = simpleParserResult(text);
  const chart = parsed.charts[0];
  const diagnostic = {
    code: 'unsupported-slide-feature',
    message: 'Unsupported connected Slide syntax remains source-preserved.',
    severity: 'warning' as const,
    range: chart.sourceRange,
    difficulty: 1,
  };
  return {
    ...parsed,
    charts: [{ ...chart, editable: false, notes: [], diagnostics: [diagnostic] }],
    diagnostics: [diagnostic],
  };
}

function slideInput(command: SlideData['command'] = '-', endPosition = 3): Omit<Note, 'id' | 'order'> {
  return {
    kind: 'slide', beat: rational(0), position: 1, modifiers,
    slide: {
      command, endPosition, head: 'star', slideBreak: false,
      wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
      move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
    },
  };
}

function multiPathInput(): Omit<Note, 'id' | 'order'> {
  const input = slideInput('-', 3);
  input.slide = {
    ...input.slide!,
    wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
    move: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
    continuations: [{ command: '-', endPosition: 5 }],
    additionalPaths: [{
      command: '-', endPosition: 5, slideBreak: true,
      wait: { kind: 'seconds', seconds: 0.25 },
      move: { kind: 'seconds', seconds: 1.5 },
      continuations: [{ command: '-', endPosition: 7 }],
    }],
  };
  return input;
}

function branchParserResult(text: string) {
  const parsed = simpleParserResult(text);
  const chart = parsed.charts[0];
  const body = text.slice(chart.sourceRange.start, chart.sourceRange.end);
  const notes = [...chart.notes];
  const ratio = (source: string) => {
    const match = /^(\d+):(\d+)$/.exec(source);
    if (!match) throw new Error(`Unsupported test slide timing ${source}`);
    return {
      wait: { kind: 'beatsAtStartBpm' as const, division: 4, beats: 1 },
      move: { kind: 'beatsAtStartBpm' as const, division: Number(match[1]), beats: Number(match[2]) },
    };
  };
  const timing = (source: string): Pick<SlidePathData, 'wait' | 'move'> => {
    const fixed = /^(\d+(?:\.\d+)?)##(\d+(?:\.\d+)?)$/.exec(source);
    if (fixed) return {
      wait: { kind: 'seconds', seconds: Number(fixed[1]) },
      move: { kind: 'seconds', seconds: Number(fixed[2]) },
    };
    return ratio(source);
  };
  const seconds = (duration: SlidePathData['wait']) => duration.kind === 'seconds'
    ? duration.seconds
    : 60 / 120 * 4 / duration.division * duration.beats;

  const pattern = /([1-8])([@!])?([xb]*)([-<>wvsz])([1-8])((?:[-<>vsz][1-8])*)(b?)\[([^\]]+)\]((?:\*[-<>wvsz][1-8](?:[-<>vsz][1-8])*b?\[[^\]]+\])*)/g;
  const parsePath = (
    command: string,
    endpoint: string,
    tail: string,
    slideBreak: string,
    sourceTiming: string,
  ): SlidePathData => {
    const continuations = [...tail.matchAll(/([-<>vsz])([1-8])/g)].map((segment) => ({
      command: segment[1] as '-' | '<' | '>' | 'v' | 's' | 'z',
      endPosition: Number(segment[2]),
    }));
    return {
      command: command as SlidePathData['command'],
      endPosition: Number(endpoint),
      slideBreak: slideBreak === 'b',
      ...timing(sourceTiming),
      ...(continuations.length ? { continuations } : {}),
    };
  };
  for (const match of body.matchAll(pattern)) {
    const primary = parsePath(match[4], match[5], match[6], match[7], match[8]);
    const additionalPaths: SlidePathData[] = [...match[9].matchAll(/\*([-<>wvsz])([1-8])((?:[-<>vsz][1-8])*)(b?)\[([^\]]+)\]/g)]
      .map((branch) => parsePath(branch[1], branch[2], branch[3], branch[4], branch[5]));
    const paths = [primary, ...additionalPaths];
    notes.push({
      id: `slide:${notes.length}`,
      kind: 'slide',
      beat: rational(0),
      position: Number(match[1]),
      order: notes.length,
      modifiers: { break: match[3].includes('b'), ex: match[3].includes('x') },
      slide: {
        ...primary,
        head: match[2] === '@' ? 'tap' : match[2] === '!' ? 'none' : 'star',
        ...(additionalPaths.length ? { additionalPaths } : {}),
      },
      startSeconds: 0,
      moveStartSeconds: seconds(paths[0].wait),
      durationSeconds: Math.max(...paths.map((path) => seconds(path.wait) + seconds(path.move))),
    });
  }
  return { ...parsed, charts: [{ ...chart, editable: true, notes }] };
}

describe('single-segment Slide core model', () => {
  it('validates and serializes v/s/z paths in transactions, connected routes, and shared heads', async () => {
    const engine = new ChartEngine(async (text) => editableSlideParserResult(text));
    let snapshot = await engine.import(new TextEncoder().encode(source), 'slide-vsz');
    for (const input of [slideInput('v', 2), slideInput('s', 5), slideInput('z', 5)]) {
      snapshot = engine.apply({
        generation: 'slide-vsz', requestId: snapshot.version + 1, baseVersion: snapshot.version,
        command: { type: 'add', difficulty: 1, notes: [input] },
      });
    }
    expect(snapshot.charts[0].notes.filter((note) => note.kind === 'slide')).toHaveLength(3);

    for (const input of [slideInput('v', 1), slideInput('v', 5), slideInput('s', 4), slideInput('z', 4)]) {
      expect(() => engine.apply({
        generation: 'slide-vsz', requestId: snapshot.version + 1, baseVersion: snapshot.version,
        command: { type: 'add', difficulty: 1, notes: [input] },
      })).toThrow(expect.objectContaining({ code: 'invalid-slide-path' }));
    }
    expect(engine.checkpoint('slide-vsz', snapshot.version).document.charts[0].notes)
      .toHaveLength(snapshot.charts[0].notes.length);

    const connectedAndShared = serializableSlide({
      command: 'v', endPosition: 2, head: 'tap', slideBreak: false,
      wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
      move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
      continuations: [{ command: 's', endPosition: 6 }],
      additionalPaths: [{
        command: 'z', endPosition: 5, slideBreak: true,
        wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
        move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
      }],
    });
    expect(serializeChart(serializableChart(connectedAndShared)))
      .toBe('(120){4}1@v2s6[4:2]*z5b[4:2],E');
  });

  it('serializes only source-verified wait/move pairs and retains head and break flags', () => {
    const cases: Array<[SlideData['wait'], SlideData['move'], string]> = [
      [{ kind: 'beatsAtStartBpm', division: 4, beats: 1 }, { kind: 'beatsAtStartBpm', division: 4, beats: 2 }, '1b-5b[4:2]'],
      [{ kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 }, { kind: 'beatsAtBpm', bpm: 240, division: 8, beats: 1 }, '1-5[240#8:1]'],
      [{ kind: 'seconds', seconds: 0.25 }, { kind: 'beatsAtStartBpm', division: 8, beats: 1 }, '1-5[0.25##8:1]'],
      [{ kind: 'seconds', seconds: 0.25 }, { kind: 'beatsAtBpm', bpm: 240, division: 8, beats: 1 }, '1-5[0.25##240#8:1]'],
      [{ kind: 'beatsAtBpm', bpm: 240, division: 4, beats: 1 }, { kind: 'seconds', seconds: 0.5 }, '1-5[240#0.5]'],
      [{ kind: 'seconds', seconds: 0.25 }, { kind: 'seconds', seconds: 0.5 }, '1-5[0.25##0.5]'],
    ];
    for (const [wait, move, expected] of cases) {
      const note = serializableSlide(
        { command: '-', endPosition: 5, head: 'star', slideBreak: expected.includes('b['), wait, move },
        expected.startsWith('1b') ? { break: true, ex: false }
          : expected.startsWith('1x') ? { break: false, ex: true } : modifiers,
      );
      expect(serializeChart(serializableChart(note))).toBe(`(120){4}${expected},E`);
    }
    for (const [head, marker] of [['star', ''], ['tap', '@'], ['none', '!']] as const) {
      for (const breakFlag of [false, true]) {
        for (const exFlag of [false, true]) {
          for (const slideBreak of [false, true]) {
            const note = serializableSlide({
              command: '-', endPosition: 5, head, slideBreak,
              wait: cases[0][0], move: cases[0][1],
            }, { break: breakFlag, ex: exFlag });
            const expected = `1${marker}${exFlag ? 'x' : ''}${breakFlag ? 'b' : ''}-5${slideBreak ? 'b' : ''}[4:2]`;
            expect(serializeChart(serializableChart(note))).toBe(`(120){4}${expected},E`);
          }
        }
      }
    }
    expect(serializeChart(serializableChart(serializableSlide({
      command: '-', endPosition: 5, head: 'tap', slideBreak: false,
      wait: cases[0][0], move: cases[0][1],
    })))).toBe('(120){4}1@-5[4:2],E');
    expect(serializeChart(serializableChart(serializableSlide({
      command: '-', endPosition: 5, head: 'none', slideBreak: false,
      wait: cases[0][0], move: cases[0][1],
    })))).toBe('(120){4}1!-5[4:2],E');
    expect(serializeChart(serializableChart(serializableSlide({
      command: '-', endPosition: 5, head: 'star', slideBreak: false,
      wait: cases[1][0], move: cases[1][1],
    }, { break: false, ex: true })))).toBe('(120){4}1x-5[240#8:1],E');
    expect(() => serializeChart(serializableChart(serializableSlide({
      command: '-', endPosition: 5, head: 'star', slideBreak: false,
      wait: { kind: 'beatsAtStartBpm', division: 8, beats: 1 }, move: { kind: 'seconds', seconds: 0.25 },
    })))).toThrow('no verified MajSimai source representation');
    expect(serializeChart(serializableChart(serializableSlide({
      command: '-', endPosition: 5, head: 'star', slideBreak: false,
      wait: cases[0][0], move: cases[0][1],
    }, { break: true, ex: true })))).toBe('(120){4}1xb-5[4:2],E');
    expect(serializeChart(serializableChart(serializableSlide({
      command: '-', endPosition: 5, head: 'tap', slideBreak: false,
      wait: cases[0][0], move: cases[0][1],
    }, { break: true, ex: false })))).toBe('(120){4}1@b-5[4:2],E');
    expect(serializeChart(serializableChart(serializableSlide({
      command: '-', endPosition: 5, head: 'none', slideBreak: false,
      wait: cases[5][0], move: cases[5][1],
    }, { break: false, ex: true })))).toBe('(120){4}1!x-5[0.25##0.5],E');
  });

  it('compiles explicit wait/move timing across a BPM change and excludes headless slides from Each', async () => {
    const engine = new ChartEngine(async (text) => parserResult(text));
    const snapshot = await engine.import(new TextEncoder().encode(source), 'slide-times');
    const chart = snapshot.charts[0];
    const star = chart.notes.find((note) => note.id === 'slide-star')!;
    const hidden = chart.notes.find((note) => note.id === 'slide-hidden')!;
    const compiledTap = chart.notes.find((note) => note.id === 'tap')!;

    expect(chart.editable).toBe(true);
    expect(chart.diagnostics.some(({ code }) => code === 'slide-validation-pending')).toBe(true);
    expect(chart.diagnostics.find(({ code }) => code === 'slide-validation-pending')?.severity).toBe('warning');
    expect([star.startSeconds, star.moveStartSeconds, star.endSeconds]).toEqual([0.5, 1.5, 2]);
    expect(star.endSeconds - star.startSeconds).toBe(1.5);
    expect([star.isEach, hidden.isEach, compiledTap.isEach]).toEqual([true, false, true]);
    expect([star.isSlideEach, hidden.isSlideEach, compiledTap.isSlideEach]).toEqual([true, true, false]);
    const single = new ChartEngine(async (text) => parserResult(text, [starSlide, tap]));
    const singleSnapshot = await single.import(new TextEncoder().encode(source), 'one-slide-and-tap');
    expect(singleSnapshot.charts[0].notes[0].isEach).toBe(true);
    expect(singleSnapshot.charts[0].notes[0].isSlideEach).toBe(false);
  });

  it('deep-clones slide durations and upgrades legacy schema-3 single-path checkpoints', async () => {
    const parse = async (text: string) => parserResult(text);
    const engine = new ChartEngine(parse);
    const imported = await engine.import(new TextEncoder().encode(source), 'slide-clone');
    const first = engine.checkpoint('slide-clone', imported.version);
    const second = engine.checkpoint('slide-clone', imported.version);
    const firstSlide = first.document.charts[0].notes.find((note) => note.kind === 'slide')!;
    const secondSlide = second.document.charts[0].notes.find((note) => note.kind === 'slide')!;
    expect(firstSlide.slide).not.toBe(secondSlide.slide);
    expect(firstSlide.slide!.wait).not.toBe(secondSlide.slide!.wait);

    (firstSlide.slide!.wait as { kind: 'seconds'; seconds: number }).seconds = 12;
    expect((engine.checkpoint('slide-clone', imported.version).document.charts[0].notes
      .find((note) => note.kind === 'slide')!.slide!.wait as { kind: 'seconds'; seconds: number }).seconds).toBe(1);

    const legacy = { ...second, schemaVersion: 3 as const };
    legacy.document.charts[0] = { ...legacy.document.charts[0], editable: false };
    const restored = await new ChartEngine(parse).restore(legacy, 'slide-restored');
    expect(restored.charts[0].editable).toBe(true);
    expect(restored.charts[0].diagnostics.find(({ code }) => code === 'slide-validation-pending')?.severity).toBe('warning');
  });

  it('adds, updates, transforms, copies, exports, restores, and undoes supported Slides', async () => {
    const engine = new ChartEngine(async (text) => editableSlideParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'slide-edit');
    const first = engine.apply({
      generation: 'slide-edit', requestId: 1, baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [slideInput()] },
    });
    expect(first.charts[0].editable).toBe(true);
    expect(first.charts[0].diagnostics.find(({ code }) => code === 'slide-validation-pending')?.severity).toBe('warning');
    const originalSlide = first.charts[0].notes.find((note) => note.kind === 'slide')!;

    const copied = engine.apply({
      generation: 'slide-edit', requestId: 2, baseVersion: first.version,
      command: { type: 'add', difficulty: 1, notes: [slideInput('w', 5)] },
    });
    expect(copied.charts[0].notes.filter((note) => note.kind === 'slide')).toHaveLength(2);

    const transform = transformNotes([originalSlide], 'mirror-horizontal');
    const transformed = engine.apply({
      generation: 'slide-edit', requestId: 3, baseVersion: copied.version,
      command: { type: 'update', difficulty: 1, changes: transform },
    });
    expect(transformed.charts[0].notes.find((note) => note.id === originalSlide.id)).toMatchObject({
      position: 8, slide: { endPosition: 6 },
    });
    const undone = engine.apply({
      generation: 'slide-edit', requestId: 4, baseVersion: transformed.version,
      command: { type: 'undo' },
    });
    expect(undone.charts[0].notes.find((note) => note.id === originalSlide.id)).toMatchObject({
      position: 1, slide: { endPosition: 3 },
    });
    const redone = engine.apply({
      generation: 'slide-edit', requestId: 5, baseVersion: undone.version,
      command: { type: 'redo' },
    });
    expect(redone.charts[0].notes.find((note) => note.id === originalSlide.id)).toMatchObject({
      position: 8, slide: { endPosition: 6 },
    });

    const exported = await engine.export('slide-edit', redone.version);
    expect(exported.text).toContain('8-6[4:2]');
    expect(exported.text).toContain('1w5[4:2]');
    const checkpoint = engine.checkpoint('slide-edit', redone.version);
    const restored = await new ChartEngine(async (text) => editableSlideParserResult(text))
      .restore(checkpoint, 'slide-restored');
    expect(restored.charts[0].editable).toBe(true);
    expect(restored.charts[0].notes.filter((note) => note.kind === 'slide')).toHaveLength(2);

    const removed = engine.apply({
      generation: 'slide-edit', requestId: 6, baseVersion: redone.version,
      command: { type: 'delete', difficulty: 1, ids: redone.charts[0].notes.filter((note) => note.kind === 'slide').map((note) => note.id) },
    });
    expect(removed.charts[0].notes.some((note) => note.kind === 'slide')).toBe(false);
    expect(removed.charts[0].diagnostics.some(({ code }) => code === 'slide-validation-pending')).toBe(false);
    expect(removed.diagnostics.some(({ code }) => code === 'slide-validation-pending')).toBe(false);
    const restoredSlides = engine.apply({
      generation: 'slide-edit', requestId: 7, baseVersion: removed.version,
      command: { type: 'undo' },
    });
    expect(restoredSlides.charts[0].diagnostics.some(({ code }) => code === 'slide-validation-pending')).toBe(true);
  });

  it('keeps independently timed shared-head paths through Each, transforms, undo, export, and restore', async () => {
    const engine = new ChartEngine(async (text) => branchParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'slide-branches');
    const added = engine.apply({
      generation: 'slide-branches', requestId: 1, baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [multiPathInput()] },
    });
    const slide = added.charts[0].notes.find((note) => note.kind === 'slide')!;
    expect(slide.slidePaths).toMatchObject([
      {
        endPosition: 3, moveStartSeconds: 0.5, endSeconds: 1,
        segments: [
          { startPosition: 1, command: '-', endPosition: 3, moveStartSeconds: 0.5, endSeconds: 0.75 },
          { startPosition: 3, command: '-', endPosition: 5, moveStartSeconds: 0.75, endSeconds: 1 },
        ],
      },
      {
        endPosition: 5, slideBreak: true, moveStartSeconds: 0.25, endSeconds: 1.75,
        segments: [
          { startPosition: 1, command: '-', endPosition: 5, moveStartSeconds: 0.25 },
          { startPosition: 5, command: '-', endPosition: 7, endSeconds: 1.75 },
        ],
      },
    ]);
    expect([slide.moveStartSeconds, slide.endSeconds, slide.isEach, slide.isSlideEach]).toEqual([0.5, 1.75, true, true]);

    const transform = transformNotes([slide], 'mirror-horizontal');
    const transformed = engine.apply({
      generation: 'slide-branches', requestId: 2, baseVersion: added.version,
      command: { type: 'update', difficulty: 1, changes: transform },
    });
    const mirrored = transformed.charts[0].notes.find((note) => note.id === slide.id)!;
    expect(mirrored).toMatchObject({
      position: 8,
      slide: {
        endPosition: 6,
        continuations: [{ command: '-', endPosition: 4 }],
        additionalPaths: [{ endPosition: 4, slideBreak: true, continuations: [{ command: '-', endPosition: 2 }] }],
      },
    });

    const undone = engine.apply({
      generation: 'slide-branches', requestId: 3, baseVersion: transformed.version,
      command: { type: 'undo' },
    });
    expect(undone.charts[0].notes.find((note) => note.id === slide.id)?.slide).toMatchObject({
      endPosition: 3,
      continuations: [{ endPosition: 5 }],
      additionalPaths: [{ endPosition: 5, continuations: [{ endPosition: 7 }] }],
    });
    const redone = engine.apply({
      generation: 'slide-branches', requestId: 4, baseVersion: undone.version,
      command: { type: 'redo' },
    });
    const exported = await engine.export('slide-branches', redone.version);
    expect(exported.text).toContain('8-6-4[4:1]*-4-2b[0.25##1.5]');

    const firstCheckpoint = engine.checkpoint('slide-branches', redone.version);
    const secondCheckpoint = engine.checkpoint('slide-branches', redone.version);
    const firstSlide = firstCheckpoint.document.charts[0].notes.find((note) => note.kind === 'slide')!.slide!;
    const secondSlide = secondCheckpoint.document.charts[0].notes.find((note) => note.kind === 'slide')!.slide!;
    expect(firstSlide.continuations).not.toBe(secondSlide.continuations);
    expect(firstSlide.continuations?.[0]).not.toBe(secondSlide.continuations?.[0]);
    const firstPaths = firstCheckpoint.document.charts[0].notes.find((note) => note.kind === 'slide')!.slide!.additionalPaths!;
    const secondPaths = secondCheckpoint.document.charts[0].notes.find((note) => note.kind === 'slide')!.slide!.additionalPaths!;
    expect(firstPaths).not.toBe(secondPaths);
    expect(firstPaths[0].move).not.toBe(secondPaths[0].move);
    expect(firstPaths[0].continuations).not.toBe(secondPaths[0].continuations);
    expect(firstPaths[0].continuations?.[0]).not.toBe(secondPaths[0].continuations?.[0]);
    firstSlide.continuations![0].endPosition = 8;
    (firstPaths[0].move as { kind: 'seconds'; seconds: number }).seconds = 99;
    firstPaths[0].continuations![0].endPosition = 1;
    const engineSlide = engine.checkpoint('slide-branches', redone.version).document.charts[0].notes
      .find((note) => note.kind === 'slide')!.slide!;
    expect(engineSlide.continuations?.[0].endPosition).toBe(4);
    expect(engineSlide.additionalPaths?.[0].continuations?.[0].endPosition).toBe(2);
    expect((engine.checkpoint('slide-branches', redone.version).document.charts[0].notes
      .find((note) => note.kind === 'slide')!.slide!.additionalPaths![0].move as { kind: 'seconds'; seconds: number }).seconds).toBe(1.5);

    const restored = await new ChartEngine(async (text) => branchParserResult(text))
      .restore(secondCheckpoint, 'slide-branches-restored');
    expect(restored.charts[0].notes.find((note) => note.kind === 'slide')?.slidePaths).toHaveLength(2);

    const invalidLegacy = { ...secondCheckpoint, schemaVersion: 4 as const };
    await expect(new ChartEngine(async (text) => branchParserResult(text))
      .restore(invalidLegacy, 'slide-branches-schema4')).rejects.toThrowError(
      expect.objectContaining({ code: 'invalid-checkpoint' }),
    );

    const legacyBranch = structuredClone(secondCheckpoint);
    legacyBranch.schemaVersion = 4;
    const legacySlide = legacyBranch.document.charts[0].notes.find((note) => note.kind === 'slide')!.slide!;
    delete legacySlide.continuations;
    delete legacySlide.additionalPaths![0].continuations;
    const restoredLegacyBranch = await new ChartEngine(async (text) => branchParserResult(text))
      .restore(legacyBranch, 'slide-branches-schema4-no-continuations');
    expect(restoredLegacyBranch.charts[0].notes.find((note) => note.kind === 'slide')?.slidePaths).toHaveLength(2);

    const nestedContinuation = structuredClone(legacyBranch);
    nestedContinuation.document.charts[0].notes.find((note) => note.kind === 'slide')!
      .slide!.additionalPaths![0].continuations = [{ command: '-', endPosition: 7 }];
    await expect(new ChartEngine(async (text) => branchParserResult(text))
      .restore(nestedContinuation, 'slide-branches-schema4-nested-continuation')).rejects.toThrowError(
      expect.objectContaining({ code: 'invalid-checkpoint' }),
    );

    const schema3Branch = structuredClone(legacyBranch);
    schema3Branch.schemaVersion = 3;
    await expect(new ChartEngine(async (text) => branchParserResult(text))
      .restore(schema3Branch, 'slide-branches-schema3')).rejects.toThrowError(
      expect.objectContaining({ code: 'invalid-checkpoint' }),
    );
  });

  it('allocates a shared total move time by serialized Visual segment length for drag previews', () => {
    const note = {
      id: 'slide-preview', kind: 'slide' as const, beat: rational(0), position: 1, order: 0,
      modifiers,
      slide: {
        command: '-' as const, endPosition: 3, head: 'star' as const, slideBreak: false,
        wait: { kind: 'beatsAtStartBpm' as const, division: 4, beats: 1 },
        move: { kind: 'beatsAtStartBpm' as const, division: 2, beats: 2 },
        continuations: [{ command: '-' as const, endPosition: 5 }],
      },
    };
    const preview = compileNote(note, [{ beat: rational(0), bpm: 120 }]);
    expect(preview.slidePaths?.[0]).toMatchObject({
      moveStartSeconds: 0.5,
      endSeconds: 2.5,
      segments: [
        { startPosition: 1, command: '-', endPosition: 3, moveStartSeconds: 0.5, endSeconds: 1.5 },
        { startPosition: 3, command: '-', endPosition: 5, moveStartSeconds: 1.5, endSeconds: 2.5 },
      ],
    });

    const unequal = compileNote({
      ...note,
      slide: { ...note.slide, move: { kind: 'beatsAtStartBpm', division: 1, beats: 1 },
        continuations: [{ command: '>' as const, endPosition: 6 }] },
    }, [{ beat: rational(0), bpm: 120 }]);
    const lengths = [6.786810696995831, 18.840778275985738];
    const expectedFirstEnd = 0.5 + 2 * lengths[0] / (lengths[0] + lengths[1]);
    expect(unequal.slidePaths?.[0]?.segments?.[0].endSeconds).toBeCloseTo(expectedFirstEnd, 8);
    expect(unequal.slidePaths?.[0]?.segments?.[1]).toMatchObject({
      startPosition: 3, command: '>', endPosition: 6, moveStartSeconds: expectedFirstEnd, endSeconds: 2.5,
    });
  });

  it('rebuilds every derived branch and segment after dragging a compiled shared-head Slide', () => {
    const raw = multiPathInput();
    raw.slide!.additionalPaths![0].continuations = [{ command: '-', endPosition: 7 }];
    const original = {
      ...raw,
      id: 'slide-drag-preview',
      kind: 'slide' as const,
      beat: rational(0),
      order: 0,
      modifiers,
    };
    const bpms = [{ beat: rational(0), bpm: 120 }];
    const before = compileNote(original, bpms);
    const shifted = { ...before, beat: rational(1) };
    const transformedPatch = transformNotes([shifted], 'mirror-horizontal')[0].patch;
    const after = compileNote({ ...shifted, ...transformedPatch }, bpms);

    expect(after.slide).toMatchObject({
      command: '-', endPosition: 6, continuations: [{ endPosition: 4 }],
      additionalPaths: [{ endPosition: 4, continuations: [{ endPosition: 2 }] }],
    });
    expect(after.slidePaths).not.toBe(before.slidePaths);
    expect(after.slidePaths?.[0].segments).not.toBe(before.slidePaths?.[0].segments);
    expect(after.slidePaths?.[1].segments).not.toBe(before.slidePaths?.[1].segments);
    const branchSplitSeconds = 0.75 + 1.5 * 9.59799953157574 / (9.59799953157574 + 6.78681058686076);
    expect(after.slidePaths).toMatchObject([
      {
        moveStartSeconds: 1,
        endSeconds: 1.5,
        segments: [
          { startPosition: 8, command: '-', endPosition: 6, moveStartSeconds: 1, endSeconds: 1.25 },
          { startPosition: 6, command: '-', endPosition: 4, moveStartSeconds: 1.25, endSeconds: 1.5 },
        ],
      },
      {
        moveStartSeconds: 0.75,
        endSeconds: 2.25,
        segments: [
          { startPosition: 8, command: '-', endPosition: 4, moveStartSeconds: 0.75 },
          { startPosition: 4, command: '-', endPosition: 2, endSeconds: 2.25 },
        ],
      },
    ]);
    expect(after.slidePaths?.[1].segments?.[0].endSeconds).toBeCloseTo(branchSplitSeconds, 10);
    expect(after.slidePaths?.[1].segments?.[1].moveStartSeconds).toBeCloseTo(branchSplitSeconds, 10);
    expect(after.slidePaths?.[0]).not.toHaveProperty('head');
    expect(after.slidePaths?.[0]).not.toHaveProperty('additionalPaths');
  });

  it('caps one shared-head Slide at 64 paths and rejects larger adds without committing', async () => {
    const engine = new ChartEngine(async (text) => branchParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'slide-path-limit');
    const makeSlide = (additionalCount: number) => {
      const input = slideInput();
      input.slide = {
        ...input.slide!,
        additionalPaths: Array.from({ length: additionalCount }, () => ({
          command: '-' as const,
          endPosition: 3,
          slideBreak: false,
          wait: { kind: 'beatsAtStartBpm' as const, division: 4, beats: 1 },
          move: { kind: 'beatsAtStartBpm' as const, division: 4, beats: 1 },
        })),
      };
      return input;
    };
    const maxed = engine.apply({
      generation: 'slide-path-limit', requestId: 1, baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [makeSlide(63)] },
    });
    expect(maxed.charts[0].notes.find((note) => note.kind === 'slide')?.slidePaths).toHaveLength(64);
    expect(() => engine.apply({
      generation: 'slide-path-limit', requestId: 2, baseVersion: maxed.version,
      command: { type: 'add', difficulty: 1, notes: [makeSlide(64)] },
    })).toThrowError(expect.objectContaining({ code: 'slide-path-count' }));
    expect(engine.checkpoint('slide-path-limit', maxed.version).document.charts[0].notes
      .filter((note) => note.kind === 'slide')).toHaveLength(1);
  });

  it('rejects invalid line and Wi-Fi paths atomically while retaining read-only unsupported Slide syntax', async () => {
    const engine = new ChartEngine(async (text) => editableSlideParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'slide-paths');
    const invalidAdd = (note: Omit<Note, 'id' | 'order'>, requestId: number) => engine.apply({
      generation: 'slide-paths', requestId, baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [note] },
    });
    expect(() => invalidAdd(slideInput('-', 2), 1))
      .toThrowError(expect.objectContaining({ code: 'invalid-slide-path' }));
    expect(() => invalidAdd(slideInput('w', 4), 2))
      .toThrowError(expect.objectContaining({ code: 'invalid-slide-path' }));
    const badContinuation = slideInput();
    badContinuation.slide!.continuations = [{ command: '-', endPosition: 4 }];
    expect(() => invalidAdd(badContinuation, 3))
      .toThrowError(expect.objectContaining({ code: 'invalid-slide-path' }));
    const wifiContinuation = slideInput('w', 5);
    wifiContinuation.slide!.continuations = [{ command: '<', endPosition: 3 }];
    expect(() => invalidAdd(wifiContinuation, 4))
      .toThrowError(expect.objectContaining({ code: 'wifi-continuation' }));
    expect(engine.checkpoint('slide-paths', imported.version).document.charts[0].notes.some((note) => note.kind === 'slide')).toBe(false);

    const valid = engine.apply({
      generation: 'slide-paths', requestId: 3, baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [slideInput()] },
    });
    const slide = valid.charts[0].notes.find((note) => note.kind === 'slide')!;
    expect(() => engine.apply({
      generation: 'slide-paths', requestId: 5, baseVersion: valid.version,
      command: { type: 'update', difficulty: 1, changes: [{ id: slide.id, patch: {
        slide: { ...slide.slide!, continuations: [{ command: '-', endPosition: 4 }] },
      } }] },
    })).toThrowError(expect.objectContaining({ code: 'invalid-slide-path' }));
    expect(engine.checkpoint('slide-paths', valid.version).document.charts[0].notes.find((note) => note.id === slide.id)?.slide?.endPosition).toBe(3);

    const unsupported = new ChartEngine(async (text) => unsupportedSlideParserResult(text));
    const readOnly = await unsupported.import(new TextEncoder().encode(source), 'unsupported-slide');
    expect(readOnly.charts[0].editable).toBe(false);
    expect(() => unsupported.apply({
      generation: 'unsupported-slide', requestId: 1, baseVersion: readOnly.version,
      command: { type: 'add', difficulty: 1, notes: [{
        kind: 'tap', beat: rational(0), position: 2, modifiers,
      }] },
    })).toThrowError(expect.objectContaining({ code: 'readonly-chart' }));
    const injected = unsupported.checkpoint('unsupported-slide', readOnly.version);
    injected.document.charts[0] = { ...injected.document.charts[0], editable: true, modified: true };
    await expect(unsupported.restore(injected, 'forged-unsupported-slide'))
      .rejects.toBeInstanceOf(ChartCoreError);
  });

  it('reparses metadata while preserving Slide source and the pending target-player warning', async () => {
    const text = '&title=before\n&inote_1=(120){4}1-5[4:2],E\n';
    const slide: ParserNote = {
      id: 'roundtrip-slide', kind: 'slide', beat: rational(0), position: 1, order: 0, modifiers,
      slide: {
        command: '-', endPosition: 5, head: 'star', slideBreak: false,
        wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
        move: { kind: 'beatsAtStartBpm', division: 4, beats: 2 },
      },
      startSeconds: 0, moveStartSeconds: 0.5, durationSeconds: 1.5,
    };
    const parse = async (candidate: string) => parserResult(candidate, [slide]);
    const engine = new ChartEngine(parse);
    const imported = await engine.import(new TextEncoder().encode(text), 'slide-roundtrip');
    expect(imported.charts[0].editable).toBe(true);
    expect(imported.charts[0].diagnostics.find(({ code }) => code === 'slide-validation-pending')?.severity).toBe('warning');
    const edited = engine.apply({
      generation: 'slide-roundtrip', requestId: 1, baseVersion: imported.version,
      command: { type: 'set-metadata', field: 'title', value: 'after' },
    });
    const exported = await engine.export('slide-roundtrip', edited.version);
    expect(exported.text).toBe(text.replace('&title=before', '&title=after'));
    expect(exported.text).toContain('1-5[4:2]');
  });
});
