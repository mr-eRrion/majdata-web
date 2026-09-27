import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ChartCoreError, ChartEngine, mergeBpmEvents, rational } from '../src/index.js';
import { fireworkParserResult, fixtureParserResult, simpleParserResult } from './fixture-parser.js';

const baseline = readFileSync(new URL('../../../fixtures/charts/baseline.maidata.txt', import.meta.url), 'utf8');
const baselineBytes = new TextEncoder().encode(baseline);

describe('ChartEngine document transactions', () => {
  it('commits mixed note and BPM clipboard edits as one undoable transaction', async () => {
    const engine = new ChartEngine(async (text) => fixtureParserResult(text));
    const imported = await engine.import(baselineBytes, 'clipboard-events');
    const chart = imported.charts.find((item) => item.difficulty === 1)!;
    const removed = chart.notes[0];
    const bpms = mergeBpmEvents(chart.bpms, [
      { beat: rational(2), bpm: 180 },
      { beat: rational(8), bpm: 300 },
      { beat: rational(17, 2), bpm: 240 },
    ]);

    expect(() => engine.apply({
      generation: 'clipboard-events', requestId: 1, baseVersion: imported.version,
      command: { type: 'edit-events', difficulty: 1, removeNoteIds: [removed.id],
        bpms: [{ beat: rational(2), bpm: 180 }] },
    })).toThrowError(expect.objectContaining({ code: 'invalid-bpms' }));
    expect(engine.checkpoint('clipboard-events', 0).document.version).toBe(0);

    const pasted = engine.apply({
      generation: 'clipboard-events', requestId: 2, baseVersion: imported.version,
      command: { type: 'edit-events', difficulty: 1, removeNoteIds: [removed.id],
        addNotes: [{ kind: 'tap', beat: rational(7), position: 5, modifiers: { break: false, ex: false } }], bpms },
    });
    const after = pasted.charts.find((item) => item.difficulty === 1)!;
    expect(pasted.version).toBe(1);
    expect(pasted.canUndo).toBe(true);
    expect(after.notes).toHaveLength(chart.notes.length);
    expect(after.notes.some((note) => note.id === removed.id)).toBe(false);
    expect(after.notes.some((note) => note.beat.numerator === 7 && note.position === 5)).toBe(true);
    expect(after.bpms).toEqual(bpms);
    expect(after.endBeat).toEqual(rational(19, 2));

    const undone = engine.apply({ generation: 'clipboard-events', requestId: 3, baseVersion: 1,
      command: { type: 'undo' } });
    expect(undone.version).toBe(2);
    expect(undone.charts.find((item) => item.difficulty === 1)!.notes).toEqual(chart.notes);
    expect(undone.charts.find((item) => item.difficulty === 1)!.bpms).toEqual(chart.bpms);

    const redone = engine.apply({ generation: 'clipboard-events', requestId: 4, baseVersion: 2,
      command: { type: 'redo' } });
    expect(redone.version).toBe(3);
    expect(redone.charts.find((item) => item.difficulty === 1)!.bpms).toEqual(bpms);
    expect(redone.charts.find((item) => item.difficulty === 1)!.notes.some((note) => note.id === removed.id)).toBe(false);

    const terminalEngine = new ChartEngine(async (text) => fixtureParserResult(text));
    const terminalImport = await terminalEngine.import(baselineBytes, 'terminal-bpm');
    const terminalChart = terminalImport.charts.find((item) => item.difficulty === 1)!;
    const editedTerminal = terminalEngine.apply({
      generation: 'terminal-bpm', requestId: 1, baseVersion: terminalImport.version,
      command: { type: 'edit-events', difficulty: 1,
        bpms: mergeBpmEvents(terminalChart.bpms, [{ beat: rational(2), bpm: 180 }]) },
    });
    expect(editedTerminal.charts.find((item) => item.difficulty === 1)!.endBeat).toEqual(terminalChart.endBeat);
  });

  it('preserves Touch Firework through parsing, update, generation, and semantic reparse', async () => {
    const source = '&title=Touch Firework\n&inote_1=(120){4}A1f,{4}A2fh[4:1],E\n';
    const engine = new ChartEngine(async (text) => fireworkParserResult(text));
    const imported = await engine.import(new TextEncoder().encode(source), 'firework-document');
    const [touch, hold] = imported.charts[0].notes;
    expect(touch.firework).toBe(true);
    expect(hold.firework).toBe(true);

    const updated = engine.apply({
      generation: 'firework-document', requestId: 1, baseVersion: imported.version,
      command: { type: 'update', difficulty: 1, changes: [{ id: touch.id, patch: { firework: false } }] },
    });
    expect(updated.charts[0].notes[0].firework).toBe(false);
    expect(updated.charts[0].notes[1].firework).toBe(true);
    const exported = await engine.export('firework-document', updated.version);
    expect(exported.text).toContain('&inote_1=(120){4}A1,{4}A2fh[4:1],E\n');

    expect(() => engine.apply({
      generation: 'firework-document', requestId: 2, baseVersion: updated.version,
      command: { type: 'add', difficulty: 1, notes: [{
        kind: 'tap', beat: rational(3, 2), position: 3, firework: true,
        modifiers: { break: false, ex: false },
      }] },
    })).toThrowError(expect.objectContaining({ code: 'firework-note-kind' }));
  });

  it('defaults an absent Firework field to false when restoring a legacy checkpoint', async () => {
    const engine = new ChartEngine(async (text) => simpleParserResult(text));
    const imported = await engine.import(new TextEncoder().encode('&title=simple\n&inote_1=(120){4}1,E'), 'legacy-firework');
    const checkpoint = engine.checkpoint('legacy-firework', imported.version);
    delete checkpoint.document.charts[0].notes[0].firework;
    const restored = await engine.restore(checkpoint, 'restored-legacy-firework');
    expect(restored.charts[0].notes[0].firework).toBe(false);
  });

  it('applies a batch atomically, preserves stable IDs through undo/redo, and checks candidate semantics on export', async () => {
    const candidateSources: string[] = [];
    const engine = new ChartEngine(async (text) => {
      if (text === baseline) return fixtureParserResult(text);
      candidateSources.push(text);
      return fixtureParserResult(text, true);
    });
    const imported = await engine.import(baselineBytes, 'generation-a');
    const chart = imported.charts.find((item) => item.difficulty === 1)!;
    const lane3 = chart.notes.find((note) => note.position === 3)!;
    expect(lane3.startSeconds).toBe(1);
    expect(chart.notes.find((note) => note.position === 2)?.endSeconds).toBe(2.5);
    expect(imported.charts.find((item) => item.difficulty === 2)?.editable).toBe(false);
    expect(() => engine.apply({
      generation: 'generation-a', requestId: 1, baseVersion: 0,
      command: { type: 'set-first', seconds: 0.5 },
    })).toThrow(/read-only/);

    expect(() => engine.apply({
      generation: 'generation-a', requestId: 2, baseVersion: 0,
      command: { type: 'update', difficulty: 1, changes: [
        { id: lane3.id, patch: { beat: rational(5, 2) } },
        { id: 'missing', patch: { position: 7 } },
      ] },
    })).toThrow(/does not exist/);
    expect(engine.checkpoint('generation-a', 0).document.version).toBe(0);
    expect(() => engine.apply({ generation: 'generation-a', requestId: 3, baseVersion: 0, command: { type: 'undo' } }))
      .toThrowError(expect.objectContaining({ code: 'nothing-to-undo' }));

    const moved = engine.apply({
      generation: 'generation-a', requestId: 4, baseVersion: 0,
      command: { type: 'update', difficulty: 1, changes: [{ id: lane3.id, patch: { beat: rational(5, 2) } }] },
    });
    expect(moved.version).toBe(1);
    expect(moved.charts[0].notes.find((note) => note.id === lane3.id)?.startSeconds).toBe(1.125);
    const undone = engine.apply({ generation: 'generation-a', requestId: 5, baseVersion: 1, command: { type: 'undo' } });
    expect(undone.charts[0].notes.find((note) => note.id === lane3.id)?.beat).toEqual({ numerator: 2, denominator: 1 });
    const redone = engine.apply({ generation: 'generation-a', requestId: 6, baseVersion: 2, command: { type: 'redo' } });
    expect(redone.charts[0].notes.find((note) => note.id === lane3.id)?.id).toBe(lane3.id);

    const exported = await engine.export('generation-a', 3);
    expect(candidateSources).toHaveLength(1);
    expect(candidateSources[0]).toContain('&inote_1=(120){4}1/1,{4}2h[4:4],(240){8},{8}3,{2}4h[#0.25],E\n&lv_2=2');
    expect(exported.text).toContain('&custom=preserve this unknown metadata exactly');
    expect(exported.text).toContain('&inote_2=(120){4}1-5[4:1]-1[4:3],E');
    expect(exported.version).toBe(3);
  });

  it('keeps a compiled edit and undo history unchanged when candidate compilation overflows', async () => {
    const engine = new ChartEngine(async (text) => fixtureParserResult(text));
    const imported = await engine.import(baselineBytes, 'generation-b');
    expect(() => engine.apply({
      generation: 'generation-b', requestId: 1, baseVersion: imported.version,
      command: { type: 'set-bpms', difficulty: 1, bpms: [
        { beat: rational(0), bpm: Number.MIN_VALUE },
        { beat: rational(1), bpm: 120 },
      ] },
    })).toThrow();
    expect(engine.checkpoint('generation-b', 0).document.version).toBe(0);
    expect(() => engine.apply({ generation: 'generation-b', requestId: 2, baseVersion: 0, command: { type: 'undo' } }))
      .toThrowError(expect.objectContaining({ code: 'nothing-to-undo' }));
  });

  it('appends a missing &first field and restores a document-only checkpoint without history', async () => {
    const originalText = '&title=simple\n&inote_1=(120){4}1,E';
    let includeLateBpm = false;
    const parse = vi.fn(async (text: string) => simpleParserResult(text, text !== originalText, text !== originalText && includeLateBpm));
    const engine = new ChartEngine(parse);
    const imported = await engine.import(new TextEncoder().encode(originalText), 'generation-c');
    const added = engine.apply({
      generation: 'generation-c', requestId: 1, baseVersion: imported.version,
      command: { type: 'add', difficulty: 1, notes: [{
        kind: 'tap', beat: rational(0), position: 2, modifiers: { break: false, ex: false },
      }] },
    });
    const changed = engine.apply({
      generation: 'generation-c', requestId: 2, baseVersion: added.version,
      command: { type: 'set-first', seconds: 0.5 },
    });
    const timing = engine.apply({
      generation: 'generation-c', requestId: 3, baseVersion: changed.version,
      command: { type: 'set-bpms', difficulty: 1, bpms: [
        { beat: rational(0), bpm: 120 },
        { beat: rational(1), bpm: 240 },
      ] },
    });
    includeLateBpm = true;
    const checkpoint = engine.checkpoint('generation-c', timing.version);
    expect(Object.keys(checkpoint.document)).not.toContain('undoStack');
    const restored = await engine.restore(checkpoint, 'generation-d');
    expect(restored.generation).toBe('generation-d');
    expect(restored.version).toBe(3);
    expect(restored.canUndo).toBe(false);
    const exported = await engine.export('generation-d', restored.version);
    expect(exported.text).toBe('&title=simple\n&inote_1=(120){4}1/2,(240){4},E\n&first=0.5\n');
  });

  it('returns original raw bytes for unchanged UTF-8 with BOM/CRLF and for undecodable input', async () => {
    const source = `\uFEFF${baseline.replace(/\n/g, '\r\n')}`;
    const sourceBytes = new TextEncoder().encode(source);
    const engine = new ChartEngine(async (text) => fixtureParserResult(text));
    const imported = await engine.import(sourceBytes, 'generation-e');
    expect([...((await engine.export('generation-e', imported.version)).bytes)]).toEqual([...sourceBytes]);

    const parser = vi.fn(async () => { throw new Error('must not parse invalid UTF-8'); });
    const rawEngine = new ChartEngine(parser);
    const invalidBytes = Uint8Array.of(0xff, 0x00, 0x80);
    const raw = await rawEngine.import(invalidBytes, 'generation-f');
    const output = await rawEngine.export('generation-f', raw.version);
    expect(parser).not.toHaveBeenCalled();
    expect(output.bytes).toEqual(invalidBytes);
    expect(raw.charts).toHaveLength(0);
    expect(raw.diagnostics[0].code).toBe('invalid-utf8');
  });

  it('rejects checkpoint tampering that marks an originally read-only difficulty editable', async () => {
    const parse = async (text: string) => fixtureParserResult(text);
    const engine = new ChartEngine(parse);
    const imported = await engine.import(baselineBytes, 'generation-g');
    const checkpoint = engine.checkpoint('generation-g', imported.version);
    checkpoint.document.charts[1] = { ...checkpoint.document.charts[1], editable: true, modified: true };
    await expect(engine.restore(checkpoint, 'generation-h')).rejects.toBeInstanceOf(ChartCoreError);
  });
});
