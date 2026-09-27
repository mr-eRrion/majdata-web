import { describe, expect, it } from 'vitest';
import { ChartEngine, rational } from '../src/index.js';
import { serializeChart } from '../src/serialize.js';
import type { Chart, Note } from '../src/types.js';
import type { ParserNote } from '../../majsimai-browser/src/types.js';
import { simpleParserResult } from './fixture-parser.js';

const source = '&title=Static star\n&inote_1=(120){4}1bx,E\n';
const modifiers = { break: true, ex: true };

function staticStarParser(text: string) {
  const result = simpleParserResult(text);
  const token = text.match(/\}\s*([^,\/\s]+)/)?.[1] ?? '1';
  const first = result.charts[0].notes[0];
  const note: ParserNote = {
    ...first,
    forceStar: token.includes('$'),
    modifiers: { break: token.includes('b'), ex: token.includes('x') },
  };
  return {
    ...result,
    charts: [{ ...result.charts[0], notes: [note] }],
  };
}

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

describe('static star Tap', () => {
  it('serializes one force-star marker before break/EX flags', () => {
    const note: Note = {
      id: 'tap', kind: 'tap', beat: rational(0), position: 1, order: 0,
      forceStar: true, modifiers,
    };
    expect(serializeChart(serializableChart(note))).toBe('(120){4}1$bx,E');
  });

  it('updates, exports, and reparses forceStar while treating omitted fields as false', async () => {
    const engine = new ChartEngine(async (text) => staticStarParser(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'force-star');
    const tap = imported.charts[0].notes[0];
    expect(tap.forceStar).toBe(false);

    const starred = engine.apply({
      generation: 'force-star', requestId: 1, baseVersion: imported.version,
      command: { type: 'update', difficulty: 1, changes: [{ id: tap.id, patch: { forceStar: true } }] },
    });
    expect(starred.version).toBe(1);
    expect(starred.charts[0].notes[0].forceStar).toBe(true);
    const starredOutput = await engine.export('force-star', starred.version);
    expect(starredOutput.text).toContain('&inote_1=(120){4}1$bx,E\n');

    const plain = engine.apply({
      generation: 'force-star', requestId: 2, baseVersion: starred.version,
      command: { type: 'update', difficulty: 1, changes: [{ id: tap.id, patch: { forceStar: false } }] },
    });
    expect(plain.charts[0].notes[0].forceStar).toBe(false);
    expect((await engine.export('force-star', plain.version)).text).toContain('&inote_1=(120){4}1bx,E\n');

    const checkpoint = engine.checkpoint('force-star', plain.version);
    delete checkpoint.document.charts[0].notes[0].forceStar;
    const restored = await engine.restore(checkpoint, 'legacy-force-star');
    expect(restored.charts[0].notes[0].forceStar).toBe(false);
  });

  it('rejects forceStar on non-Tap notes and rejects a candidate parse that drops it', async () => {
    const engine = new ChartEngine(async (text) => staticStarParser(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'force-star-invalid');
    const add = (kind: Note['kind'], extra: Partial<Note> = {}) => engine.apply({
      generation: 'force-star-invalid', requestId: kind === 'hold' ? 1 : 2,
      baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [{
        kind, beat: rational(1, 2), position: 2, forceStar: true,
        ...(kind === 'hold' ? { duration: { kind: 'short' as const } } : {}),
        ...(kind === 'touch' ? { position: 1, touchArea: 'A' as const } : {}),
        ...extra,
        modifiers: { break: false, ex: false },
      }] },
    });
    expect(() => add('hold')).toThrowError(expect.objectContaining({ code: 'force-star-note-kind' }));
    expect(() => add('touch')).toThrowError(expect.objectContaining({ code: 'force-star-note-kind' }));

    const dropsFlag = new ChartEngine(async (text) => {
      const result = staticStarParser(text);
      result.charts[0].notes[0] = { ...result.charts[0].notes[0], forceStar: false };
      return result;
    });
    const base = await dropsFlag.import(new TextEncoder().encode(source), 'force-star-drop');
    const updated = dropsFlag.apply({
      generation: 'force-star-drop', requestId: 1, baseVersion: base.version,
      command: { type: 'update', difficulty: 1, changes: [{ id: base.charts[0].notes[0].id, patch: { forceStar: true } }] },
    });
    await expect(dropsFlag.export('force-star-drop', updated.version))
      .rejects.toThrowError(expect.objectContaining({ code: 'export-semantic-mismatch' }));
  });
});
