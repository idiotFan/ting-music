import { exportLibrary, importLibrary } from "./library";
import { validLocal } from "./local-library";
import { songKey, uniqueSongs } from "./model.mjs";

/**
 * One file with everything this device keeps for the listener: playlists
 * and favorites, the local shelf and its memberships, recent plays, and
 * preferences. Account sign-ins are not in it — they live in the system
 * keychain and never leave it.
 */
const FORMAT = 1;
/** Preferences restored as they were; device state (queue, window) is not. */
const PREFERENCES = [
  "ting.theme",
  "ting.theme-dark",
  "ting.theme-follow",
  "ting.quality",
  "ting.volume",
  "ting.playbackMode",
  "ting.playlist-filter",
  "ting.normalize",
  "ting.eq",
  "ting.crossfade",
  "ting.auto-import",
  "ting.scale",
  "ting.columns.player",
  "ting.columns.lyrics",
];
type Backup = {
  app: "ting";
  format: number;
  exportedAt: string;
  library: ReturnType<typeof exportLibrary>;
  covers?: Record<string, unknown>;
  locals: unknown[];
  localMembers: Record<string, unknown[]>;
  history: unknown[];
  preferences: Record<string, string>;
};
const readJson = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};

export function createBackup(): Backup {
  const preferences: Record<string, string> = {};
  for (const key of PREFERENCES) {
    const value = localStorage.getItem(key);
    if (value !== null) preferences[key] = value;
  }
  return {
    app: "ting",
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    library: exportLibrary(),
    covers: readJson("ting.playlist-covers", {}),
    locals: readJson("ting.locals", []),
    localMembers: readJson("ting.local-members", {}),
    history: readJson("ting.history", []),
    preferences,
  };
}
export const backupName = () =>
  `ting-backup-${new Date().toISOString().slice(0, 10)}.json`;

/** Merges a backup into this device; returns what changed, for the toast. */
export function restoreBackup(text: string) {
  let data: Backup;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("这不是听 · Ting 的备份文件");
  }
  if (!data || data.app !== "ting" || typeof data.format !== "number")
    throw new Error("这不是听 · Ting 的备份文件");
  if (data.format > FORMAT) throw new Error("备份来自更新的版本，请先更新应用");
  // Everything is checked and prepared before anything is written.
  // Local files: only well-formed audio entries (the app re-admits them to
  // the web view at launch), by id so the same file never appears twice.
  const audio = /\.(mp3|flac|m4a|aac|wav|ogg|opus|aiff?)$/i;
  const isFile = (s: unknown) =>
    validLocal(s) && audio.test((s as { localPath: string }).localPath);
  const locals = readJson<{ id: number }[]>("ting.locals", []);
  const known = new Set(locals.map((s) => s.id));
  const extra = (Array.isArray(data.locals) ? data.locals : []).filter(
    (s) => isFile(s) && !known.has((s as { id: number }).id),
  );
  const members = readJson<Record<string, unknown[]>>("ting.local-members", {});
  for (const [id, songs] of Object.entries(data.localMembers || {}))
    if (/^\d+$/.test(id) && Array.isArray(songs))
      members[id] = uniqueSongs([
        ...(members[id] || []),
        ...songs.filter(isFile),
      ] as never[]);
  const covers = readJson<Record<string, unknown>>("ting.playlist-covers", {});
  for (const [id, cover] of Object.entries(data.covers || {}))
    if (/^\d+$/.test(id) && !(id in covers)) covers[id] = cover;
  const seen = new Set<string>();
  const history = JSON.stringify(
    [
      ...readJson<unknown[]>("ting.history", []),
      ...(Array.isArray(data.history) ? data.history : []),
    ]
      .filter((s) => {
        const key = songKey(s);
        return !!key && !seen.has(key) && !!seen.add(key);
      })
      .slice(0, 200),
  );
  try {
    const library = importLibrary(data.library || {});
    localStorage.setItem("ting.locals", JSON.stringify([...locals, ...extra]));
    localStorage.setItem("ting.local-members", JSON.stringify(members));
    localStorage.setItem("ting.playlist-covers", JSON.stringify(covers));
    localStorage.setItem("ting.history", history);
    for (const [key, value] of Object.entries(data.preferences || {}))
      if (PREFERENCES.includes(key) && typeof value === "string")
        localStorage.setItem(key, value);
    return { ...library, locals: extra.length };
  } catch (e) {
    if (e instanceof DOMException)
      throw new Error(
        "本机存储空间不足，备份只恢复了一部分；请清理后再导入一次",
      );
    throw e;
  }
}
