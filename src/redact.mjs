/** Strips what must never leave the device from a diagnostic line. */
export function redact(text) {
  return String(text)
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, "$1?…")
    .replace(/\basset:\/\/\S+|https?:\/\/asset\.localhost\/\S+/g, "asset://…")
    .replace(/(?:\/Users|\/home)\/[^/\s"']+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, "~")
    .replace(
      /\b(MUSIC_U|__csrf|qqmusic_key|qm_keyst|authst|psrf_\w+|uin|token|key|cookie)(["']?\s*[:=]\s*["']?)([^;&\s"',}]+)/gi,
      "$1$2…",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer …")
    .replace(/[A-Za-z0-9+/_-]{32,}/g, "…")
    .slice(0, 500);
}
