import { describe, expect, it, vi } from 'vitest';
import { ChartWorkerClient } from './client';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { DisplaySnapshot } from '../../../../packages/chart-core/src/types';

class FakeWorker {
  onmessage?: (event: MessageEvent<WorkerResponse>) => void;
  onerror?: (event: ErrorEvent) => void;
  onmessageerror?: () => void;
  requests: WorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(request: WorkerRequest) { this.requests.push(request); }
  reply(payload: Record<string, unknown>) {
    const request = this.requests.at(-1)!;
    this.onmessage?.({ data: { requestId: request.requestId, generation: request.generation, ...payload } } as MessageEvent<WorkerResponse>);
  }
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const snapshot = (generation: string, version: number): DisplaySnapshot => ({
  generation, version, firstSeconds: 0, metadata: {}, metadataEditable: true, charts: [], diagnostics: [],
  canUndo: version > 0, canRedo: false, modified: version > 0,
});

async function setup() {
  const worker = new FakeWorker();
  const failure = vi.fn();
  const client = new ChartWorkerClient(worker as unknown as Worker, failure, 'http://localhost/wasm/');
  worker.reply({ ok: true, type: 'ready' });
  const imported = client.import(new TextEncoder().encode('&inote_1=(120){4}1,E'));
  await settle();
  const generation = worker.requests.at(-1)!.generation;
  worker.reply({ ok: true, type: 'snapshot', snapshot: snapshot(generation, 0) });
  await imported;
  return { worker, client, failure, generation };
}

describe('single-writer confirmations', () => {
  it('sends the next write only after confirmation and uses the confirmed version', async () => {
    const { worker, client, generation } = await setup();
    const first = client.edit({ type: 'set-first', seconds: 0.1 });
    const second = client.edit({ type: 'set-first', seconds: 0.2 });
    await settle();
    expect(worker.requests.filter((r) => r.type === 'edit')).toHaveLength(1);
    expect(worker.requests.at(-1)).toMatchObject({ baseVersion: 0 });
    worker.reply({ ok: true, type: 'snapshot', snapshot: snapshot(generation, 1) });
    await first;
    await settle();
    expect(worker.requests.at(-1)).toMatchObject({ baseVersion: 1 });
    worker.reply({ ok: true, type: 'snapshot', snapshot: snapshot(generation, 2) });
    expect((await second).version).toBe(2);
    client.dispose();
  });

  it('does not advance or retry a rejected write', async () => {
    const { worker, client, generation } = await setup();
    const failed = expect(client.edit({ type: 'set-first', seconds: NaN })).rejects.toThrow('invalid');
    await settle();
    worker.reply({ ok: false, error: 'invalid' });
    await failed;
    const next = client.edit({ type: 'set-first', seconds: 0.2 });
    await settle();
    expect(worker.requests.at(-1)).toMatchObject({ baseVersion: 0 });
    expect(worker.requests.filter((r) => r.type === 'edit')).toHaveLength(2);
    worker.reply({ ok: true, type: 'snapshot', snapshot: snapshot(generation, 1) });
    await next;
    client.dispose();
  });

  it('fails pending and queued work on Worker crash instead of claiming confirmation', async () => {
    const { worker, client, failure } = await setup();
    const first = expect(client.edit({ type: 'undo' })).rejects.toThrow('crash');
    const second = expect(client.checkpoint()).rejects.toThrow('crash');
    await settle();
    worker.onerror?.({ message: 'crash' } as ErrorEvent);
    await Promise.all([first, second]);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.requests.filter((r) => r.type === 'checkpoint')).toHaveLength(0);
  });
});
