import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { songKey } from "./model.mjs";
import type { Song, Source } from "./library";
import { readSetting, writeSetting } from "./settings";

/**
 * Files on this device, remembered by path and re-admitted to the asset
 * protocol every launch. Desktop picks files and folders in place; phones keep
 * a copy of what they import in the app's own storage. Songs this app
 * downloaded name the platform track they came from (`origin`), so the online
 * song can play from disk. Playlist and favorite memberships of local files
 * live in a per-machine overlay the iCloud sync never sees, because a path
 * means nothing on another device.
 */
type LocalTrack = {
  id: number;
  path: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  cover: string;
  origin: { source: Source; id: number } | null;
  gain: number | null;
};

const LIBRARY = "ting.locals";
const MEMBERS = "ting.local-members";
/** Files survive a restart only inside the app; a browser preview forgets them. */
export const persistentLocals = isTauri();
/** Downloads join the local shelf on their own unless the user turned it off. */
export const autoImport = () => readSetting("ting.auto-import", "1") === "1";
export const setAutoImport = (on: boolean) =>
  writeSetting("ting.auto-import", on ? "1" : "0");

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

const validOrigin = (o: unknown) => {
  const origin = o as Song["origin"];
  return (
    origin === undefined ||
    (!!origin &&
      ["netease", "qq"].includes(origin.source) &&
      Number.isSafeInteger(origin.id) &&
      origin.id > 0)
  );
};
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
    ) &&
    validOrigin(song.origin)
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
    ...(track.origin ? { origin: track.origin } : {}),
    ...(typeof track.gain === "number" ? { gain: track.gain } : {}),
  };
}

let library: Song[] = read<unknown[]>(LIBRARY, []).filter(validLocal);
// origin key ("netease:186016") -> the file downloaded from that track.
let copies = new Map<string, Song>();
function index() {
  copies = new Map(
    library
      .filter((s) => s.origin && !s.missing)
      .map((s) => [`${s.origin!.source}:${s.origin!.id}`, s]),
  );
}
index();

export function localSongs(): Song[] {
  return library.map(playable);
}

/** Finds a remembered file by key so restored queues can play again. */
export function localByKey(key: string): Song | undefined {
  const song = library.find((s) => songKey(s) === key);
  return song && playable(song);
}

/** The downloaded file of an online song, if one is on this device. */
export function downloadedCopy(song: Song | undefined): Song | undefined {
  if (!song || song.localUrl || song.localPath) return undefined;
  const copy = copies.get(`${song.source || "netease"}:${song.id}`);
  return copy && playable(copy);
}

function saveLibrary() {
  index();
  return write(LIBRARY, library.map(storable));
}

/** Adds new tracks and refreshes known ones; returns only the new songs. */
function merge(tracks: LocalTrack[]): Song[] {
  const added: Song[] = [];
  for (const track of tracks) {
    const song = fromTrack(track);
    const at = library.findIndex((s) => s.id === song.id);
    if (at >= 0) library[at] = song;
    else {
      library.push(song);
      added.push(song);
    }
  }
  if (tracks.length && !saveLibrary())
    throw new Error("本地存储空间不足，本地音乐未保存");
  return added.map(playable);
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
  index();
  return { missing: gone.size };
}

/** Opens the native picker and merges the chosen files into the library. */
export async function importLocals(): Promise<Song[]> {
  return merge(await invoke<LocalTrack[]>("local_import"));
}

/** Picks a folder (remembered for later scans) and adds everything in it. */
export async function importFolder(): Promise<{
  folder?: string;
  added: Song[];
}> {
  const result = await invoke<{ folder: string | null; tracks: LocalTrack[] }>(
    "local_import_folder",
  );
  return { folder: result.folder || undefined, added: merge(result.tracks) };
}

export let localFolders: string[] = [];
export let downloadFolder: string | undefined;
/** New files in remembered folders and, if wanted, the download folder. */
export async function scanLocals(downloads = autoImport()): Promise<Song[]> {
  if (!persistentLocals) return [];
  const scan = await invoke<{
    folders: string[];
    download_folder: string | null;
    tracks: LocalTrack[];
  }>("local_scan", {
    known: library.map((s) => s.localPath),
    downloads,
  });
  localFolders = scan.folders;
  downloadFolder = scan.download_folder || undefined;
  return merge(scan.tracks);
}

/** Stops scanning a folder and takes its files off the shelf. */
export async function forgetFolder(folder: string): Promise<number> {
  localFolders = await invoke<string[]>("local_forget_folder", { folder });
  const inside = (path: string) =>
    path === folder ||
    path.startsWith(
      folder.replace(/[\\/]$/, "") + (folder.includes("\\") ? "\\" : "/"),
    );
  const gone = library.filter((s) => inside(s.localPath!));
  gone.forEach((s) => removeLocal(songKey(s)));
  return gone.length;
}

/** A phone's pick copied into app storage, so it still plays after a restart. */
export async function storeFile(file: File): Promise<Song | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const track = await invoke<LocalTrack>("local_store", bytes, {
    headers: { "x-file-name": encodeURIComponent(file.name) },
  });
  return merge([track])[0] || localByKey(`local:${track.id}`);
}

/** Lyrics for a file on this device: its .lrc or embedded lyrics. */
export async function localLyric(song: Song): Promise<string> {
  if (!song.localPath || !isTauri()) return "";
  try {
    return (
      (await invoke<string | null>("local_lyric", { path: song.localPath })) ||
      ""
    );
  } catch {
    return "";
  }
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
