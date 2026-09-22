import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { songKey } from "./model.mjs";
import type { Song } from "./library";
import { mobileDevice } from "./platform";

/**
 * Local files on desktop: chosen through the native dialog, remembered by
 * path, re-admitted to the asset protocol every launch. Their playlist and
 * favorite memberships live in a per-machine overlay that the iCloud sync
 * never sees, because a path means nothing on another device.
 */
type LocalTrack = {
  id: number;
  path: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
};

const LIBRARY = "ting.locals";
const MEMBERS = "ting.local-members";
export const persistentLocals = isTauri() && !mobileDevice;

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const isLocalSong = (s: Song | undefined): boolean =>
  !!s && typeof s.localPath === "string" && s.localPath.length > 0;

/** Validation for anything read back from storage. */
export function validLocal(s: unknown): s is Song {
  const song = s as Song;
  return (
    !!song &&
    typeof song === "object" &&
    Number.isSafeInteger(song.id) &&
    song.id < 0 &&
    typeof song.localPath === "string" &&
    song.localPath.length > 0 &&
    ["name", "artist", "album", "cover"].every(
      (k) => typeof song[k as keyof Song] === "string",
    )
  );
}

/** The playable form of a remembered file for this session. */
export function playable(song: Song): Song {
  if (!isLocalSong(song)) return song;
  return {
    ...song,
    localUrl: song.missing ? undefined : convertFileSrc(song.localPath!),
    cover: song.coverPath ? convertFileSrc(song.coverPath) : "",
  };
}

/** The storable form: no session URLs, only what survives a restart. */
export function storable(song: Song): Song {
  if (!isLocalSong(song)) return song;
  const { localUrl: _url, cover: _cover, missing: _missing, ...rest } = song;
  return { ...rest, cover: "" };
}

function fromTrack(track: LocalTrack): Song {
  return {
    id: track.id,
    name: track.name,
    artist: track.artist,
    album: track.album,
    cover: "",
    duration: track.duration,
    fee: 0,
    localPath: track.path,
    coverPath: track.cover || undefined,
  };
}

let library: Song[] = read<unknown[]>(LIBRARY, []).filter(validLocal);

export function localSongs(): Song[] {
  return library.map(playable);
}

/** Finds a remembered file by key so restored queues can play again. */
export function localByKey(key: string): Song | undefined {
  const song = library.find((s) => songKey(s) === key);
  return song && playable(song);
}

function saveLibrary() {
  return write(LIBRARY, library.map(storable));
}

/** Re-admits every remembered file; flags the ones that are gone. */
export async function restoreLocals(): Promise<{ missing: number }> {
  if (!persistentLocals || !library.length) return { missing: 0 };
  let missing: string[] = [];
  try {
    missing = await invoke<string[]>("local_restore", {
      paths: library.map((s) => s.localPath),
    });
  } catch {
    return { missing: 0 };
  }
  const gone = new Set(missing);
  library = library.map((s) => ({ ...s, missing: gone.has(s.localPath!) }));
  return { missing: gone.size };
}

/** Opens the native picker and merges the chosen files into the library. */
export async function importLocals(): Promise<Song[]> {
  const tracks = await invoke<LocalTrack[]>("local_import");
  const added: Song[] = [];
  for (const track of tracks) {
    const song = fromTrack(track);
    const index = library.findIndex((s) => s.id === song.id);
    if (index >= 0) library[index] = song;
    else {
      library.push(song);
      added.push(song);
    }
  }
  if (tracks.length && !saveLibrary())
    throw new Error("本地存储空间不足，本地音乐未保存");
  return added.map(playable);
}

export function removeLocal(key: string): boolean {
  const before = library.length;
  library = library.filter((s) => songKey(s) !== key);
  if (library.length === before) return false;
  members = Object.fromEntries(
    Object.entries(members).map(([id, songs]) => [
      id,
      songs.filter((s) => songKey(s) !== key),
    ]),
  );
  write(MEMBERS, members);
  return saveLibrary();
}

// Playlist / favorites overlay: playlist id -> local songs, in order.
let members: Record<string, Song[]> = Object.fromEntries(
  Object.entries(read<Record<string, unknown[]>>(MEMBERS, {})).map(
    ([id, songs]) => [id, (songs || []).filter(validLocal)],
  ),
);

export function localMembers(playlistId: number): Song[] {
  return (members[String(playlistId)] || []).map(playable);
}
export function setLocalMembers(playlistId: number, songs: Song[]) {
  const next = songs.filter(isLocalSong).map(storable);
  if (next.length) members[String(playlistId)] = next;
  else delete members[String(playlistId)];
  if (!write(MEMBERS, members))
    throw new Error("本地存储空间不足，歌单修改未保存");
}
export function dropLocalMembers(playlistId: number) {
  if (String(playlistId) in members) {
    delete members[String(playlistId)];
    write(MEMBERS, members);
  }
}
