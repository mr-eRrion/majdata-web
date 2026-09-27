import type { Checkpoint } from '../../../../packages/chart-core/src/types.js';

const DATABASE_NAME = 'maijdata-recovery';
const DATABASE_VERSION = 1;
const STORE_NAME = 'checkpoints';
const LATEST_KEY = 'latest';

export type RecoveryReadResult =
  | { status: 'available'; checkpoint: Checkpoint }
  | { status: 'none' }
  | {
      status: 'incompatible';
      reason: string;
      createdAt?: string;
      version?: number;
      originalBytes?: Uint8Array;
    };

export async function saveRecovery(checkpoint: Checkpoint): Promise<void> {
  const database = await openRecoveryDatabase();
  try {
    await transact(database, 'readwrite', (store) => store.put(checkpoint, LATEST_KEY));
  } finally {
    database.close();
  }
}

export async function readRecovery(): Promise<RecoveryReadResult> {
  const database = await openRecoveryDatabase();
  try {
    const value: unknown = await transact(database, 'readonly', (store) => store.get(LATEST_KEY));
    if (value === undefined) return { status: 'none' };
    return classifyCheckpoint(value);
  } finally {
    database.close();
  }
}

export async function discardRecovery(): Promise<void> {
  const database = await openRecoveryDatabase();
  try {
    await transact(database, 'readwrite', (store) => store.delete(LATEST_KEY));
  } finally {
    database.close();
  }
}

function openRecoveryDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前浏览器环境不支持 IndexedDB。'));

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开本地恢复存储。'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('本地恢复存储正在被旧连接占用。'));
    };
  });
}

function transact<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest<T>;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      request = operation(transaction.objectStore(STORE_NAME));
    } catch (cause) {
      reject(asError(cause));
      return;
    }

    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error('本地恢复存储请求失败。'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('本地恢复存储事务失败。'));
    transaction.onabort = () => reject(transaction.error ?? new Error('本地恢复存储事务已中止。'));
  });
}

function classifyCheckpoint(value: unknown): RecoveryReadResult {
  const record = objectRecord(value);
  const document = objectRecord(record?.document);
  const originalBytes = asOriginalBytes(document?.originalBytes);
  const createdAt = typeof record?.createdAt === 'string' ? record.createdAt : undefined;
  const version = typeof document?.version === 'number' && Number.isSafeInteger(document.version)
    ? document.version
    : undefined;

  const metadata = objectRecord(document?.metadata);
  const compatible = (record?.schemaVersion === 3 || record?.schemaVersion === 4 || record?.schemaVersion === 5)
    && createdAt !== undefined
    && document !== null
    && typeof document.generation === 'string'
    && version !== undefined
    && originalBytes !== undefined
    && typeof document.originalText === 'string'
    && Array.isArray(document.fields)
    && typeof document.globalEditable === 'boolean'
    && Number.isFinite(document.firstSeconds)
    && Number.isFinite(document.originalFirstSeconds)
    && metadata !== null
    && Object.values(metadata).every((value) => typeof value === 'string')
    && typeof document.metadataEditable === 'boolean'
    && Array.isArray(document.charts)
    && Array.isArray(document.diagnostics);

  if (compatible) return { status: 'available', checkpoint: value as Checkpoint };
  return {
    status: 'incompatible',
    reason: '本地检查点结构或 schemaVersion 不兼容；为保护原稿，未自动迁移或删除。',
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(version === undefined ? {} : { version }),
    ...(originalBytes === undefined ? {} : { originalBytes }),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asOriginalBytes(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
