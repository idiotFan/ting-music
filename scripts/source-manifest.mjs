import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function candidateFiles() {
  return [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean))].sort();
}
export function sourceManifest() {
  const hash = createHash('sha256');
  const files = candidateFiles();
  for (const name of files) {
    const path = resolve(root, name);
    if (!lstatSync(path).isFile()) throw new Error(`Expected a regular source file: ${name}`);
    hash.update(name); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0');
  }
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  const clean = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root }).length === 0;
  return { commit, clean, sourceSha256: hash.digest('hex'), sourceFileCount: files.length };
}
export function resourceManifest() {
  const hashes = {};
  const resources = resolve(root, 'resources');
  function walk(folder) {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = resolve(folder, item.name);
      const name = relative(resources, path).split('\\').join('/');
      if (name === 'build/ting-build-info.json') continue;
      if (item.isDirectory()) walk(path);
      else {
        if (/(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?\.json|(?:.*_)?cookies?\.txt|[^/]+\.(?:key|p12|pfx))$/i.test(name)) {
          throw new Error(`Unexpected sensitive file in bundled resources: ${name}`);
        }
        hashes[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  }
  for (const group of ['licenses']) walk(resolve(resources, group));
  return hashes;
}
if (process.argv.includes('--json')) console.log(JSON.stringify(sourceManifest()));
