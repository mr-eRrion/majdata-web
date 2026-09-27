import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5175/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { saveRecovery, readRecovery, discardRecovery } = await import('/src/files/index.ts');
    const originalBytes = new Uint8Array([0x6d, 0x61, 0x69, 0x0a]);
    const checkpoint = {
      schemaVersion: 3,
      createdAt: new Date().toISOString(),
      document: {
        generation: 'indexeddb-browser-validation',
        version: 7,
        originalBytes,
        originalText: 'mai\n',
        fields: [],
        globalEditable: true,
        firstSeconds: -0.25,
        originalFirstSeconds: -0.25,
        metadata: {},
        metadataEditable: false,
        charts: [],
        diagnostics: [],
      },
    };
    await saveRecovery(checkpoint);
    try {
      const loaded = await readRecovery();
      if (loaded.status !== 'available') throw new Error(`Unexpected read status: ${loaded.status}`);
      const exactBytes = Array.from(loaded.checkpoint.document.originalBytes).join(',') === Array.from(originalBytes).join(',');
      if (!exactBytes || loaded.checkpoint.document.version !== 7) throw new Error('Checkpoint fields did not survive structured clone.');
      if (!loaded.checkpoint.document.metadata || loaded.checkpoint.document.metadataEditable !== false) throw new Error('Schema 3 metadata fields did not survive structured clone.');
      return { readStatus: loaded.status, schemaVersion: loaded.checkpoint.schemaVersion, version: loaded.checkpoint.document.version, bytesRoundTrip: exactBytes };
    } finally {
      await discardRecovery();
    }
  });
  const afterDelete = await page.evaluate(async () => (await import('/src/files/index.ts')).readRecovery());
  const legacy = await page.evaluate(async () => {
    const { saveRecovery, readRecovery, discardRecovery } = await import('/src/files/index.ts');
    const originalBytes = new Uint8Array([0x6d, 0x61, 0x69, 0x0a]);
    await saveRecovery({
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      document: {
        generation: 'indexeddb-browser-validation-v2', version: 6, originalBytes, originalText: 'mai\n',
        fields: [], globalEditable: true, firstSeconds: 0, originalFirstSeconds: 0,
        metadata: {}, metadataEditable: false, charts: [], diagnostics: [],
      },
    });
    try {
      const result = await readRecovery();
      const bytesRoundTrip = result.status === 'incompatible'
        && Array.from(result.originalBytes ?? []).join(',') === Array.from(originalBytes).join(',');
      return { status: result.status, bytesAvailable: bytesRoundTrip };
    } finally {
      await discardRecovery();
    }
  });
  assert.deepEqual(afterDelete, { status: 'none' });
  assert.deepEqual(result, { readStatus: 'available', schemaVersion: 3, version: 7, bytesRoundTrip: true });
  assert.deepEqual(legacy, { status: 'incompatible', bytesAvailable: true });
  console.log(`Chromium ${browser.version()}: IndexedDB schema 3 write/read/delete and legacy raw-byte recovery passed`, JSON.stringify({ current: result, legacy }));
} finally {
  await browser.close();
}
