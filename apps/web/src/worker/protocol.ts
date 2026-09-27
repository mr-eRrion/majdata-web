import type { Checkpoint, DisplaySnapshot, EditCommand, ExportResult } from '../../../../packages/chart-core/src/types';

interface Envelope { requestId: number; generation: string }
export type WorkerRequest = Envelope & (
  | { type: 'initialize'; runtimeBaseUrl: string }
  | { type: 'import'; bytes: Uint8Array }
  | { type: 'edit'; baseVersion: number; command: EditCommand }
  | { type: 'export'; baseVersion: number }
  | { type: 'checkpoint'; baseVersion: number }
  | { type: 'restore'; checkpoint: Checkpoint }
);
export type WorkerResponse = Envelope & (
  | { ok: true; type: 'ready' }
  | { ok: true; type: 'snapshot'; snapshot: DisplaySnapshot }
  | { ok: true; type: 'export'; result: ExportResult }
  | { ok: true; type: 'checkpoint'; checkpoint: Checkpoint }
  | { ok: false; error: string }
);
