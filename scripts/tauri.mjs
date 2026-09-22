import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
// Signed updater packages are only produced when the private key is present,
// so forks and pull requests without the secret still build a normal app.
const args = process.argv.slice(2);
// `bundle` repackages an existing build and must sign exactly like `build`.
if (["build", "bundle"].includes(args[0])) {
  // The CLI signs with TAURI_SIGNING_PRIVATE_KEY only; accept a key file too.
  const keyFile = env.TAURI_SIGNING_PRIVATE_KEY_PATH || resolve(homedir(), ".tauri/ting-music-updater.key");
  if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(keyFile)) {
    // A blank key file is a broken key, not a missing one: failing loudly keeps
    // it from silently producing an unsigned package.
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
    if (!env.TAURI_SIGNING_PRIVATE_KEY) throw new Error(`Updater signing key file is empty: ${keyFile}`);
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
    args.splice(1, 0, "--config", "src-tauri/tauri.updater.conf.json");
  }
}
// Run the JS entry directly: Windows cannot spawn the extensionless .bin shim.
const child = spawn(process.execPath, [resolve("node_modules/@tauri-apps/cli/tauri.js"), ...args], {
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
