import type { Song, Source } from "./library";

export const sourceName = (s?: {
  source?: Source;
  localUrl?: string;
  localPath?: string;
}) =>
  s?.localUrl || s?.localPath
    ? "本地"
    : s?.source === "qq"
      ? "QQ音乐"
      : "网易云";
/** Any file on this device, whether remembered by path or only for this session. */
export const localSong = (s?: Song) => !!s && !!(s.localUrl || s.localPath);
/** A session-only import (mobile): gone after restart, so it cannot be organized. */
export const transient = (s?: Song) => !!s && !!s.localUrl && !s.localPath;
