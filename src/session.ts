import type { AlbumRef, ArtistRef } from "./catalog";
import type { Playlist, Song } from "./library";
import { localByKey, persistentLocals, validLocal } from "./local-library";
import { songKey } from "./model.mjs";
import type { View } from "./views";

export function restoreSongs(data: unknown): Song[] {
  if (!Array.isArray(data)) return [];
  const online = data.filter(
    (s) =>
      s &&
      !s.localUrl &&
      !s.localPath &&
      (!s.source || ["netease", "qq"].includes(s.source)) &&
      Number.isSafeInteger(s.id) &&
      s.id > 0 &&
      typeof s.name === "string" &&
      typeof s.artist === "string" &&
      typeof s.album === "string" &&
      typeof s.cover === "string",
  );
  if (!persistentLocals) return online;
  // Remembered files come back through the library so a moved or deleted
  // file is flagged rather than played from a stale address.
  return data.flatMap((s) => {
    if (!validLocal(s)) return online.includes(s) ? [s] : [];
    const fresh = localByKey(songKey(s));
    return fresh ? [fresh] : [];
  });
}
export function restore(key: string): Song[] {
  try {
    return restoreSongs(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return [];
  }
}
/** What was on screen when the app last closed: the track, its position, and
 *  the list being browsed. Read once at startup, before any view renders. */
export type Session = {
  song?: Song;
  position?: number;
  view?: View;
  playlist?: Playlist;
  artist?: ArtistRef;
  album?: AlbumRef;
};
export const validRef = (r: unknown): r is ArtistRef & AlbumRef => {
  const ref = r as ArtistRef;
  return (
    !!ref &&
    typeof ref === "object" &&
    ["netease", "qq", "local"].includes(ref.source) &&
    Number.isSafeInteger(ref.id) &&
    typeof ref.name === "string" &&
    !!ref.name &&
    (ref.mid === undefined || typeof ref.mid === "string")
  );
};
export function readSession(): Session {
  try {
    const data = JSON.parse(localStorage.getItem("ting.session") || "{}");
    if (!data || typeof data !== "object") return {};
    const song = restoreSongs([data.song])[0];
    const playlist = data.playlist;
    const validPlaylist =
      playlist &&
      typeof playlist === "object" &&
      Number.isSafeInteger(playlist.id) &&
      typeof playlist.name === "string" &&
      (!playlist.source || ["netease", "qq"].includes(playlist.source));
    return {
      song,
      position:
        typeof data.position === "number" && data.position >= 0
          ? data.position
          : 0,
      view: [
        "favorites",
        "playlists",
        "playlist",
        "queue",
        "local",
        "artist",
        "album",
      ].includes(data.view)
        ? data.view
        : undefined,
      playlist: validPlaylist ? (playlist as Playlist) : undefined,
      artist: validRef(data.artist) ? data.artist : undefined,
      album: validRef(data.album) ? data.album : undefined,
    };
  } catch {
    return {};
  }
}
