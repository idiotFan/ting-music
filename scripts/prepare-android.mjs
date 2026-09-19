// Android init installs Tauri's template launcher icons. Reapply Ting's assets
// after init and before builds so regenerated projects keep the app identity.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = resolve(root, 'src-tauri/gen/android/app/src/main/res');
if (!existsSync(resources)) {
  throw new Error('Run npm run tauri -- android init before preparing Android.');
}
cpSync(resolve(root, 'src-tauri/icons/android'), resources, { recursive: true });
// Adaptive round icons must use the same foreground/background as the regular
// launcher icon; Android launchers choose their own masks.
const adaptive = resolve(resources, 'mipmap-anydpi-v26/ic_launcher.xml');
writeFileSync(resolve(resources, 'mipmap-anydpi-v26/ic_launcher_round.xml'), readFileSync(adaptive));
const manifest = resolve(resources, '../AndroidManifest.xml');
const text = readFileSync(manifest, 'utf8');
if (!text.includes('android:roundIcon=')) {
  writeFileSync(manifest, text.replace('android:icon="@mipmap/ic_launcher"',
    'android:icon="@mipmap/ic_launcher"\n        android:roundIcon="@mipmap/ic_launcher_round"'));
}
console.log('Android launcher icons synchronized with Ting artwork.');
