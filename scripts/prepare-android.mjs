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

// Keep native code in version control; gen/android is intentionally disposable.
cpSync(resolve(root, 'src-tauri/android/main'),
  resolve(resources, '../java/com/ting/music/demo'), { recursive: true });
cpSync(resolve(root, 'src-tauri/android/test'),
  resolve(resources, '../../androidTest/java/com/ting/music/demo'), { recursive: true });
cpSync(resolve(root, 'src-tauri/android/test-assets'),
  resolve(resources, '../../androidTest/assets'), { recursive: true });
const appGradle = resolve(root, 'src-tauri/gen/android/app/build.gradle.kts');
let gradle = readFileSync(appGradle, 'utf8');
if (!gradle.includes('testInstrumentationRunner =')) {
  gradle = gradle.replace('defaultConfig {',
    'defaultConfig {\n        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"');
  writeFileSync(appGradle, gradle);
}
writeFileSync(resolve(root, 'src-tauri/gen/android/app/ting-credentials.pro'),
  '-keep class com.ting.music.demo.CredentialPlugin { *; }\n' +
  '-keep class com.ting.music.demo.CredentialArgs { *; }\n' +
  '-keep class com.ting.music.demo.PlatformPlugin { *; }\n');
cpSync(resolve(root, 'src-tauri/android/res'), resources, { recursive: true });
let nativeManifest = readFileSync(manifest, 'utf8');
// This is a touch phone/tablet app; the template's TV launcher claim is invalid.
nativeManifest = nativeManifest
  .replace(/\s*<!-- AndroidTV support -->\s*/g, '\n    ')
  .replace(/\s*<uses-feature android:name="android.software.leanback"[^>]*\/>/g, '')
  .replace(/\s*<!-- AndroidTV support -->/g, '')
  .replace(/\s*<category android:name="android.intent.category.LEANBACK_LAUNCHER"\s*\/>/g, '');
if (!nativeManifest.includes('android.permission.FOREGROUND_SERVICE"')) {
  nativeManifest = nativeManifest.replace('<application',
    '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n' +
    '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />\n\n    <application');
}
if (!nativeManifest.includes('.TingPlaybackService')) {
  nativeManifest = nativeManifest.replace('</application>',
    '<service android:name=".TingPlaybackService" android:exported="false" android:foregroundServiceType="mediaPlayback" />\n' +
    '        <receiver android:name=".TingMediaReceiver" android:exported="false" />\n    </application>');
}
writeFileSync(manifest, nativeManifest);
