import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import { composeNote, iconFrame, type SkinPart } from './composition.js';

const tinted = new Map<string, HTMLCanvasElement>();
function sourceImage(part: SkinPart, image: HTMLImageElement): CanvasImageSource {
  if (part.tint === 0xffffff) return image;
  const key = `${part.key}:${part.tint}`;
  let canvas = tinted.get(key);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `#${part.tint.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(image, 0, 0);
    tinted.set(key, canvas);
  }
  return canvas;
}

/** Compact static icon; duration and selection aids are drawn by the timeline. */
export function drawNoteGlyph(ctx: CanvasRenderingContext2D, note: DisplayNote, x: number, y: number, size: number, images: Map<string, HTMLImageElement>): void {
  drawSkinPartsGlyph(ctx, composeNote(note, iconFrame), x, y, size, images);
}

/** Draw an already-composed source prefab with the same sprite slicing and tint rules. */
export function drawSkinPartsGlyph(ctx: CanvasRenderingContext2D, parts: readonly SkinPart[], x: number, y: number, size: number, images: Map<string, HTMLImageElement>): void {
  if (!parts.length) return;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const part of parts) {
    const cosine = Math.cos(part.rotation), sine = Math.sin(part.rotation);
    for (const px of [-part.anchorX * part.width, (1 - part.anchorX) * part.width]) {
      for (const py of [-part.anchorY * part.height, (1 - part.anchorY) * part.height]) {
        const cx = part.x + cosine * px * part.scaleX - sine * py * part.scaleY;
        const cy = part.y + sine * px * part.scaleX + cosine * py * part.scaleY;
        left = Math.min(left, cx); right = Math.max(right, cx);
        top = Math.min(top, cy); bottom = Math.max(bottom, cy);
      }
    }
  }
  const scale = size / Math.max(right - left, bottom - top);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.translate(-(left + right) / 2, -(top + bottom) / 2);
  for (const part of parts) {
    const image = images.get(part.key);
    if (!image) continue; // Caller reports failed loading; never replace a missing image with geometry.
    const source = sourceImage(part, image);
    ctx.save();
    ctx.translate(part.x, part.y); ctx.rotate(part.rotation); ctx.scale(part.scaleX, part.scaleY);
    ctx.globalAlpha *= part.alpha;
    const ox = -part.anchorX * part.width, oy = -part.anchorY * part.height;
    if (part.progress !== undefined && part.progress < 1) {
      const x = ox + part.width / 2, y = oy + part.height / 2;
      const radius = Math.hypot(part.width, part.height);
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x, y - radius);
      ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + Math.max(0, part.progress) * 2 * Math.PI);
      ctx.closePath(); ctx.clip();
    }
    if (!part.borders) ctx.drawImage(source, ox, oy, part.width, part.height);
    else {
      const [l, t, r, b] = part.borders;
      const sx = [0, l, image.naturalWidth - r, image.naturalWidth];
      const sy = [0, t, image.naturalHeight - b, image.naturalHeight];
      const dx = [ox, ox + l / 100, ox + part.width - r / 100, ox + part.width];
      const dy = [oy, oy + t / 100, oy + part.height - b / 100, oy + part.height];
      for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
        const sw = sx[column + 1] - sx[column], sh = sy[row + 1] - sy[row];
        if (sw > 0 && sh > 0) ctx.drawImage(source, sx[column], sy[row], sw, sh, dx[column], dy[row], dx[column + 1] - dx[column], dy[row + 1] - dy[row]);
      }
    }
    ctx.restore();
  }
  ctx.restore();
}
