import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stdout } = await run('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root });
const packages = Object.values(JSON.parse(stdout)).flat();
const notices = ['maijdata third-party JavaScript dependency notices\n'];
for (const dependency of packages.sort((a, b) => a.name.localeCompare(b.name))) {
  for (const directory of dependency.paths) {
    const names = (await readdir(directory)).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
    notices.push(`\n=== ${dependency.name} ${dependency.versions.join(', ')} (${dependency.license}) ===\n`);
    if (!names.length) {
      if (dependency.name !== '@pixi/colord' || dependency.versions.join(',') !== '2.9.6') throw new Error(`No license text found for ${dependency.name}`);
      notices.push(await readFile(path.join(root, 'vendor/licenses/pixi-colord-2.9.6.txt'), 'utf8'));
    }
    for (const name of names) notices.push(await readFile(path.join(directory, name), 'utf8'));
  }
}
await writeFile(path.join(root, 'dist/DEPENDENCY-LICENSES.txt'), notices.join('\n'));
await cp(path.join(root, 'LICENSE'), path.join(root, 'dist/LICENSE.txt'));
await cp(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(root, 'dist/THIRD_PARTY_NOTICES.md'));
const sources = ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', 'package.json', 'pnpm-lock.yaml', '.node-version', 'global.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', '.github', 'apps/web/index.html', 'apps/web/src', 'packages', 'tools', 'tests', 'fixtures', 'vendor', 'docs'];
// Include only prepared target assets; the local installation and generated WASM are not source inputs.
sources.push('apps/web/public/assets', 'apps/web/public/skin-reference.html', 'apps/web/public/skin-reference-data.json');
await run('tar', ['--exclude=*/bin', '--exclude=*/obj', '--exclude=*/.git', '--exclude=*/__pycache__', '--exclude=*.pyc', '--exclude=.DS_Store', '--exclude=PLAN*.md', '--exclude=ROADMAP*.md', '--exclude=docs/reviews', '-czf', path.join(root, 'dist/source.tar.gz'), ...sources], {
  cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' },
});
console.log(`Release includes source.tar.gz and license notices for ${packages.length} dependency packages.`);
