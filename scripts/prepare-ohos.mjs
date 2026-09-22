// Run after `tauri ohos init` and before every `ohos build`/`dev`. The generated
// project under src-tauri/gen/ohos is ignored by Git, so the versioned ArkTS
// bridge in src-tauri/ohos/entry is copied over it and the manifests are patched.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const gen = resolve('src-tauri/gen/ohos');
if (!existsSync(resolve(gen, 'entry/oh-package.json5'))) {
  console.error('src-tauri/gen/ohos is missing; run `npm run tauri -- ohos init --ci` first.');
  process.exit(1);
}
cpSync(resolve('src-tauri/ohos/entry'), resolve(gen, 'entry'), { recursive: true });

// The bridge module is a second native import next to the template's libentry.
const pkgPath = resolve(gen, 'entry/oh-package.json5');
let pkg = readFileSync(pkgPath, 'utf8');
if (!pkg.includes('libting_music_lib.so')) {
  pkg = pkg.replace(/"dependencies":\s*{/, '"dependencies": {\n    "libting_music_lib.so": "file:./src/main/cpp/types/libting_music_lib",');
}
// Match the @ohos-rs/ability release paired with openharmony-ability 295a276a.
pkg = pkg.replace(/"@ohos-rs\/ability":\s*"[^"]+"/, '"@ohos-rs/ability": "0.4.0-beta.5"');
writeFileSync(pkgPath, pkg);

// Background playback needs the continuous-task permission and the audio mode.
const modulePath = resolve(gen, 'entry/src/main/module.json5');
let module = readFileSync(modulePath, 'utf8');
if (!module.includes('ohos.permission.KEEP_BACKGROUND_RUNNING')) {
  module = module.replace(/"requestPermissions":\s*\[/, '"requestPermissions": [\n      {\n        "name": "ohos.permission.KEEP_BACKGROUND_RUNNING"\n      },');
}
if (!module.includes('"backgroundModes"')) {
  module = module.replace(/"srcEntry":\s*"\.\/ets\/entryability\/EntryAbility\.ets",/, '"srcEntry": "./ets/entryability/EntryAbility.ets",\n        "backgroundModes": [\n          "audioPlayback"\n        ],');
}
writeFileSync(modulePath, module);

// Version fields come from the same sources as the other platforms.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const appPath = resolve(gen, 'AppScope/app.json5');
let app = readFileSync(appPath, 'utf8');
app = app.replace(/"versionName":\s*"[^"]+"/, `"versionName": "${version}"`)
  .replace(/"versionCode":\s*\d+/, `"versionCode": ${version.split('.').map((n) => n.padStart(2, '0')).join('').replace(/^0+/, '')}`);
writeFileSync(appPath, app);
console.log('OpenHarmony project prepared: bridge sources, permissions and version injected.');
