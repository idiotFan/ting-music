import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, delimiter } from "node:path";
const env = { ...process.env },
  local = resolve("work/toolchain");
if (existsSync(`${local}/cargo/bin/cargo`)) {
  env.CARGO_HOME = `${local}/cargo`;
  env.RUSTUP_HOME = `${local}/rustup`;
  env.PATH = `${local}/cargo/bin${delimiter}${env.PATH}`;
}
const child = spawn("cargo", process.argv.slice(2), { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (error) => { console.error(error.message); process.exit(1); });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
