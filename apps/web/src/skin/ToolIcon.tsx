import { useEffect, useRef } from 'react';
import type { DisplayNote, Note } from '../../../../packages/chart-core/src/types.js';
import { coreSkinKeys, loadSkinImages } from './assets.js';
import { drawNoteGlyph } from './canvas.js';

const noModifiers: Note['modifiers'] = { break: false, ex: false };
const starSkinKeys = ['star.base', 'star.each', 'star.break', 'star.ex'];

export function ToolIcon({ kind, modifiers = noModifiers, forceStar = false, onError }: {
  kind: Exclude<Note['kind'], 'slide'>;
  modifiers?: Note['modifiers'];
  forceStar?: boolean;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    let cancelled = false;
    const skinKeys = kind === 'tap' && forceStar ? [...coreSkinKeys, ...starSkinKeys] : coreSkinKeys;
    void loadSkinImages(skinKeys).then((images) => {
      if (cancelled || !canvas.current) return;
      const ctx = canvas.current.getContext('2d')!;
      ctx.clearRect(0, 0, 48, 48);
      const note: DisplayNote = { id: 'icon', kind, beat: { numerator: 0, denominator: 1 }, position: 1, order: 0,
        startSeconds: 0, endSeconds: 0, bpm: 120, modifiers, ...(kind === 'tap' ? { forceStar } : {}) };
      drawNoteGlyph(ctx, note, 24, 24, 42, images);
    }).catch((cause: Error) => { if (!cancelled) report.current(cause.message); });
    return () => { cancelled = true; };
  }, [kind, modifiers.break, modifiers.ex, forceStar]);
  return <canvas ref={canvas} width={48} height={48} className="tool-icon" aria-hidden="true" />;
}
