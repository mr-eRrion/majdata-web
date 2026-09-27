import type { ParserResult } from './types.js';

interface AssemblyExports {
  MajSimaiBrowser: {
    WasmApi: {
      ParseStrict(sourceText: string): string;
    };
  };
}

interface DotnetRuntime {
  withDiagnosticTracing(enabled: boolean): DotnetRuntime;
  create(): Promise<{
    getConfig(): { mainAssemblyName: string };
    getAssemblyExports(name: string): Promise<AssemblyExports>;
  }>;
}

interface DotnetModule {
  dotnet: DotnetRuntime;
}

let runtimePromise: Promise<(sourceText: string) => string> | undefined;
let runtimeBase: string | undefined;

async function initializeDotnet(baseUrl: string): Promise<(sourceText: string) => string> {
  const moduleUrl = new URL('_framework/dotnet.js', baseUrl).href;
  const module = (await import(/* @vite-ignore */ moduleUrl)) as DotnetModule;
  const { getConfig, getAssemblyExports } = await module.dotnet
    .withDiagnosticTracing(false)
    .create();
  const config = getConfig();
  const exports = await getAssemblyExports(config.mainAssemblyName);
  return exports.MajSimaiBrowser.WasmApi.ParseStrict;
}

/**
 * Load the .NET runtime into the calling web worker and expose its batched
 * parser entry. This function deliberately does not create or own a Worker:
 * the editor's chart worker remains the single owner of parser and document.
 */
export async function createMajSimaiParser(baseUrl: string | URL): Promise<{
  parse(sourceText: string): Promise<ParserResult>;
  dispose(): void;
}> {
  const base = new URL(baseUrl, globalThis.location.href);
  if (!base.href.endsWith('/')) base.pathname += '/';

  if (runtimeBase && runtimeBase !== base.href) {
    throw new Error(`MajSimai WASM already initialized from ${runtimeBase}`);
  }
  runtimeBase = base.href;
  runtimePromise ??= initializeDotnet(runtimeBase);

  let parseStrict = await runtimePromise;
  return {
    async parse(sourceText) {
      const json = parseStrict(sourceText);
      return JSON.parse(json) as ParserResult;
    },
    dispose() {
      // The browser runtime has no supported per-instance unload API. Dropping
      // this adapter reference leaves one runtime owned by the worker lifetime.
      parseStrict = () => {
        throw new Error('MajSimai parser adapter has been disposed');
      };
    },
  };
}
