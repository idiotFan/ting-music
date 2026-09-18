// Run after `tauri ios init`. Keep developer identity outside version control.
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const team = process.env.TAURI_APPLE_DEVELOPMENT_TEAM;
if (!/^[A-Z0-9]{10}$/.test(team || '')) throw new Error('Set TAURI_APPLE_DEVELOPMENT_TEAM to your Apple development team ID.');
const project = resolve('src-tauri/gen/apple/project.yml');
let text = readFileSync(project, 'utf8');
text = text.replace(/iOS: [\d.]+/, 'iOS: 16.0');
text = text.replace(/^\s*(?:DEVELOPMENT_TEAM|CODE_SIGN_STYLE):.*\n/gm, '');
text = text.replace(/(PRODUCT_BUNDLE_IDENTIFIER:.*)/, `$1\n      DEVELOPMENT_TEAM: ${team}\n      CODE_SIGN_STYLE: Automatic`);
text = text.replace(/^\s*CODE_SIGN_STYLE: Automatic\n(?=\s*CODE_SIGN_STYLE: Automatic)/gm, '');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const buildNumber = JSON.parse(readFileSync('src-tauri/tauri.ios.conf.json', 'utf8')).bundle.iOS.bundleVersion || version;
text = text.replace(/CFBundleShortVersionString: .*/, `CFBundleShortVersionString: ${version}`).replace(/CFBundleVersion: .*/, `CFBundleVersion: "${buildNumber}"`);
text = text.replace(/script: .*? ios xcode-script/, 'script: node "$SRCROOT/../../../scripts/tauri.mjs" ios xcode-script');
// Existing generated projects also need the frameworks added after an upgrade.
for (const framework of ['MediaPlayer', 'AVFoundation']) {
  if (!text.includes(`sdk: ${framework}.framework`))
    text = text.replace('      - sdk: UIKit.framework', `      - sdk: ${framework}.framework\n      - sdk: UIKit.framework`);
}
writeFileSync(project, text);
const result = spawnSync('xcodegen', ['generate', '--spec', project], {stdio: 'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);

// `ios init` supplies Tauri's default icon; use Ting's existing artwork instead.
const iconDir = mkdtempSync(resolve(tmpdir(), 'ting-icons-'));
try {
  const generated = spawnSync(process.execPath, ['scripts/tauri.mjs', 'icon', 'src-tauri/app-icon.svg', '--output', iconDir, '--ios-color', '#a6ed55'], { stdio: 'inherit' });
  if (generated.status !== 0) throw new Error('Failed to generate iOS icons.');
  const assets = resolve('src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset');
  const manifest = JSON.parse(readFileSync(resolve(assets, 'Contents.json'), 'utf8'));
  for (const { filename } of manifest.images) {
    if (filename) copyFileSync(resolve(iconDir, 'ios', filename), resolve(assets, filename));
  }
} finally {
  rmSync(iconDir, { recursive: true, force: true });
}
