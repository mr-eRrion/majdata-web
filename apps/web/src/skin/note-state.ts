import type { DisplayNote } from '../../../../packages/chart-core/src/types.js';
import type { FrameState } from './composition.js';

const DISTANCE_PER_SECOND = 1.44444;
const RING_APPROACH_DISTANCE = 3.6;
const MAX_DISTANCE = 5.6;

export interface NoteFrame extends FrameState {
  visible: boolean;
  beatlineAlpha: number;
}

/**
 * Reconstructs the note-control state at an arbitrary chart time.
 * Speed defaults to the Web editor's initial setting; it is not a scene value.
 */
export function noteFrame(note: DisplayNote, chartSeconds: number, speed = 8, touchSpeed = 8): NoteFrame {
  const isTouch = note.kind === 'touch' || note.kind === 'touchHold';
  const noteSpeed = isTouch ? touchSpeed : speed;
  const distance = (note.startSeconds - chartSeconds) * noteSpeed * DISTANCE_PER_SECOND;
  const maxDistance = note.kind === 'touch' ? 4 : note.kind === 'touchHold' ? 3 : MAX_DISTANCE;
  const visibleUntil = note.kind === 'hold' || note.kind === 'touchHold' ? note.endSeconds : note.startSeconds;
  const visible = chartSeconds < visibleUntil && distance < maxDistance;

  let scale = 1;
  let alpha = 1;
  let beatlineAlpha = 1;
  let length = 0;
  let endpointVisible = false;
  let touchSpread = 0;
  let progress = 0;

  if (note.kind === 'tap' || note.kind === 'hold') {
    if (distance > RING_APPROACH_DISTANCE) {
      scale = (MAX_DISTANCE - distance) / 2;
      beatlineAlpha = scale;
    }
    if (note.kind === 'hold') {
      const headDistance = Math.max(0, Math.min(RING_APPROACH_DISTANCE, distance));
      const endDistance = note.endSeconds * speed * DISTANCE_PER_SECOND;
      const startDistance = note.startSeconds * speed * DISTANCE_PER_SECOND;
      const currentDistance = chartSeconds * speed * DISTANCE_PER_SECOND;
      const remaining = endDistance - Math.max(currentDistance, startDistance);
      if (distance <= RING_APPROACH_DISTANCE) {
        length = Math.min(remaining, RING_APPROACH_DISTANCE - headDistance);
        endpointVisible = remaining <= RING_APPROACH_DISTANCE - headDistance;
      }
    }
  } else {
    const max = note.kind === 'touch' ? 4 : 3;
    const normalized = distance / max - 1;
    touchSpread = Math.max(0, Math.min(0.3, 0.3 * (1 - normalized ** 4)));
    const inputAlpha = Math.max(0, Math.min(1, max - distance));
    alpha = inputAlpha * inputAlpha;
    if (note.kind === 'touchHold') {
      const duration = note.endSeconds - note.startSeconds;
      progress = duration > 0
        ? Math.max(0, Math.min(1, (chartSeconds - note.startSeconds) / duration))
        : chartSeconds >= note.endSeconds ? 1 : 0;
    }
  }

  return { visible, distance, scale, alpha, beatlineAlpha, length, endpointVisible, touchSpread, progress };
}
