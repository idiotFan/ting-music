import { songKey } from "./model.mjs";
import type { Song, Playlist } from "./library";
export type SavedPlaylist = Playlist & { songs: Song[] };
export type Change = {
  id: number;
  create?: boolean;
  deleted?: boolean;
  name?: string;
  add?: Song[];
  remove?: string[];
  order?: string[];
};
export type Batch = { id: string; changes: Change[] };
// Only playlist metadata crosses the native sync boundary. Never include local
// file handles, account sessions, media URLs, or arbitrary storage properties.
export function syncSong(s: Song): Song {
  return {
    id: s.id,
    source: s.source || "netease",
    ...(s.mid ? { mid: s.mid } : {}),
    name: s.name,
    artist: s.artist,
    album: s.album,
    cover: s.cover,
    duration: s.duration || 0,
    fee: s.fee || 0,
  };
}
export function changes(
  before: SavedPlaylist[],
  after: SavedPlaylist[],
): Change[] {
  const old = new Map(before.map((p) => [p.id, p]));
  const next = new Map(after.map((p) => [p.id, p]));
  const edits: Change[] = [];
  for (const p of before)
    if (!next.has(p.id)) edits.push({ id: p.id, deleted: true });
  for (const p of after) {
    const previous = old.get(p.id);
    const c: Change = { id: p.id };
    if (!previous) c.create = true;
    if (!previous || previous.name !== p.name) c.name = p.name;
    const tracks = new Map((previous?.songs || []).map((s) => [songKey(s), s]));
    const keys = p.songs.map(songKey);
    const present = new Set(keys);
    const add = p.songs.filter((s) => !tracks.has(songKey(s))).map(syncSong);
    const remove = [...tracks.keys()].filter((k) => !present.has(k));
    if (add.length) c.add = add;
    if (remove.length) c.remove = remove;
    if (JSON.stringify(previous?.songs.map(songKey)) !== JSON.stringify(keys))
      c.order = keys;
    if (Object.keys(c).length > 1) edits.push(c);
  }
  return edits;
}
