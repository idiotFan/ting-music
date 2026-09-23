/** Strips what must never leave the device from a diagnostic line. */
export function redact(text) {
  return String(text)
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, "$1?…")
    .replace(
      /\b(MUSIC_U|__csrf|qqmusic_key|qm_keyst|uin|token|key|cookie)=([^;&\s]+)/gi,
      "$1=…",
    )
    .replace(/[A-Za-z0-9+/_-]{32,}/g, "…")
    .slice(0, 500);
}
