import { describe, expect, it, vi } from 'vitest';
import { LatestDecodeQueue } from './decode-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('latest-wins audio decode queue', () => {
  it('keeps one decode in flight and only decodes the newest waiting candidate', async () => {
    const firstDecode = deferred<string>();
    const calls: string[] = [];
    const accept = vi.fn();
    const discard = vi.fn();
    const queue = new LatestDecodeQueue<string, string>(async (input) => {
      calls.push(input);
      if (input === 'first') return firstDecode.promise;
      return input;
    }, { onAccepted: accept, onDiscarded: discard });

    const first = queue.submit('first');
    await Promise.resolve();
    const replaced = queue.submit('middle');
    const latest = queue.submit('latest');
    expect(await replaced).toEqual({ status: 'superseded', generation: 2 });
    firstDecode.resolve('decoded-first');

    expect(await first).toEqual({ status: 'superseded', generation: 1 });
    expect(await latest).toMatchObject({ status: 'completed', generation: 3, value: 'latest' });
    expect(calls).toEqual(['first', 'latest']);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith('decoded-first');
    queue.dispose();
  });
});

