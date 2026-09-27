import type { AudioCue } from './types';

const MAX_ACTIVE_CUES = 128;
const MIN_CUE_DURATION_SECONDS = 0.008;
const MAX_CUE_DURATION_SECONDS = 0.15;

export class CueSynth {
  private readonly active = new Map<string, OscillatorNode>();

  constructor(private readonly context: AudioContext) {}

  schedule(cue: AudioCue, contextTime: number, occurrenceKey: string): boolean {
    if (this.active.size >= MAX_ACTIVE_CUES || this.active.has(occurrenceKey)) return false;
    const now = this.context.currentTime;
    const at = Math.max(now + 0.003, contextTime);
    const duration = clamp(cue.durationSeconds ?? 0.045, MIN_CUE_DURATION_SECONDS, MAX_CUE_DURATION_SECONDS);
    const frequency = clamp(cue.frequencyHz ?? 880, 80, 4000);
    const amplitude = clamp(cue.gain ?? 0.16, 0.001, 0.3);
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();

    oscillator.type = cue.waveform ?? 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(amplitude, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(envelope);
    envelope.connect(this.context.destination);
    this.active.set(occurrenceKey, oscillator);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      this.active.delete(occurrenceKey);
    };
    oscillator.start(at);
    oscillator.stop(at + duration + 0.002);
    return true;
  }

  stopAll(): void {
    for (const oscillator of this.active.values()) {
      try {
        oscillator.stop();
      } catch {
        // A node may already have ended between scheduling ticks.
      }
      oscillator.disconnect();
    }
    this.active.clear();
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

