import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const env = { ...process.env };
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
const child = spawn(resolve("node_modules/.bin/tauri"), process.argv.slice(2), {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
