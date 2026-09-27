import type { Checkpoint, DisplaySnapshot, EditCommand, ExportResult } from '../../../../packages/chart-core/src/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** Single queue; acknowledgements are never retried or discarded as stale draws. */
export class ChartWorkerClient {
  private nextRequest = 0;
  private generation = '';
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { request: WorkerRequest; resolve: (reply: WorkerResponse) => void; reject: (error: Error) => void };
  private failure?: Error;

  constructor(private worker: Worker, private onFailure: (error: Error) => void, runtimeBaseUrl: string) {
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const pending = this.pending;
      if (!pending) return;
      if (data.requestId !== pending.request.requestId || data.generation !== pending.request.generation) {
        this.fail(new Error('Worker 返回了不匹配的请求确认，编辑已停止。'));
        return;
      }
      this.pending = undefined;
      if (!data.ok) pending.reject(new Error(data.error));
      else pending.resolve(data);
    };
    worker.onerror = (event) => this.fail(new Error(event.message || '谱面 Worker 已停止。'));
    worker.onmessageerror = () => this.fail(new Error('无法读取 Worker 返回的数据。'));
    this.queue = this.send({ type: 'initialize', runtimeBaseUrl, requestId: ++this.nextRequest, generation: '' })
      .then((reply) => {
        if (!reply.ok || reply.type !== 'ready') throw new Error('谱面运行时初始化失败。');
      }).catch((error: Error) => this.fail(error));
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.pending?.reject(error);
    this.pending = undefined;
    this.worker.terminate();
    this.onFailure(error);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.failure) throw this.failure;
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private send(request: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending = { request, resolve, reject };
      try { this.worker.postMessage(request); }
      catch (error) {
        this.pending = undefined;
        reject(error);
      }
    });
  }

  private envelope() { return { requestId: ++this.nextRequest, generation: this.generation }; }

  import(bytes: Uint8Array): Promise<DisplaySnapshot> {
    return this.serial(async () => {
      const generation = crypto.randomUUID();
      const result = await this.send({ type: 'import', bytes, requestId: ++this.nextRequest, generation });
      if (!result.ok || result.type !== 'snapshot') throw new Error('导入未返回显示快照。');
      this.generation = generation;
      this.version = result.snapshot.version;
      return result.snapshot;
    });
  }

  edit(command: EditCommand): Promise<DisplaySnapshot> {
    return this.serial(async () => {
      const result = await this.send({ type: 'edit', ...this.envelope(), baseVersion: this.version, command });
      if (!result.ok || result.type !== 'snapshot') throw new Error('编辑未返回显示快照。');
      this.version = result.snapshot.version;
      return result.snapshot;
    });
  }

  export(): Promise<ExportResult> {
    return this.serial(async () => {
      const result = await this.send({ type: 'export', ...this.envelope(), baseVersion: this.version });
      if (!result.ok || result.type !== 'export') throw new Error('导出未返回候选文件。');
      return result.result;
    });
  }

  checkpoint(): Promise<Checkpoint> {
    return this.serial(async () => {
      const result = await this.send({ type: 'checkpoint', ...this.envelope(), baseVersion: this.version });
      if (!result.ok || result.type !== 'checkpoint') throw new Error('未取得恢复检查点。');
      return result.checkpoint;
    });
  }

  restore(checkpoint: Checkpoint): Promise<DisplaySnapshot> {
    return this.serial(async () => {
      const generation = crypto.randomUUID();
      const result = await this.send({ type: 'restore', checkpoint, requestId: ++this.nextRequest, generation });
      if (!result.ok || result.type !== 'snapshot') throw new Error('恢复未返回显示快照。');
      this.generation = generation;
      this.version = result.snapshot.version;
      return result.snapshot;
    });
  }

  dispose() {
    const error = new Error('谱面 Worker 已关闭。');
    this.failure = error;
    this.pending?.reject(error);
    this.pending = undefined;
    this.worker.terminate();
  }
}
