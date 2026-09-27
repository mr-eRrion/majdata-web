import { useCallback, useEffect, useRef, useState } from 'react';
import type { Checkpoint, DisplaySnapshot, EditCommand, ExportResult } from '../../../../packages/chart-core/src/types';
import { ChartWorkerClient } from '../worker/client';

export function useEditor(onCheckpoint?: (checkpoint: Checkpoint) => Promise<void>) {
  const client = useRef<ChartWorkerClient | null>(null);
  const checkpointCallback = useRef(onCheckpoint);
  checkpointCallback.current = onCheckpoint;
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null);
  const currentSnapshot = useRef<DisplaySnapshot | null>(null);
  const [originalBytes, setOriginalBytes] = useState<Uint8Array | null>(null);
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [workerFailed, setWorkerFailed] = useState(false);
  const [exportedVersion, setExportedVersion] = useState<number | null>(null);
  const [hasExported, setHasExported] = useState(false);
  const [documentChanging, setDocumentChanging] = useState(false);
  const changingDocument = useRef(0);
  const getSnapshot = useCallback(() => changingDocument.current ? null : currentSnapshot.current, []);
  const checkpointRequest = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });

  const createClient = useCallback(() => {
    const worker = new Worker(new URL('../worker/chart.worker.ts', import.meta.url), { type: 'module' });
    const next = new ChartWorkerClient(worker, (cause) => {
      if (client.current !== next) return;
      setWorkerFailed(true);
      setError(cause.message);
    }, new URL('wasm/', document.baseURI).href);
    client.current = next;
    setWorkerFailed(false);
    return next;
  }, []);

  useEffect(() => {
    createClient();
    return () => { client.current?.dispose(); client.current = null; };
  }, [createClient]);

  const requestCheckpoint = useCallback(async function capture() {
    const state = checkpointRequest.current;
    if (state.running) { state.again = true; return; }
    state.running = true;
    const owner = client.current;
    try {
      if (!owner) return;
      const complete = await owner.checkpoint();
      if (client.current !== owner) return;
      setCheckpoint(complete);
      await checkpointCallback.current?.(complete);
    } catch (cause) {
      if (client.current === owner) setError(`恢复检查点未更新：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      state.running = false;
      if (state.again) { state.again = false; void capture(); }
    }
  }, []);

  const importBytes = useCallback(async (bytes: Uint8Array) => {
    const owner = client.current;
    if (!owner) throw new Error('谱面 Worker 尚未建立。');
    changingDocument.current += 1;
    setDocumentChanging(true);
    setPending((count) => count + 1);
    setError('');
    try {
      const next = await owner.import(bytes);
      if (client.current !== owner) return;
      currentSnapshot.current = next;
      setSnapshot(next);
      setOriginalBytes(bytes);
      setExportedVersion(next.version);
      setHasExported(false);
      void requestCheckpoint();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      changingDocument.current -= 1;
      setDocumentChanging(changingDocument.current > 0);
      setPending((count) => count - 1);
    }
  }, [requestCheckpoint]);

  const edit = useCallback(async (command: EditCommand) => {
    const owner = client.current;
    if (!owner) throw new Error('谱面 Worker 尚未建立。');
    setPending((count) => count + 1);
    setError('');
    try {
      const next = await owner.edit(command);
      if (client.current !== owner) return;
      currentSnapshot.current = next;
      setSnapshot(next);
      void requestCheckpoint();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally { setPending((count) => count - 1); }
  }, [requestCheckpoint]);

  const exportCandidate = useCallback(async (): Promise<ExportResult> => {
    const owner = client.current;
    if (!owner) throw new Error('谱面 Worker 尚未建立。');
    setPending((count) => count + 1);
    setError('');
    try { return await owner.export(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { setPending((count) => count - 1); }
  }, []);

  const markExported = useCallback((result: ExportResult) => {
    if (currentSnapshot.current?.generation === result.generation) {
      setExportedVersion(result.version);
      setHasExported(true);
    }
  }, []);

  const restore = useCallback(async (saved: Checkpoint) => {
    changingDocument.current += 1;
    setDocumentChanging(true);
    client.current?.dispose();
    const owner = createClient();
    setPending((count) => count + 1);
    setError('');
    try {
      const next = await owner.restore(saved);
      if (client.current !== owner) return;
      currentSnapshot.current = next;
      setSnapshot(next);
      setOriginalBytes(saved.document.originalBytes);
      setExportedVersion(null);
      setHasExported(false);
      void requestCheckpoint();
    } catch (cause) {
      setWorkerFailed(true);
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
    finally {
      changingDocument.current -= 1;
      setDocumentChanging(changingDocument.current > 0);
      setPending((count) => count - 1);
    }
  }, [createClient, requestCheckpoint]);

  return {
    snapshot, originalBytes, checkpoint, error, setError, workerFailed, hasExported, documentChanging,
    busy: pending > 0, dirty: snapshot !== null && snapshot.version !== exportedVersion,
    importBytes, edit, exportCandidate, markExported, restore, getSnapshot,
  };
}
