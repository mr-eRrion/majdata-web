import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sdkRoot = path.join(projectRoot, '.tools/dotnet');
const dotnet = path.join(sdkRoot, 'dotnet');
const output = path.join(projectRoot, '.tools/dotnet-publish/majsimai-browser');
const harnessAssets = path.join(projectRoot, '.tools/dotnet-publish/p0-harness');
const publicAssets = path.join(projectRoot, 'apps/web/public/wasm');
const project = path.join(projectRoot, 'packages/majsimai-browser/host/MajSimaiBrowser.csproj');
const runtimePackRoot = path.join(sdkRoot, 'packs/Microsoft.NETCore.App.Runtime.Mono.browser-wasm');
const expectedRuntimePackVersion = '10.0.12';

const env = {
  ...process.env,
  DOTNET_ROOT: sdkRoot,
  DOTNET_CLI_HOME: path.join(projectRoot, '.tools/dotnet-cli-home'),
  NUGET_PACKAGES: path.join(projectRoot, '.tools/nuget'),
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
};

await rm(output, { recursive: true, force: true });
await mkdir(path.dirname(output), { recursive: true });
const { stdout, stderr } = await execFileAsync(dotnet, [
  'publish', project, '--configuration', 'Release', '--output', output,
  '--no-restore', '-m:1', '-nr:false',
], { cwd: projectRoot, env, maxBuffer: 16 * 1024 * 1024 });
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

await rm(publicAssets, { recursive: true, force: true });
await mkdir(path.dirname(publicAssets), { recursive: true });
await mkdir(publicAssets, { recursive: true });
await cp(path.join(output, 'wwwroot'), publicAssets, { recursive: true });
const runtimePackVersions = (await readdir(runtimePackRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
if (runtimePackVersions.length !== 1 || runtimePackVersions[0] !== expectedRuntimePackVersion)
  throw new Error(`Expected the SDK-resolved browser WASM runtime pack ${expectedRuntimePackVersion} under ${runtimePackRoot}, found: ${runtimePackVersions.join(', ')}`);
const runtimePack = path.join(runtimePackRoot, runtimePackVersions[0]);
await cp(path.join(runtimePack, 'LICENSE.TXT'), path.join(publicAssets, 'DOTNET-LICENSE.txt'));
await cp(path.join(runtimePack, 'THIRD-PARTY-NOTICES.TXT'), path.join(publicAssets, 'DOTNET-THIRD-PARTY-NOTICES.txt'));
await rm(harnessAssets, { recursive: true, force: true });
await mkdir(harnessAssets, { recursive: true });
await cp(path.join(output, 'wwwroot/_framework'), path.join(harnessAssets, '_framework'), { recursive: true });
await cp(path.join(output, 'p0-harness.mjs'), path.join(harnessAssets, 'p0-harness.mjs'));
await cp(path.join(output, 'p0-harness.html'), path.join(harnessAssets, 'p0-harness.html'));

async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

process.stdout.write(`WASM framework copied to apps/web/public/wasm (${await directoryBytes(publicAssets)} bytes on disk).\n`);
process.stdout.write(`Runtime-pack legal notices copied from ${path.basename(runtimePackRoot)}/${runtimePackVersions[0]}.\n`);
process.stdout.write(`P0 harness kept outside the product output at .tools/dotnet-publish/p0-harness.\n`);
