export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
export function parseLyrics(text) {
  const result = [];
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  for (const line of text.split("\n")) {
    const content = line.replace(/\[[^\]]*\]/g, "").trim();
    if (!content) continue;
    for (const match of line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g))
      result.push({
        time: Math.max(0, Number(match[1]) * 60 + Number(match[2]) + offset),
        text: content,
      });
  }
  return result.sort((a, b) => a.time - b.time);
}
export function lyricIndex(lines, time) {
  let index = -1;
  for (let i = 0; i < lines.length && lines[i].time <= time; i++) index = i;
  return index;
}
export function songKey(song) {
  return song
    ? `${song.localUrl ? "local" : song.source || "netease"}:${song.id}`
    : "";
}
export function uniqueSongs(songs) {
  return [...new Map(songs.map((s) => [songKey(s), s])).values()];
}

/** Fisher–Yates shuffle; exclude the playing track so a cycle cannot repeat it. */
export function shuffledIds(ids, currentId, random = Math.random) {
  const bag = [...new Set(ids)].filter((id) => id !== currentId);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}
