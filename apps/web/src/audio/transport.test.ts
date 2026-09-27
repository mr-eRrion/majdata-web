import { describe, expect, it } from 'vitest';
import { AudioTransport } from './transport';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ResumeGateContext {
  currentTime = 0;
  sampleRate = 48_000;
  state: AudioContextState = 'suspended';
  destination = {};
  resumes: Array<ReturnType<typeof deferred<void>>> = [];

  resume(): Promise<void> {
    const gate = deferred<void>();
    this.resumes.push(gate);
    return gate.promise.then(() => { this.state = 'running'; });
  }
}

describe('AudioTransport play requests', () => {
  it('does not start after pause cancels a pending AudioContext resume', async () => {
    const context = new ResumeGateContext();
    const transport = new AudioTransport({ context: context as unknown as AudioContext });
    const playing = transport.play();
    transport.pause();
    context.resumes[0].resolve();
    await playing;

    expect(transport.getSnapshot().state).toBe('paused');
    expect(transport.getSnapshot().playbackGeneration).toBe(0);
    transport.dispose();
  });

  it('coalesces concurrent play calls into one transport generation', async () => {
    const context = new ResumeGateContext();
    const transport = new AudioTransport({ context: context as unknown as AudioContext });
    const first = transport.play();
    const second = transport.play();
    context.resumes.forEach((gate) => gate.resolve());
    await Promise.all([first, second]);

    expect(transport.getSnapshot().state).toBe('playing');
    expect(transport.getSnapshot().playbackGeneration).toBe(1);
    transport.dispose();
  });
});

