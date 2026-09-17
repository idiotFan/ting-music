import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/cargo.mjs', 'fetch', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'], {stdio: 'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Rust dependencies ready. Ting needs no Python runtime or wheels.');
