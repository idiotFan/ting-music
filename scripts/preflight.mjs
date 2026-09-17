import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, resourceManifest, sourceManifest } from './source-manifest.mjs';
const check = spawnSync(process.execPath, ['scripts/check-release.mjs'], {cwd: root, stdio: 'inherit'});
if (check.status !== 0) process.exit(check.status ?? 1);
mkdirSync(resolve(root, 'resources/build'), {recursive: true});
writeFileSync(resolve(root, 'resources/build/ting-build-info.json'), JSON.stringify({
  ...sourceManifest(), resources: resourceManifest(),
}, null, 2) + '\n');
console.log('Recorded native Rust build source and resource fingerprints.');
