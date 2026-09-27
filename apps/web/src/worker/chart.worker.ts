import { createMajSimaiParser } from '../../../../packages/majsimai-browser/src/bridge';
import { ChartEngine } from '../../../../packages/chart-core/src/engine';
import { withVisualChecks } from '../checks/snapshot';
import type { WorkerRequest, WorkerResponse } from './protocol';

let engine: ChartEngine | undefined;
let queue = Promise.resolve();
let lastRequestId = 0;

async function handle(request: WorkerRequest): Promise<WorkerResponse> {
  const envelope = { requestId: request.requestId, generation: request.generation };
  try {
    if (request.requestId <= lastRequestId) throw new Error('请求编号重复或顺序错误；操作未执行。');
    lastRequestId = request.requestId;
    if (request.type === 'initialize') {
      if (engine) throw new Error('Worker 已初始化。');
      const parser = await createMajSimaiParser(request.runtimeBaseUrl);
      engine = new ChartEngine((text) => parser.parse(text));
      return { ...envelope, ok: true, type: 'ready' };
    }
    if (!engine) throw new Error('谱面运行时尚未就绪。');
    switch (request.type) {
      case 'import':
        return { ...envelope, ok: true, type: 'snapshot', snapshot: withVisualChecks(await engine.import(request.bytes, request.generation)) };
      case 'edit':
        return { ...envelope, ok: true, type: 'snapshot', snapshot: withVisualChecks(engine.apply(request)) };
      case 'export':
        return { ...envelope, ok: true, type: 'export', result: await engine.export(request.generation, request.baseVersion) };
      case 'checkpoint':
        return { ...envelope, ok: true, type: 'checkpoint', checkpoint: engine.checkpoint(request.generation, request.baseVersion) };
      case 'restore':
        return { ...envelope, ok: true, type: 'snapshot', snapshot: withVisualChecks(await engine.restore(request.checkpoint, request.generation)) };
    }
  } catch (error) {
    return { ...envelope, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

self.addEventListener('message', ({ data }: MessageEvent<WorkerRequest>) => {
  queue = queue.then(async () => { self.postMessage(await handle(data)); });
});
