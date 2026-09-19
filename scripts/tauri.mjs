import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const env = { ...process.env };
const androidHelp = process.argv.includes('--help') || process.argv.includes('-h');
function prepareAndroid() {
  const result = spawnSync(process.execPath, ['scripts/prepare-android.mjs'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!androidHelp && process.argv[2] === 'android' && ['dev', 'build'].includes(process.argv[3])) {
  prepareAndroid();
}
if (["dev", "build", "bundle"].includes(process.argv[2]) ||
    (["ios", "android"].includes(process.argv[2]) && ["dev", "build"].includes(process.argv[3]))) {
  const check = spawnSync(process.execPath, ["scripts/preflight.mjs"], { stdio: "inherit" });
  if (check.error) throw check.error;
  if (check.status !== 0) process.exit(check.status ?? 1);
}
const local = resolve("work/toolchain");
if (existsSync(`${local}/cargo/bin/cargo`)) {
  env.CARGO_HOME = `${local}/cargo`;
  env.RUSTUP_HOME = `${local}/rustup`;
  env.PATH = `${local}/cargo/bin${delimiter}${env.PATH}`;
}
// Run the JS entry directly: Windows cannot spawn the extensionless .bin shim.
const child = spawn(process.execPath, [resolve("node_modules/@tauri-apps/cli/tauri.js"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => {
  if (code === 0 && !androidHelp && process.argv[2] === 'android' && process.argv[3] === 'init') prepareAndroid();
  process.exit(code ?? 1);
});
child.on("error", (error) => { console.error(error.message); process.exit(1); });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
