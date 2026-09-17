import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const [command, args] of [
  ['python3', ['-B', 'scripts/prepare-runtime.py']],
  [resolve(root, 'resources/python/bin/python3.12'), ['-I', '-B', 'scripts/prepare-resources.py']],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
