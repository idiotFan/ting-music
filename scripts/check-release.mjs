import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const pkg = JSON.parse(read('package.json'));
const npm = JSON.parse(read('package-lock.json'));
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml').match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
const lockedCargo = read('src-tauri/Cargo.lock').match(/\[\[package\]\]\nname = "ting-music"\nversion = "([^"]+)"/)?.[1];
for (const [name, version] of Object.entries({ 'package-lock.json': npm.version, 'package-lock root': npm.packages[''].version,
  'tauri.conf.json': tauri.version, 'Cargo.toml': cargo, 'Cargo.lock': lockedCargo })) {
  if (version !== pkg.version) throw new Error(`${name} version ${version} differs from package.json ${pkg.version}`);
}
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean))];
const forbidden = /(^|\/)(?:node_modules|target|dist|work|vendor|\.gitnexus|\.ssh|python)(?:\/|$)|(?:^|\/)(?:\.env(?:\..+)?|(?:.*_)?cookies?\.txt|credentials(?:\..+)?\.json)$|\.(?:app|key|pem|p12|pfx|mobileprovision|cookie|cookies)(?:\/|$)/i;
for (const name of files) {
  if (name === '.env.example') continue;
  if (forbidden.test(name)) throw new Error(`Private/generated file is eligible for Git: ${name}`);
  const stat = lstatSync(resolve(root, name));
  if (stat.isSymbolicLink()) throw new Error(`Source release cannot contain an unreviewed symbolic link: ${name}`);
  if (stat.size > 5 * 1024 * 1024) throw new Error(`Unexpected large source file (>5 MiB): ${name}`);
}
console.log(`Release metadata consistent: ${pkg.version}; ${files.length} Git candidate files checked.`);
