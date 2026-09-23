// Writes the latest.json that installed apps read from the newest GitHub release.
// Usage: node scripts/updater-manifest.mjs --out <latest.json> [--notes <text>] <target>=<asset> ...
// Each <asset> is the file exactly as it will be named on the release, with the
// Tauri signature beside it as <asset>.sig. Targets: darwin-aarch64,
// darwin-x86_64, windows-x86_64, linux-x86_64-appimage, linux-x86_64-deb,
// linux-aarch64-appimage, linux-aarch64-deb.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const targets = new Set([
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64-appimage',
  'linux-x86_64-deb',
  'linux-aarch64-appimage',
  'linux-aarch64-deb',
]);
const args = process.argv.slice(2);
let out, notes = `听 · Ting ${version}`;
const platforms = {};
while (args.length) {
  const arg = args.shift();
  if (arg === '--out') out = args.shift();
  else if (arg === '--notes') notes = args.shift();
  else {
    const split = arg.indexOf('=');
    const target = arg.slice(0, split), asset = arg.slice(split + 1);
    if (split < 1 || !targets.has(target)) throw new Error(`Unknown updater target: ${arg}`);
    if (!/^[\w.-]+$/.test(basename(asset))) throw new Error(`Release asset names must be ASCII without spaces: ${basename(asset)}`);
    if (!existsSync(asset) || !existsSync(`${asset}.sig`)) throw new Error(`Missing package or signature: ${asset}`);
    // A repeated target would silently drop the platform it overwrites.
    if (platforms[target]) throw new Error(`Duplicate updater target: ${target}`);
    platforms[target] = {
      signature: readFileSync(`${asset}.sig`, 'utf8').trim(),
      url: `https://github.com/idiotFan/ting-music/releases/download/v${version}/${basename(asset)}`,
    };
  }
}
if (!out || !Object.keys(platforms).length) throw new Error('Usage: updater-manifest.mjs --out <latest.json> <target>=<asset> ...');
writeFileSync(out, JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2) + '\n');
console.log(`Updater manifest for ${version}: ${Object.keys(platforms).join(', ')}`);
