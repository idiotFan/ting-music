import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { resourceManifest, sourceManifest } from './source-manifest.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Packaged releases currently support macOS Apple Silicon only.');
const python = resolve(root, 'resources/python/bin/python3.12');
for (const [command, args] of [
  [process.execPath, ['scripts/check-release.mjs']],
  [python, ['-I', '-B', 'scripts/prepare-runtime.py', '--check']],
  [python, ['-I', '-B', 'scripts/prepare-resources.py', '--check']],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`Build prerequisites missing. Run npm run prepare:desktop first. ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
writeFileSync(resolve(root, 'resources/qq/ting-build-info.json'), JSON.stringify({
  ...sourceManifest(), resources: resourceManifest(),
}, null, 2) + '\n');
console.log('Recorded source and bundled-resource fingerprints for release verification.');
