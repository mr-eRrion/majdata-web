import { describe, expect, it } from 'vitest';
import { ChartEngine, rational } from '../src/index.js';
import type { Checkpoint, Note } from '../src/types.js';
import type { ParserNote, ParserResult } from '../../majsimai-browser/src/types.js';
import { simpleParserResult } from './fixture-parser.js';

const modifiers = { break: false, ex: false };
const touchSource = '&title=Touch\r\n&custom=preserve=this\r\n&inote_1=(120)A1,{4}D3h[4:2],{4}C,E\r\n';

function parserNote(note: Note, startSeconds: number, durationSeconds = 0): ParserNote {
  return { ...note, startSeconds, durationSeconds };
}

function touchNotes(firstArea: 'A' | 'B' = 'A', firstPosition = 1): ParserNote[] {
  return [
    parserNote({ id: 'touch-a', kind: 'touch', beat: rational(0), position: firstPosition, touchArea: firstArea, order: 0, modifiers }, 0),
    parserNote({
      id: 'touch-hold-d', kind: 'touchHold', beat: rational(1), position: 3, touchArea: 'D', order: 1,
      duration: { kind: 'beatsAtStartBpm', division: 4, beats: 2 }, modifiers,
    }, 0.5, 1),
    parserNote({ id: 'touch-center', kind: 'touch', beat: rational(2), position: 0, touchArea: 'C', order: 2, modifiers }, 1),
  ];
}

function touchParserResult(text: string, notes = touchNotes()): ParserResult {
  const base = simpleParserResult(text);
  const source = base.charts[0];
  return {
    ...base,
    charts: [{ ...source, endBeat: rational(4), notes }],
  };
}

function setMultilineTitle(result: ParserResult, text: string): ParserResult {
  const title = result.fields.find((field) => field.name === 'title');
  const next = result.fields.find((field) => field.name === 'custom') ?? result.fields.find((field) => field.name.startsWith('inote_'));
  if (!title || !next) return result;
  title.range.end = next.range.start;
  title.valueRange.end = next.range.start;
  title.rawValue = text.slice(title.valueRange.start, title.valueRange.end);
  return result;
}

