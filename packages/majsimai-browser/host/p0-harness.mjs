import { dotnet } from './_framework/dotnet.js';

const initStarted = performance.now();
const { getConfig, getAssemblyExports } = await dotnet
  .withDiagnosticTracing(false)
  .create();
const config = getConfig();
const api = (await getAssemblyExports(config.mainAssemblyName)).MajSimaiBrowser.WasmApi;

self.postMessage({ type: 'ready', initMs: performance.now() - initStarted });
self.addEventListener('message', (event) => {
  const { id, sourceText } = event.data ?? {};
  if (typeof sourceText !== 'string') return;
  const started = performance.now();
  try {
    const json = api.ParseStrict(sourceText);
    self.postMessage({ id, parseMs: performance.now() - started, json });
  } catch (error) {
    self.postMessage({ id, error: String(error), parseMs: performance.now() - started });
  }
});
