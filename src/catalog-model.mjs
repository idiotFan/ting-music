// Pure helpers behind search results and artist / album pages. Kept free of
// the DOM so node --test covers them (tests/catalog-model.test.mjs).

/** Case-, width- and punctuation-insensitive form used for matching names. */
export function normalizeName(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·・.,，。!！?？'"“”‘’()（）[\]【】\-_/&＆+]+/g, "");
}

/** The artists a song credits, each with whatever id its platform gave. */
export function songArtists(song) {
  if (Array.isArray(song?.artists) && song.artists.length)
    return song.artists
      .filter((a) => a && typeof a.name === "string" && a.name)
      .map((a) => ({
        id: Number.isSafeInteger(a.id) ? a.id : 0,
        mid: typeof a.mid === "string" ? a.mid : "",
        name: a.name,
      }));
  return String(song?.artist || "")
    .split(/\s*\/\s*/)
    .filter(Boolean)
    .map((name) => ({ id: 0, mid: "", name }));
}

/** Same recording across platforms: title and full artist set agree. */
export function recordingKey(song) {
  const artists = songArtists(song)
    .map((a) => normalizeName(a.name))
    .sort()
    .join("+");
  return `${normalizeName(song?.name)}|${artists}`;
}

/**
 * Interleaves two platforms' result pages and drops the second platform's
 * copy of a recording both carry, so "both platforms" reads as one list.
 * `seen` carries keys across pages so page two cannot repeat page one.
 */
export function mergeResults(first, second, seen = new Set()) {
  const preferred = new Set(first.map(recordingKey));
  const merged = [];
  const length = Math.max(first.length, second.length);
  for (let i = 0; i < length; i++)
    for (const [song, primary] of [
      [first[i], true],
      [second[i], false],
    ]) {
      if (!song) continue;
      const key = recordingKey(song);
      if (seen.has(key) || (!primary && preferred.has(key))) continue;
      seen.add(key);
      merged.push(song);
    }
  return merged;
}

/** Splits text into plain and matched runs for every whitespace term. */
export function highlightRuns(text, query) {
  const value = String(text || "");
  const terms = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!terms.length || !value) return [{ text: value, match: false }];
  const lower = value.toLowerCase();
  const marks = new Array(value.length).fill(false);
  for (const term of terms) {
    let from = 0;
    while (from <= lower.length - term.length) {
      const at = lower.indexOf(term, from);
      if (at < 0) break;
      for (let i = at; i < at + term.length; i++) marks[i] = true;
      from = at + term.length;
    }
  }
  const runs = [];
  for (let i = 0; i < value.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.match === marks[i]) last.text += value[i];
    else runs.push({ text: value[i], match: marks[i] });
  }
  return runs;
}

/** Whether a search term names this artist rather than merely mentioning it. */
export function namesArtist(query, artist) {
  const q = normalizeName(query);
  const names = [artist?.name, artist?.alias]
    .map(normalizeName)
    .filter(Boolean);
  return names.some((name) => name === q || (name.length >= 2 && q === name));
}

export const SORTS = ["default", "name", "artist", "album", "short", "long"];

/** Filters by title / artist / album and applies one of SORTS; stable. */
export function arrange(songs, filter = "", sort = "default") {
  const terms = normalizeName(filter)
    ? String(filter).trim().toLowerCase().split(/\s+/)
    : [];
  let out = terms.length
    ? songs.filter((s) => {
        const hay = `${s.name} ${s.artist} ${s.album}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
    : [...songs];
  const text = (key) => (a, b) =>
    String(a[key] || "").localeCompare(String(b[key] || ""), "zh-Hans-CN");
  const compare = {
    name: text("name"),
    artist: text("artist"),
    album: text("album"),
    short: (a, b) => (a.duration || Infinity) - (b.duration || Infinity),
    long: (a, b) => (b.duration || 0) - (a.duration || 0),
  }[sort];
  if (compare)
    out = out
      .map((song, index) => ({ song, index }))
      .sort((a, b) => compare(a.song, b.song) || a.index - b.index)
      .map((x) => x.song);
  return out;
}

/** Local shelf grouped by album, for the local artist page. */
export function albumsOf(songs) {
  const groups = new Map();
  for (const song of songs) {
    const key = normalizeName(song.album) || "—";
    const group = groups.get(key);
    if (group) group.songs.push(song);
    else
      groups.set(key, {
        name: song.album || "未知专辑",
        cover: song.cover || "",
        songs: [song],
      });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    cover: g.cover || g.songs.find((s) => s.cover)?.cover || "",
  }));
}

/** "2003-07-31" style label for a millisecond timestamp; "" when unknown. */
export function releaseDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