describe('Touch support and descriptive metadata', () => {
  it('writes checkpoint schema v5 and rejects unsupported versions without changing the document', async () => {
    const engine = new ChartEngine(async (text) => simpleParserResult(text));
    const imported = await engine.import(new TextEncoder().encode('&inote_1=(120){4}1,E\n'), 'checkpoint-version');
    const checkpoint = engine.checkpoint('checkpoint-version', imported.version);
    expect(checkpoint.schemaVersion).toBe(5);

    await expect(engine.restore(
      { ...checkpoint, schemaVersion: 2 } as unknown as Checkpoint,
      'legacy-checkpoint',
    )).rejects.toThrowError(expect.objectContaining({ code: 'invalid-checkpoint' }));
    expect(engine.checkpoint('checkpoint-version', imported.version).document.version).toBe(imported.version);
  });

  it('compiles, serializes, reparses and restores Touch sensor identity', async () => {
    let candidate = touchNotes('B', 2);
    const parse = async (text: string) => touchParserResult(text, text === touchSource ? touchNotes() : candidate);
    const engine = new ChartEngine(parse);
    const imported = await engine.import(new TextEncoder().encode(touchSource), 'touch-generation');
    expect(imported.charts[0].notes.find((note) => note.id === 'touch-hold-d')?.endSeconds).toBe(1.5);
    expect(imported.charts[0].notes.find((note) => note.id === 'touch-center')?.position).toBe(0);

    const updated = engine.apply({
      generation: 'touch-generation', requestId: 1, baseVersion: imported.version,
      command: { type: 'update', difficulty: 1, changes: [{ id: 'touch-a', patch: { position: 2, touchArea: 'B' } }] },
    });
    const exported = await engine.export('touch-generation', updated.version);
    expect(exported.text).toContain('B2');
    expect(exported.text).toContain('D3h[4:2]');
    expect(exported.text).toContain('C');

    const checkpoint = engine.checkpoint('touch-generation', updated.version);
    const restored = await new ChartEngine(async (text) => touchParserResult(text)).restore(checkpoint, 'touch-restored');
    expect(restored.canUndo).toBe(false);
    expect(restored.charts[0].notes.find((note) => note.id === 'touch-a')).toMatchObject({ position: 2, touchArea: 'B' });

    candidate = touchNotes('A', 2);
    const mismatching = new ChartEngine(async (text) => touchParserResult(text, text === touchSource ? touchNotes() : candidate));
    const mismatchImported = await mismatching.import(new TextEncoder().encode(touchSource), 'touch-mismatch');
    const mismatchEdit = mismatching.apply({
      generation: 'touch-mismatch', requestId: 1, baseVersion: mismatchImported.version,
      command: { type: 'update', difficulty: 1, changes: [{ id: 'touch-a', patch: { position: 2, touchArea: 'B' } }] },
    });
    await expect(mismatching.export('touch-mismatch', mismatchEdit.version))
      .rejects.toThrowError(expect.objectContaining({ code: 'export-semantic-mismatch' }));
  });

  it('rejects EX Touch, noncanonical center positions, and bare short Touch Holds', async () => {
    const engine = new ChartEngine(async (text) => touchParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(touchSource), 'touch-invalid');
    const add = (note: Omit<Note, 'id' | 'order'>) => engine.apply({
      generation: 'touch-invalid', requestId: 1, baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [note] },
    });
    const error = (code: string) => expect.objectContaining({ code });

    expect(() => add({ kind: 'touch', beat: rational(3), position: 1, touchArea: 'A', modifiers: { break: false, ex: true } }))
      .toThrowError(error('touch-ex-unsupported'));
    expect(() => add({ kind: 'touch', beat: rational(3), position: 8, touchArea: 'C', modifiers }))
      .toThrowError(error('invalid-touch-position'));
    expect(() => add({ kind: 'touchHold', beat: rational(3), position: 1, touchArea: 'E', duration: { kind: 'short' }, modifiers }))
      .toThrowError(error('touchhold-duration'));
    expect(engine.checkpoint('touch-invalid', 0).document.version).toBe(0);
  });

  it('edits whitelisted metadata with undo/redo and appends missing fields without altering unknown fields', async () => {
    const source = '&title=Original\r\n&artist=Artist\r\n&custom=keep=exactly\r\n&inote_1=(120){4}1,E\r\n';
    const engine = new ChartEngine(async (text) => simpleParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'metadata-generation');
    expect(imported.metadataEditable).toBe(true);
    expect(imported.metadata.title).toBe('Original');
    let snapshot = engine.apply({
      generation: 'metadata-generation', requestId: 1, baseVersion: imported.version,
      command: { type: 'set-metadata', field: 'title', value: 'Revised' },
    });
    snapshot = engine.apply({
      generation: 'metadata-generation', requestId: 2, baseVersion: snapshot.version,
      command: { type: 'set-metadata', field: 'des', value: 'one line = kept' },
    });
    expect(() => engine.apply({
      generation: 'metadata-generation', requestId: 3, baseVersion: snapshot.version,
      command: { type: 'set-metadata', field: 'artist', value: 'two\nlines' },
    })).toThrowError(expect.objectContaining({ code: 'invalid-metadata-value' }));

    snapshot = engine.apply({ generation: 'metadata-generation', requestId: 4, baseVersion: snapshot.version, command: { type: 'undo' } });
    expect(snapshot.metadata.des).toBe('');
    snapshot = engine.apply({ generation: 'metadata-generation', requestId: 5, baseVersion: snapshot.version, command: { type: 'redo' } });
    snapshot = engine.apply({
      generation: 'metadata-generation', requestId: 6, baseVersion: snapshot.version,
      command: { type: 'set-first', seconds: 0.25 },
    });
    const exported = await engine.export('metadata-generation', snapshot.version);
    expect(exported.text).toContain('&title=Revised\r\n');
    expect(exported.text).toContain('&custom=keep=exactly\r\n');
    expect(exported.text.endsWith('&des=one line = kept\r\n&first=0.25\r\n')).toBe(true);
  });

  it('keeps multiline metadata read-only while chart edits, byte-preserving export and checkpoint restore remain available', async () => {
    const source = '&title=first line\r\nsecond line\r\n&custom=retained\r\n&inote_1=(120){4}1,E\r\n';
    const parse = async (text: string) => setMultilineTitle(simpleParserResult(text, text !== source), text);
    const bytes = new TextEncoder().encode(source);
    const engine = new ChartEngine(parse);
    const imported = await engine.import(bytes, 'multiline-metadata');
    expect(imported.metadataEditable).toBe(false);
    expect(imported.metadata.title).toBe('first line\r\nsecond line');
    expect((await engine.export('multiline-metadata', 0)).bytes).toEqual(bytes);
    expect(() => engine.apply({
      generation: 'multiline-metadata', requestId: 1, baseVersion: 0,
      command: { type: 'set-metadata', field: 'title', value: 'replacement' },
    })).toThrowError(expect.objectContaining({ code: 'readonly-metadata' }));

    const restored = await new ChartEngine(parse).restore(engine.checkpoint('multiline-metadata', 0), 'multiline-restored');
    expect(restored.metadata.title).toBe(imported.metadata.title);
    expect(restored.metadataEditable).toBe(false);
    const edited = engine.apply({
      generation: 'multiline-metadata', requestId: 2, baseVersion: 0,
      command: { type: 'add', difficulty: 1, notes: [{
        kind: 'tap', beat: rational(0), position: 2, modifiers,
      }] },
    });
    const exported = await engine.export('multiline-metadata', edited.version);
    expect(exported.text).toContain('&title=first line\r\nsecond line\r\n');
    expect(exported.text).toContain('&custom=retained\r\n');
  });

  it('disables metadata edits when a known field is duplicated', async () => {
    const source = '&title=one\n&title=two\n&inote_1=(120){4}1,E\n';
    const engine = new ChartEngine(async (text) => simpleParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'duplicate-metadata');
    expect(imported.metadataEditable).toBe(false);
    expect(() => engine.apply({
      generation: 'duplicate-metadata', requestId: 1, baseVersion: 0,
      command: { type: 'set-metadata', field: 'title', value: 'ambiguous' },
    })).toThrowError(expect.objectContaining({ code: 'readonly-metadata' }));
  });
});
