/**
 * A short, local record of what went wrong recently, for "导出诊断信息".
 * Nothing leaves the device unless the listener exports it; addresses lose
 * their query strings and anything that looks like a token is masked.
 */
import { redact } from "./redact.mjs";

type Entry = { at: string; kind: string; message: string };
const LIMIT = 120;
const entries: Entry[] = [];

export function record(kind: string, message: unknown) {
  entries.push({
    at: new Date().toISOString(),
    kind,
    message: redact(
      message instanceof Error
        ? `${message.name}: ${message.message}`
        : String(message),
    ),
  });
  if (entries.length > LIMIT) entries.shift();
}
export function recent(): Entry[] {
  return [...entries];
}
window.addEventListener("error", (e) => record("error", e.message || e.error));
window.addEventListener("unhandledrejection", (e) =>
  record("rejection", e.reason),
);
