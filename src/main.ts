import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  autoImport,
  downloadedCopy,
  importFolder,
  localLyric,
  scanLocals,
  storeFile,
  importLocals,
  localByKey,
  localSongs,
  persistentLocals,
  restoreLocals,
  storable,
  validLocal,
} from "./local-library";
import { $, icon } from "./dom";
import { setupDownloads, type DownloadResult } from "./downloads";
import { setupSound } from "./sound";
import { setupSoundPanel } from "./sound-panel";
import { setupSettingsPanel } from "./settings-panel";
import { backupName, createBackup, restoreBackup } from "./backup";
import {
  record as recordDiagnostic,
  recent as recentDiagnostics,
} from "./diagnostics";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { LyricLine, PlayerCommand, PlayerState } from "./panel-state";
import {
  chooseAccount,
  openAccount,
  profile,
  renderAccount,
  restoreAccounts,
  setupAccount,
  signedInSources,
} from "./account";
import {
  albumHeader,
  albumLink,
  albumRef,
  artistHeader,
  artistLinks,
  artistRefs,
  bestMatchMarkup,
  cardMarkup,
  hl,
  loadAlbum,
  loadArtist,
  loadArtistAlbums,
  qualityBadge,
  search as searchCatalogPage,
  type Album,
  type AlbumPage,
  type AlbumRef,
  type ArtistPage,
  type ArtistRef,
  type Card,
  type CatalogKind,
} from "./catalog";
import {
  albumsOf,
  arrange,
  mergeResults,
  namesArtist,
  normalizeName,
  songArtists,
} from "./catalog-model.mjs";
import {
  formatTime,
  parseLyrics,
  lyricIndex,
  uniqueSongs,
  songKey,
} from "./model.mjs";
import "./style.css";
import { readSetting, writeSetting } from "./settings";
import { PlaybackQueue } from "./playback-queue.mjs";
import { setupThemes } from "./themes";
import { setupUpdater } from "./updater";
import { setupLyrics } from "./lyrics";
import { setupColumns } from "./columns";
import { setupMobileViewport } from "./mobile-viewport";
import { setupBackGesture } from "./back-gesture";
import { setupPageScale } from "./page-scale";
import {
  MOTION,
  animateArrival,
  animateContent,
  openDialog,
  closeDialog,
} from "./motion";
import { createCover } from "./cover";
import { setupPlaybackState } from "./playback-state";
import { setupSync } from "./sync";
import { systemMediaBackend } from "./system-media";
import { createMediaSession } from "./media-session.mjs";
import { fallbackArtwork, loadMediaArtwork } from "./media-artwork";
import {
  platform,
  mobileDevice,
  credentialNotice,
  loginInstructions,
  downloadLocation,
} from "./platform";

import {
  setupLibrary,
  favoriteSongs,
  setFavoriteSongs,
  copyToInternal,
  playlistArt,
  internalPlaylists,
  internalSongs,
  playlistKey,
  playlistLabel,
  localOrder,
  applyOrder,
  rememberPlaylist,
  recentPlaylists,
  sortPlaylists,
  esc,
  type Source,
  type Song,
  type Playlist,
} from "./library";
const sourceName = (s?: {
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
const localSong = (s?: Song) => !!s && !!(s.localUrl || s.localPath);
/** A session-only import (mobile): gone after restart, so it cannot be organized. */
const transient = (s?: Song) => !!s && !!s.localUrl && !s.localPath;
type Playback = {
  url: string;
  trial: boolean;
  trialStart: number;
  bitrate: number;
  level: string;
  requestedLevel: string;
  format: string;
};
type View =
  | "discover"
  | "favorites"
  | "local"
  | "queue"
  | "playlists"
  | "playlist"
  | "artist"
  | "album";
/** Pages one layer below the nav: entered by pushing, left through goBack. */
const DETAIL_VIEWS: View[] = ["playlist", "artist", "album"];
const isDetail = (v: View) => DETAIL_VIEWS.includes(v);
// The nav renders these in order, so a tap that moves right must bring its
// content in from the right. A playlist detail is one layer deeper instead.
const NAV_ORDER: View[] = [
  "discover",
  "playlists",
  "favorites",
  "local",
  "queue",
];
type Move = { direction: -1 | 1; distance: number; duration: number };
function viewMove(previous: View, next: View, back = false): Move {
  if (back && isDetail(previous))
    return { direction: -1, distance: MOTION.dPush, duration: MOTION.t3 };
  if (isDetail(next))
    return { direction: 1, distance: MOTION.dPush, duration: MOTION.t4 };
  if (isDetail(previous))
    return { direction: -1, distance: MOTION.dPush, duration: MOTION.t3 };
  const from = NAV_ORDER.indexOf(previous),
    to = NAV_ORDER.indexOf(next);
  return {
    direction: from < 0 || to < 0 || to >= from ? 1 : -1,
    distance: MOTION.dLateral,
    duration: MOTION.t3,
  };
}
type PlaylistFilter = "recent" | Source | "internal";
let playlistFilter = (readSetting("ting.playlist-filter") ||
  "netease") as PlaylistFilter;
if (!["recent", "netease", "qq", "internal"].includes(playlistFilter))
  playlistFilter = "netease";
type SearchSource = Source | "all";
let searchSource: SearchSource = "netease";
let qqPlaylistsOffset = 0,
  qqPlaylistsMore = false,
  neteasePlaylistsMore = false;
let playlists: Playlist[] = [],
  playlistSongs: Song[] = [],
  selectedPlaylist: Playlist | undefined;
let playlistsOffset = 0,
  playlistOffset = 0,
  playlistTotal = 0,
  librarySerial = 0,
  libraryBusy = false;
const qualityNames: Record<string, string> = {
  standard: "标准",
  exhigh: "高品质",
  lossless: "无损",
  best: "最高可用",
};
const actualQualityNames: Record<string, string> = {
  ...qualityNames,
  higher: "较高",
  hires: "Hi-Res",
  jymaster: "超清母带",
  master: "臻品母带",
  jyeffect: "高清环绕",
  sky: "沉浸环绕",
};
let quality = readSetting("ting.quality") || "standard";
if (["hires", "jymaster", "jyeffect", "sky"].includes(quality))
  quality = "best";
if (quality === "higher") quality = "exhigh";
if (!qualityNames[quality]) quality = "standard";
async function cloud<T>(
  command: string,
  args: Record<string, unknown> = {},
  source: Source = "netease",
): Promise<T> {
  if (source === "qq")
    return invoke<T>("qq_request", { operation: command, args });
  const request = { ...args };
  if (command === "song_url" && request.level === "best") {
    let trial: T | undefined, lastError: unknown;
    for (const level of [
      "jymaster",
      "hires",
      "lossless",
      "exhigh",
      "standard",
    ]) {
      try {
        const result = await invoke<Playback>(command, { ...request, level });
        if (!result.trial) return result as T;
        trial = result as T;
      } catch (e) {
        lastError = e;
      }
    }
    if (trial) return trial;
    throw lastError || new Error("没有可用音源");
  }
  return invoke<T>(command, request);
}
let pendingSeek: number | null = null,
  resumeAfterLoad = true;

function restoreSongs(data: unknown): Song[] {
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
function restore(key: string): Song[] {
  try {
    return restoreSongs(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return [];
  }
}
let favorites = favoriteSongs(),
  locals: Song[] = localSongs(),
  results: Song[] = [];
const playbackQueue = new PlaybackQueue(restore("ting.queue"));
/** What was on screen when the app last closed: the track, its position, and
 *  the list being browsed. Read once at startup, before any view renders. */
type Session = {
  song?: Song;
  position?: number;
  view?: View;
  playlist?: Playlist;
  artist?: ArtistRef;
  album?: AlbumRef;
};
const validRef = (r: unknown): r is ArtistRef & AlbumRef => {
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
function readSession(): Session {
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
const startupSession = readSession();
let session: Session = { ...startupSession };
let sessionTimer = 0;
function saveSession(patch: Partial<Session>) {
  session = { ...session, ...patch };
  try {
    localStorage.setItem("ting.session", JSON.stringify(session));
  } catch {}
}
// The position is worth remembering to the second, not to the frame.
function savePosition() {
  if (!current || transient(current)) return;
  saveSession({ position: Math.floor(audio.currentTime) });
}
/** Where playback resumes from after a cold start, until the first play. */
let resumePosition: number | undefined;
let view: View = "discover",
  current: Song | undefined,
  selectedSongId: string | undefined,
  query = "ChiliChill",
  offset = 0,
  total = 0,
  busy = false,
  searchSerial = 0,
  playSerial = 0,
  playbackMode: "sequence" | "shuffle" | "repeat" =
    (readSetting("ting.playbackMode") as "sequence" | "shuffle" | "repeat") ||
    "sequence";
if (!["sequence", "shuffle", "repeat"].includes(playbackMode))
  playbackMode = "sequence";
/** An artist page: its songs arrive first, albums only when that tab opens. */
type ArtistState = {
  ref: ArtistRef;
  page?: ArtistPage;
  tab: "songs" | "albums" | "similar";
  albums: Album[];
  albumTotal: number;
  albumMore: boolean;
  albumsLoaded: boolean;
};
type AlbumState = { ref: AlbumRef; page?: AlbumPage };
let artistState: ArtistState | undefined, albumState: AlbumState | undefined;
/** Everything needed to show a page again exactly as it was left. */
type Crumb = {
  view: View;
  scroll: number;
  playlist?: Playlist;
  playlistSongs?: Song[];
  playlistOffset?: number;
  playlistTotal?: number;
  artist?: ArtistState;
  album?: AlbumState;
};
let backStack: Crumb[] = [],
  navigatingBack = false;
type SearchKind = "song" | CatalogKind;
let searchKind: SearchKind = "song",
  // Per-platform paging so "both platforms" can page each side independently.
  searchOffsets: Record<Source, number> = { netease: 0, qq: 0 },
  searchTotals: Record<Source, number> = { netease: 0, qq: 0 },
  mergeSeen = new Set<string>(),
  catalogResults: Card[] = [],
  bestMatch: Card | undefined;
/** The cards #catalog-grid shows right now; data-card indexes into it. */
let gridCards: Card[] = [];
/** The local shelf browsed as songs, or grouped by artist or album. */
let localTab: "songs" | "artists" | "albums" = "songs";
/** Multi-selection: which rows are ticked, and where a Shift-range starts. */
let selecting = false,
  selectionAnchor = "";
const selection = new Set<string>();
/** The queue page shows the queue itself or what was played recently. */
let queueTab: "queue" | "history" = "queue";
const HISTORY_KEY = "ting.history";
let playHistory: Song[] = (() => {
  try {
    return restoreSongs(JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"));
  } catch {
    return [];
  }
})();
let historySerial = -1;
/** The song that just started, first in the history; 200 kept. */
function recordHistory(song: Song) {
  if (transient(song)) return;
  playHistory = [
    storable(song),
    ...playHistory.filter((s) => songKey(s) !== songKey(song)),
  ].slice(0, 200);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(playHistory));
  } catch {
    /* History is a convenience; a full disk must not stop playback. */
  }
  if (view === "queue" && queueTab === "history") renderSongs();
}
const historyMode = () => view === "queue" && queueTab === "history";
/** In-list filter and sort; the filter is per visit, the sort per view. */
let listFilter = "";
const listSorts = new Map<View, string>();
let queueFillSerial = 0,
  queueExpected = 0,
  playlistEditVersion = 0;
let playlistToRemember:
  { item: Playlist; serial: number; account: string } | undefined;
let lyrics: { time: number; text: string }[] = [],
  activeLine = -1,
  trialStart = 0;
// Which way the queue moved into the current track: forwards, back, or a jump
// picked from a list, which has no direction at all.
let trackDirection: -1 | 0 | 1 = 0;
const audio = new Audio();
audio.preload = "metadata";
// Volume, loudness, fades and the equaliser all meet in one place.
const sound = setupSound(audio, !mobileDevice);
sound.setTrackGain(undefined);
/** The next song's stream, fetched ahead so the change of song has no gap. */
let prefetched:
  { key: string; level: string; data: Playback; at: number } | undefined;
let prefetchKey = "",
  crossfading = false;
const warm = new Audio();
warm.preload = "auto";
warm.muted = true;
// The transport button stays optimistic; this is the fact behind it, taken
// from the media events alone and published on body[data-playback].
const playback = setupPlaybackState(
  audio,
  () => !!current,
  () => preparingPlayback,
);
const mediaBackend = await systemMediaBackend();
const systemMedia = createMediaSession(audio, {
  ...mediaBackend,
  fallbackArtwork: fallbackArtwork(),
  loadArtwork: loadMediaArtwork,
  play: () => {
    resumeAfterLoad = true;
    if (!preparingPlayback) void audio.play().catch(() => {});
    else updateTransport();
  },
  pause: () => {
    resumeAfterLoad = false;
    audio.pause();
    if (preparingPlayback) updateTransport();
  },
  previous: () =>
    skip(-1, false, preparingPlayback ? resumeAfterLoad : !audio.paused),
  next: () =>
    skip(1, false, preparingPlayback ? resumeAfterLoad : !audio.paused),
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) systemMedia.refresh();
});
function save() {
  try {
    localStorage.setItem(
      "ting.queue",
      JSON.stringify(
        playbackQueue.songs.filter((s) => !transient(s)).map(storable),
      ),
    );
  } catch {
    toast("本地存储空间不足，本次列表未保存");
  }
}
/** Sliders draw their own fill (see style.css); keep --fill in step with value. */
function paintRange(input: HTMLInputElement) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty(
    "--fill",
    `${Math.min(Math.max(ratio, 0), 1) * 100}%`,
  );
}
function toast(message: string) {
  recordDiagnostic("toast", message);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => $("#toast").classList.remove("visible"),
    4500,
  );
}
let toastTimer = 0;
if (mobileDevice) document.documentElement.classList.add("mobile-device");
// Phones scale with the system text size; the keys only matter on desktop.
setupPageScale(!mobileDevice);
setupMobileViewport(mobileDevice);
if (isTauri() && platform.mac)
  document.documentElement.classList.add("mac-window");
$("#app").innerHTML = `
<header class="app-header" data-tauri-drag-region><button type="button" class="brand" aria-label="听 首页"><span class="brand-mark">听</span><strong>Ting</strong></button><span class="app-caption" data-tauri-drag-region>音乐，简单一点。</span><button id="sync-button" class="icon-button" aria-label="iCloud 歌单同步" title="iCloud 歌单同步">${icon("Cloud")}</button><button id="downloads-button" class="icon-button downloads-button" aria-label="下载队列" title="下载队列" hidden>${icon("Download")}<span class="downloads-count"></span></button><button id="theme-button" class="icon-button" aria-label="切换主题" title="主题配色">${icon("Palette")}</button><button id="settings-button" class="icon-button" aria-label="设置" title="设置">${icon("Settings")}</button><button id="account-button" class="account-button" aria-label="登录网易云"><span class="avatar">听</span><span id="account-name">登录</span></button></header>
<section class="now-panel" aria-label="正在播放"><div class="now-card"><div id="now-cover" class="now-cover"><span class="fallback-cover">${icon("Music2")}</span></div><div class="now-heading"><span class="now-eq" aria-hidden="true"><i></i><i></i><i></i></span><h3 id="now-name">选一首喜欢的歌</h3><p id="now-artist">搜索音乐，或打开你的歌单</p><div class="track-tag" id="track-tag">等待播放</div></div><button id="download-current" class="icon-button" aria-label="下载当前歌曲最高可用音质" title="下载当前歌曲最高可用音质" disabled>${icon("Download")}</button><button id="now-fav" class="icon-button" aria-label="收藏当前歌曲" disabled>${icon("Heart")}</button></div></section>
<section class="player" aria-label="播放控制"><div class="transport"><div class="timeline"><span id="elapsed">0:00</span><input id="seek" aria-label="播放进度" type="range" min="0" max="100" value="0" step="0.1" disabled/><span id="duration">0:00</span></div><div class="transport-buttons"><button id="repeat" class="icon-button mode-button" aria-label="播放模式：顺序播放" title="切换播放模式">${icon("ListOrdered")}</button><button id="previous" class="icon-button" aria-label="上一首">${icon("SkipBack")}</button><button id="toggle" class="play-toggle" aria-label="播放">${icon("Play")}</button><button id="next" class="icon-button" aria-label="下一首">${icon("SkipForward")}</button><button id="lyrics-toggle" class="icon-button lyrics-toggle" aria-label="显示歌词" aria-expanded="false" aria-controls="lyrics-panel">词</button></div></div><div class="player-options"><div class="volume"><button id="mute" class="icon-button" aria-label="静音">${icon("Volume2")}</button><input id="volume" aria-label="音量" type="range" min="0" max="1" value="0.7" step="0.01"/></div><span id="mode-label">顺序播放</span><button id="sound-button" class="icon-button" aria-label="音效与睡眠定时" title="音效与睡眠定时">${icon("SlidersHorizontal")}</button><select id="quality" aria-label="播放音质">${Object.entries(
  qualityNames,
)
  .map(([value, label]) => `<option value="${value}">${label}</option>`)
  .join(
    "",
  )}</select></div><div id="download-info" hidden><span id="download-status" role="status"></span><button id="download-folder" class="quiet">打开文件夹</button></div></section>
<nav aria-label="音乐导航"><button data-view="discover" class="active">搜索</button><button data-view="playlists">歌单</button><button data-view="favorites">收藏<span id="fav-count">0</span></button><button data-view="local">本地</button><button data-view="queue">队列<span id="queue-count">0</span></button></nav>
<main><div class="topbar"><form id="search-form" role="search"><label class="sr-only" for="search">搜索歌曲或歌手</label>${icon("Search")}<input id="search" placeholder="搜索歌曲、歌手…" maxlength="100" autocomplete="off"/><select id="search-source" aria-label="搜索平台"><option value="netease">网易云</option><option value="qq">QQ音乐</option><option value="all">两个平台</option></select><button class="search-submit" aria-label="搜索" type="submit">搜索</button></form><button id="import-top" class="quiet" hidden>${icon("Plus")}导入</button><button id="import-folder" class="quiet" hidden title="导入整个文件夹，以后启动自动发现新歌">${icon("FolderOpen")}文件夹</button></div><div class="main-scroll"><section class="library"><div class="section-top"><button id="back-button" class="quiet" aria-label="返回歌单列表" hidden>${icon("ChevronLeft")}歌单</button><h2 id="section-title">搜索结果<span id="result-count"></span></h2><button id="refresh-playlists" class="quiet" hidden>刷新</button><button id="new-playlist" class="outline" hidden>＋ 新建</button><button id="manage-playlist" class="quiet" hidden>管理</button><button id="copy-playlist" class="quiet" hidden title="复制为本机歌单，之后可自由增删">${icon("Copy")}复制</button><button id="select-mode" class="quiet" hidden aria-pressed="false">${icon("ListChecks")}选择</button><button id="clear-list" class="quiet" hidden>${icon("Trash2")}清空</button><button id="download-all" class="quiet" hidden title="下载这里的全部歌曲">${icon("Download")}下载</button><button id="enqueue-all" class="quiet" hidden>${icon("ListPlus")}加入队列</button><button id="play-all" class="outline">${icon("Play")}播放全部</button></div><div id="discover-tools"><div id="search-kinds" class="segmented" role="tablist" aria-label="搜索类型">${[
  ["song", "单曲"],
  ["artist", "歌手"],
  ["album", "专辑"],
  ["playlist", "歌单"],
]
  .map(
    ([value, label]) =>
      `<button role="tab" data-search-kind="${value}" aria-selected="${value === "song"}">${label}</button>`,
  )
  .join(
    "",
  )}</div><p id="search-summary" class="summary"></p><div id="best-match-slot"></div></div><div id="queue-tabs" class="segmented" role="tablist" aria-label="队列与播放历史" hidden><button role="tab" data-queue-tab="queue" aria-selected="true">播放队列</button><button role="tab" data-queue-tab="history" aria-selected="false">最近播放</button></div><div id="local-tabs" class="segmented" role="tablist" aria-label="本地音乐浏览方式" hidden>${[
  ["songs", "歌曲"],
  ["artists", "歌手"],
  ["albums", "专辑"],
]
  .map(
    ([value, label]) =>
      `<button role="tab" data-local-tab="${value}" aria-selected="${value === "songs"}">${label}</button>`,
  )
  .join(
    "",
  )}</div><div id="detail-header" hidden></div><div id="list-tools" hidden><label class="list-filter">${icon("Search")}<span class="sr-only">筛选当前列表</span><input id="list-filter" type="search" placeholder="筛选歌名、歌手、专辑" maxlength="60" autocomplete="off"/></label><label class="list-sort">${icon("ArrowDownUp")}<span class="sr-only">排序</span><select id="list-sort" aria-label="排序方式"><option value="default">默认顺序</option><option value="name">歌名</option><option value="artist">歌手</option><option value="album">专辑</option><option value="short">时长从短到长</option><option value="long">时长从长到短</option></select></label></div><div id="error" role="alert" hidden></div><div id="playlist-filters" role="group" aria-label="歌单分类" hidden>${[
  ["recent", "最近"],
  ["netease", "网易云"],
  ["qq", "QQ音乐"],
  ["internal", "本机"],
]
  .map(
    ([value, label]) =>
      `<button data-playlist-filter="${value}" aria-pressed="false">${label}</button>`,
  )
  .join(
    "",
  )}</div><div id="playlist-grid" hidden></div><div id="catalog-grid" hidden></div><div class="table-head" hidden></div><div id="songs"></div><button id="more" class="load-more" hidden>加载更多 ${icon("ChevronRight")}</button></section></div><div id="selection-bar" role="toolbar" aria-label="批量操作" hidden><span id="selection-count">已选 0 首</span><div class="selection-actions"><button data-sel="all">全选</button><button data-sel="next">下一首播放</button><button data-sel="queue">加入队列</button><button data-sel="playlist">加入歌单</button><button data-sel="favorite">收藏</button><button data-sel="download">下载</button><button data-sel="remove">移出队列</button><button data-sel="done" class="primary">完成</button></div></div></main>
<input id="file-input" type="file" accept="audio/*,.mp3,.flac,.m4a,.wav,.ogg,.aac" multiple hidden/><div id="toast" role="status"></div>
<dialog id="account-dialog" aria-labelledby="account-title"><button id="account-close" class="dialog-close icon-button" aria-label="关闭登录">${icon("X")}</button><h2 id="account-title">登录网易云音乐</h2><p class="account-subtitle">用网易云音乐 App 扫码，在手机上确认登录。</p><div class="account-platforms"><button id="account-netease" class="outline">网易云</button><button id="account-qq" class="outline">QQ音乐</button></div><div class="account-methods" id="netease-login-method" hidden><button data-netease-method="phone" type="button" class="quiet">手机号登录</button><button data-netease-method="qr" type="button" class="quiet">扫码登录</button></div><div id="qq-login-method" hidden><button data-qq-kind="qq" class="quiet">QQ扫码</button><button data-qq-kind="wx" class="quiet">微信扫码</button></div><div id="account-content"></div><p id="account-status" role="status"></p><div class="account-actions"><button id="share-login-qr" class="outline" hidden>保存或分享二维码</button><button id="refresh-qr" class="outline">刷新二维码</button><button id="logout" class="outline" hidden>退出登录</button></div><small class="account-note">登录后读取你的歌单，音质按账号权限提供。<br>${credentialNotice}</small></dialog>`;
document.body.insertAdjacentHTML(
  "beforeend",
  `<aside id="lyrics-panel" aria-label="歌词面板" hidden><header class="lyrics-header" data-tauri-drag-region><span data-tauri-drag-region>歌词</span><button id="lyrics-close" class="icon-button" aria-label="收起歌词面板">${icon("X")}</button></header><div class="lyrics-heading"><h2 id="lyrics-title">正在播放</h2><p id="lyrics-artist">音乐响起时，让文字陪你一起听。</p></div><div id="lyrics" class="lyrics" tabindex="0" aria-label="同步歌词" hidden><p class="lyric-placeholder">音乐响起时，让文字陪你一起听。</p></div><button id="lyrics-follow" class="outline" hidden>回到当前歌词</button></aside>`,
);
if (mobileDevice) {
  document
    .querySelectorAll("[data-tauri-drag-region]")
    .forEach((el) => el.removeAttribute("data-tauri-drag-region"));
  $("#download-folder").textContent = "查看保存位置";
  document
    .querySelectorAll<HTMLOptionElement>("#quality option")
    .forEach((option) => {
      option.title = option.textContent || "";
      if (option.value === "best") option.textContent = "最高";
      if (option.value === "exhigh") option.textContent = "高品";
    });
}
for (const id of ["#seek", "#volume"]) {
  const input = $(id) as HTMLInputElement;
  input.addEventListener("input", () => paintRange(input));
  paintRange(input);
}
const lyricFollower = setupLyrics(
  audio,
  (index) => {
    const line = lyrics[index];
    if (!line) return;
    audio.currentTime = Math.max(
      0,
      Math.min(line.time - trialStart, audio.duration),
    );
    lyricFollower.sync(index, true, true);
  },
  toast,
);
// Reopen the lyrics pane the way the app was closed; the native window was
// already restored at its expanded width, so no resize animation is due.
if (isTauri() && !mobileDevice && readSetting("ting.lyrics-open") === "1")
  void lyricFollower.setOpen(true, false);
setupThemes();
if (!mobileDevice) {
  setupColumns();
  setupUpdater(toast);
}
const accountKey = (source: Source) => String(profile(source)?.userId || "");
const library = setupLibrary({
  cloud,
  toast,
  account: accountKey,
  sources: signedInSources,
  selected: () => (view === "playlist" ? selectedPlaylist : undefined),
  download: isTauri()
    ? (song) => {
        if (downloadQueue.enqueue([song]))
          toast(`已加入下载队列：${song.name}`);
      }
    : undefined,
  playNext: (song) => {
    queueFillSerial++;
    queueExpected = 0;
    playbackQueue.playNext([song]);
    save();
    if (view === "queue") renderSongs();
    else syncRows();
    toast(
      current
        ? `「${song.name}」将在下一首播放`
        : `已加入播放队列：${song.name}`,
    );
  },
  browse: (song, target) => {
    if (target === "album") {
      const ref = albumRef(song);
      if (ref) void openAlbum(ref);
    } else {
      const ref = artistRefs(song)[target.artist];
      if (ref) void openArtist(ref);
    }
  },
  changed: async (item) => {
    // Keep filling the playback queue, but do not let old pages overwrite an edited library.
    playlistEditVersion++;
    save();
    // A local file may have been forgotten or favorited from the dialog.
    locals = localSongs();
    favorites = favoriteSongs();
    updateFavorite();
    const local = internalPlaylists();
    playlists = [...local, ...playlists.filter((p) => !p.internal)];
    if (
      item &&
      view === "playlist" &&
      selectedPlaylist &&
      playlistKey(selectedPlaylist) === playlistKey(item)
    ) {
      const next = item.internal ? local.find((p) => p.id === item.id) : item;
      if (next) await loadPlaylist(next);
      else await loadPlaylists();
    } else if (view === "playlists") await loadPlaylists();
    else renderSongs();
  },
});
setupSync(() => {
  favorites = favoriteSongs();
  syncRows();
  updateFavorite();
  if (view === "favorites") renderSongs();
  playlistEditVersion++;
  const local = internalPlaylists();
  playlists = [...local, ...playlists.filter((p) => !p.internal)];
  if (view === "playlist" && selectedPlaylist?.internal) {
    const item = local.find((p) => p.id === selectedPlaylist!.id);
    if (item) {
      selectedPlaylist = item;
      playlistSongs = internalSongs(item);
      playlistTotal = playlistOffset = playlistSongs.length;
      renderSongs();
    } else {
      selectedPlaylist = undefined;
      setView("playlists");
      renderSongs();
    }
  } else if (view === "playlists") renderSongs();
});
$("#new-playlist").onclick = () => library.create();
window.addEventListener("ting:covers", () => {
  if (view === "playlists") renderSongs();
});
$("#manage-playlist").onclick = () => {
  if (selectedPlaylist) library.manage(selectedPlaylist);
};

function baseList(): Song[] {
  switch (view) {
    case "discover":
      return searchKind === "song" ? results : [];
    case "favorites":
      return favorites;
    case "local":
      return localTab === "songs" ? locals : [];
    case "playlist":
      return playlistSongs;
    case "playlists":
      return [];
    case "artist":
      return artistState?.tab === "songs" ? artistState.page?.songs || [] : [];
    case "album":
      return albumState?.page?.songs || [];
    default:
      return queueTab === "history" ? playHistory : playbackQueue.songs;
  }
}
/** Views whose songs can be narrowed with the in-list filter. */
const filterable = (v: View) =>
  ["playlist", "favorites", "local", "queue", "artist", "album"].includes(v);
/** The queue plays in its own order, so it filters but never re-sorts. */
const sortable = (v: View) => filterable(v) && v !== "queue";
const currentSort = () => (sortable(view) && listSorts.get(view)) || "default";
function list(): Song[] {
  const songs = baseList();
  const sort = currentSort();
  if (!filterable(view) || (!listFilter.trim() && sort === "default"))
    return songs;
  return arrange(songs, listFilter, sort);
}
/** Whether the list shows cards (artists, albums, playlists) instead of songs. */
function showsCards() {
  return (
    (view === "discover" && searchKind !== "song") ||
    (view === "artist" && artistState?.tab !== "songs") ||
    (view === "local" && localTab !== "songs")
  );
}
function coverMarkup(song: Song, cls = "") {
  return song.cover
    ? `<img class="${cls}" src="${esc(song.cover)}" alt="${esc(song.album || song.name)} 封面" loading="lazy" referrerpolicy="no-referrer"/>`
    : `<span class="fallback-cover ${cls}">${icon("Music2")}</span>`;
}
const updateCover = createCover($("#now-cover"), () => {
  const fallback = document.createElement("span");
  fallback.className = "fallback-cover";
  fallback.innerHTML = icon("Music2");
  return fallback;
});
function renderState(container: HTMLElement, markup: string) {
  if (container.dataset.state === markup) return;
  container.dataset.state = markup;
  container.innerHTML = markup;
  // An empty state or a loading placeholder is a label swapped inside one
  // slot, not content arriving from somewhere: it has no direction.
  animateContent(container, { distance: 0, duration: MOTION.t2, from: 0.35 });
}
const navIndicator = document.createElement("span");
navIndicator.className = "nav-indicator";
navIndicator.setAttribute("aria-hidden", "true");
$("nav").append(navIndicator);
function updateNavIndicator() {
  const active = document.querySelector<HTMLElement>("nav button.active");
  if (!active) return;
  const button = active.getBoundingClientRect();
  const nav = $("nav").getBoundingClientRect();
  navIndicator.style.width = `${button.width}px`;
  navIndicator.style.transform = `translateX(${button.left - nav.left}px)`;
}
new ResizeObserver(updateNavIndicator).observe($("nav"));
updateNavIndicator();
const indicatorReady = () => navIndicator.classList.add("ready");
if (document.fonts?.ready)
  void document.fonts.ready.then(indicatorReady).catch(indicatorReady);
else requestAnimationFrame(indicatorReady);
function syncRows() {
  $("#fav-count").textContent = String(favorites.length);
  $("#queue-count").textContent =
    String(playbackQueue.songs.length) +
    (queueExpected > playbackQueue.songs.length ? "…" : "");
  $("#queue-count").title = queueExpected
    ? `正在补齐队列：${playbackQueue.songs.length}/${queueExpected}`
    : `${playbackQueue.songs.length} 首`;
  const favoriteIds = new Set(favorites.map(songKey));
  const visibleSongs = new Map(list().map((song) => [songKey(song), song]));
  document.querySelectorAll<HTMLElement>(".song-row").forEach((row) => {
    const id = row.dataset.song!,
      selected = id === songKey(current);
    row.classList.toggle("playing", selected);
    row.classList.toggle("selected", id === selectedSongId);
    row.classList.toggle("checked", selecting && selection.has(id));
    row
      .querySelector(".song-title")
      ?.setAttribute("aria-pressed", String(id === selectedSongId));
    const fav = row.querySelector<HTMLButtonElement>("[data-favorite]")!;
    const liked = favoriteIds.has(id);
    fav.classList.toggle("is-favorite", liked);
    fav.setAttribute(
      "aria-label",
      `${liked ? "取消收藏" : "收藏"} ${visibleSongs.get(id)?.name || ""}`,
    );
  });
  renderSelection();
}
/** The batch bar under the list while picking several songs. */
function renderSelection() {
  const canSelect =
    !showsCards() && view !== "playlists" && baseList().length > 1;
  $("#select-mode").hidden = !canSelect;
  $("#select-mode").setAttribute("aria-pressed", String(selecting));
  document.body.classList.toggle("selecting", selecting);
  $("#selection-bar").hidden = !selecting;
  if (!selecting) return;
  $("#selection-count").textContent = `已选 ${selection.size} 首`;
  const inQueue = view === "queue" && queueTab === "queue";
  $('[data-sel="remove"]').hidden = !inQueue;
  $('[data-sel="download"]').hidden = !isTauri();
  $('[data-sel="next"]').hidden = inQueue;
  document
    .querySelectorAll<HTMLButtonElement>("#selection-bar [data-sel]")
    .forEach((b) => {
      if (!["all", "done"].includes(b.dataset.sel!))
        b.disabled = !selection.size;
    });
  const all =
    list().length > 0 && list().every((s) => selection.has(songKey(s)));
  $('[data-sel="all"]').textContent = all ? "全不选" : "全选";
}
function setSelecting(on: boolean) {
  selecting = on;
  if (!on) selection.clear();
  selectionAnchor = "";
  syncRows();
}
/** Ticks or unticks a row; Shift extends from the last tick in list order. */
function toggleSelected(key: string, range = false) {
  const songs = list().map(songKey);
  if (range && selectionAnchor && songs.includes(selectionAnchor)) {
    const [a, b] = [songs.indexOf(selectionAnchor), songs.indexOf(key)].sort(
      (x, y) => x - y,
    );
    songs.slice(a, b + 1).forEach((k) => selection.add(k));
  } else if (selection.has(key)) selection.delete(key);
  else selection.add(key);
  selectionAnchor = key;
  syncRows();
}
function selectedSongs() {
  return list().filter((s) => selection.has(songKey(s)));
}
function selectSong(id: string) {
  const previous = selectedSongId;
  selectedSongId = id;
  for (const key of new Set([previous, id])) {
    if (!key) continue;
    const row = document.querySelector<HTMLElement>(
      `[data-song="${CSS.escape(key)}"]`,
    );
    row?.classList.toggle("selected", key === id);
    row
      ?.querySelector(".song-title")
      ?.setAttribute("aria-pressed", String(key === id));
  }
}
// Set by setView so a view transition never plays twice: once as the library
// sliding in, once as every fresh row popping up inside it.
let suppressRowStagger = false;
// Must run after every DOM write of this render; it reads geometry once and
// then only reads, so the batch costs a single forced layout.
function visibleHead(rows: HTMLElement[]): HTMLElement[] {
  const box = $(".main-scroll").getBoundingClientRect();
  const picked: HTMLElement[] = [];
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.top > box.bottom + 40) break;
    if (rect.bottom >= box.top - 40) picked.push(row);
    if (picked.length >= MOTION.staggerMax) break;
  }
  return picked;
}
/** The query to mark in rows: the one that produced the results shown. */
let resultsQuery = "";
const markQuery = () => (view === "discover" ? resultsQuery : "");
function songRowMarkup(song: Song) {
  const q = markQuery();
  const inQueue = view === "queue" && queueTab === "queue";
  // A phone row is one big tap-to-play target; names inside it would be easy
  // to hit by accident, so phones reach these pages from the "…" menu.
  const links = !mobileDevice;
  const artists = (links && artistLinks(song, q)) || hl(song.artist, q);
  const album =
    view !== "album" && song.album
      ? `<span class="meta-sep"> · </span>${links ? albumLink(song, q) : hl(song.album, q)}`
      : "";
  const badge = song.missing
    ? "<em>文件丢失</em>"
    : localSong(song)
      ? "<em>本地</em>"
      : song.fee === 1
        ? "<em>VIP</em>"
        : "";
  return `<span class="row-number"></span><div class="song-info">${coverMarkup(song)}<div><button class="song-title" aria-label="${mobileDevice ? "播放" : "选中"} ${esc(song.name)}" aria-pressed="false">${hl(song.name, q)}</button>${badge}<small><span class="source-badge" data-source="${song.source || "netease"}">${sourceName(song)}</span>${downloadedCopy(song) ? '<span class="quality-badge downloaded">已下载</span>' : qualityBadge(song)} ${artists}${album}</small></div></div><span class="album">${esc(song.album)}</span><span class="song-duration">${song.duration ? formatTime(song.duration / 1000) : "—"}</span><div class="row-actions"><button class="icon-button favorite" data-favorite="${songKey(song)}" ${transient(song) ? "disabled" : ""}>${icon("Heart")}</button><button class="icon-button" data-${inQueue ? "remove" : "enqueue"}="${songKey(song)}" aria-label="${inQueue ? "移出队列" : "加入队列"} ${esc(song.name)}">${icon(inQueue ? "X" : "Plus")}</button><button class="icon-button" data-song-menu="${songKey(song)}" aria-label="歌曲操作 ${esc(song.name)}" ${transient(song) ? "disabled" : ""}>${icon("Ellipsis")}</button></div>`;
}
/** Artist / album hero and the artist page's tabs, above the list. */
function renderDetailHeader() {
  const box = $("#detail-header");
  const page =
    view === "artist"
      ? artistState?.page
      : view === "album"
        ? albumState?.page
        : undefined;
  if (!page) {
    box.hidden = true;
    delete box.dataset.key;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  const key =
    view === "artist"
      ? `artist:${artistState!.page!.artist.source}:${artistState!.page!.artist.id}:${artistState!.page!.artist.mid || ""}:${artistState!.tab}:${artistState!.page!.similar.length}`
      : `album:${albumState!.page!.album.source}:${albumState!.page!.album.id}:${albumState!.page!.album.mid || ""}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (view === "artist") {
    const state = artistState!;
    const tabs: [ArtistState["tab"], string][] = [
      ["songs", "热门歌曲"],
      ["albums", "专辑"],
      ...(state.page!.similar.length
        ? [["similar", "相似歌手"] as [ArtistState["tab"], string]]
        : []),
    ];
    box.innerHTML = `${artistHeader(state.page!)}${state.ref.source === "local" ? "" : `<div id="detail-tabs" class="segmented" role="tablist">${tabs.map(([tab, label]) => `<button role="tab" data-artist-tab="${tab}" aria-selected="${state.tab === tab}">${label}</button>`).join("")}</div>`}`;
  } else box.innerHTML = albumHeader(albumState!.page!);
  // Offer "展开" only for text the two-line clamp actually cuts.
  const brief = box.querySelector<HTMLElement>(".detail-brief");
  const more = box.querySelector<HTMLElement>("[data-toggle-brief]");
  if (brief && more) more.hidden = brief.scrollHeight <= brief.clientHeight + 1;
}
/** Artist, album and playlist cards: search tabs and the artist's albums. */
function renderCards(stagger: boolean) {
  const box = $("#catalog-grid");
  const cards: Card[] =
    view === "discover"
      ? catalogResults
      : view === "local"
        ? localCards()
        : artistState?.tab === "albums"
          ? artistState.albums.map((value) => ({
              kind: "album" as const,
              value,
            }))
          : (artistState?.page?.similar || []).map((value) => ({
              kind: "artist" as const,
              value,
            }));
  gridCards = cards;
  const loading = busy || libraryBusy;
  if (!cards.length) {
    const labels = { artist: "歌手", album: "专辑", playlist: "歌单" };
    renderState(
      box,
      loading
        ? '<div class="empty-state"><p>正在加载…</p></div>'
        : view === "discover"
          ? `<div class="empty-state">${icon("Search")}<h3>没有找到${labels[searchKind as CatalogKind]}</h3><p>换个关键词，或切换平台试试。</p></div>`
          : '<div class="empty-state"><p>暂时没有更多内容</p></div>',
    );
    return;
  }
  delete box.dataset.state;
  const markup = cards
    .map((card, i) => cardMarkup(card, i, markQuery()))
    .join("");
  const signature = `${view}:${searchKind}:${artistState?.tab}:${markup.length}:${cards.length}`;
  if (box.dataset.signature === signature) return;
  const previous = box.querySelectorAll(".catalog-card").length;
  box.dataset.signature = signature;
  box.innerHTML = `<div class="catalog-cards">${markup}</div>`;
  if (stagger) {
    const fresh = Array.from(
      box.querySelectorAll<HTMLElement>(".catalog-card"),
    ).slice(previous);
    if (fresh.length) animateArrival(visibleHead(fresh));
  }
}
function renderListTools() {
  const tools = $("#list-tools");
  const show = filterable(view) && !showsCards() && baseList().length > 1;
  tools.hidden = !show;
  if (!show) return;
  const input = $("#list-filter") as HTMLInputElement;
  if (input.value !== listFilter) input.value = listFilter;
  const sort = $("#list-sort") as HTMLSelectElement;
  sort.hidden = !sortable(view);
  if (sort.value !== currentSort()) sort.value = currentSort();
}
function searchMore() {
  if (view !== "discover") return false;
  const sources: Source[] =
    searchSource === "all" ? ["netease", "qq"] : [searchSource];
  return sources.some((s) => searchOffsets[s] < searchTotals[s]);
}
function renderSongs() {
  const stagger = !suppressRowStagger;
  suppressRowStagger = false;
  const songs = list(),
    grid = view === "playlists",
    cards = showsCards();
  const loading =
    (busy && view === "discover") || (libraryBusy && (isDetail(view) || grid));
  $(".library").setAttribute("aria-busy", String(loading));
  $(".library").classList.toggle("is-loading", loading);
  $("#playlist-grid").hidden = !grid;
  $("#playlist-filters").hidden = !grid;
  $("#catalog-grid").hidden = !cards;
  $("#songs").hidden = grid || cards;
  $("#search-kinds").hidden = view !== "discover";
  $("#local-tabs").hidden = view !== "local" || !locals.length;
  $("#queue-tabs").hidden = view !== "queue";
  $("#clear-list").hidden =
    view !== "queue" ||
    !(queueTab === "history"
      ? playHistory.length
      : playbackQueue.songs.length > 1);
  $(".table-head").hidden = true;
  $("#play-all").hidden = grid || cards;
  $("#enqueue-all").hidden =
    !["artist", "album"].includes(view) || cards || !songs.length;
  $("#download-all").hidden =
    !isTauri() ||
    !["artist", "album", "playlist", "favorites"].includes(view) ||
    cards ||
    !songs.some((s) => !localSong(s));
  $("#new-playlist").hidden = !grid;
  $("#refresh-playlists").hidden = !grid;
  $("#refresh-playlists").toggleAttribute("disabled", libraryBusy);
  $("#manage-playlist").hidden =
    view !== "playlist" || !selectedPlaylist?.owned;
  $("#copy-playlist").hidden =
    view !== "playlist" || !selectedPlaylist || !!selectedPlaylist.internal;
  const count = grid
    ? displayedPlaylists().length
    : cards
      ? gridCards.length
      : songs.length;
  $("#result-count").textContent = count ? ` / ${count}` : "";
  $("#play-all").toggleAttribute("disabled", !songs.length);
  $("#more").hidden =
    view === "discover"
      ? !searchMore() ||
        !(searchKind === "song" ? results.length : catalogResults.length)
      : view === "playlists"
        ? !(playlistFilter === "netease"
            ? neteasePlaylistsMore
            : playlistFilter === "qq"
              ? qqPlaylistsMore
              : false)
        : view === "playlist"
          ? playlistOffset >= playlistTotal
          : view === "artist"
            ? artistState?.tab !== "albums" || !artistState.albumMore
            : true;
  $("#more").toggleAttribute("disabled", busy || libraryBusy);
  renderDetailHeader();
  renderListTools();
  if (grid) {
    renderPlaylists(stagger);
    syncRows();
    return;
  }
  if (cards) {
    renderCards(stagger);
    // The count above read the previous cards; settle it on this render's.
    $("#result-count").textContent = gridCards.length
      ? ` / ${gridCards.length}`
      : "";
    $("#more").hidden =
      view === "discover"
        ? !searchMore() || !gridCards.length
        : artistState?.tab !== "albums" || !artistState.albumMore;
    return;
  }
  const container = $("#songs");
  if (
    ((busy && view === "discover") || (libraryBusy && isDetail(view))) &&
    !songs.length
  ) {
    renderState(
      container,
      '<div class="empty-state"><p>正在加载音乐…</p></div>',
    );
    return;
  }
  const empty: Record<View, [string, string]> = {
    discover: ["没有找到歌曲", "换个关键词，或导入本地音频试试。"],
    favorites: [
      "把喜欢的声音收藏起来",
      "这里的收藏保存在本机，网易云歌单在「我的歌单」中。",
    ],
    local: ["你的本地唱片架", "导入本地音频，离线也能播放。"],
    queue: [
      "播放队列还是空的",
      `${mobileDevice ? "轻点" : "双击"}一首歌开始播放，或点击歌曲旁的加号。`,
    ],
    playlists: ["我的歌单", "登录后读取你的歌单"],
    playlist: ["歌单暂时没有歌曲", "选择其他歌单，或稍后再来看看。"],
    artist: ["暂时没有歌曲", "这位歌手在当前平台还没有可播放的歌曲。"],
    album: ["专辑暂时没有歌曲", "这张专辑在当前平台还没有可播放的曲目。"],
  };
  if (!songs.length) {
    const filtered = !!listFilter.trim() && baseList().length > 0;
    renderState(
      container,
      filtered
        ? `<div class="empty-state">${icon("Search")}<h3>没有符合「${esc(listFilter.trim())}」的歌曲</h3><p>换个词，或清空筛选。</p></div>`
        : `<div class="empty-state">${icon(view === "local" ? "FolderOpen" : "Music2")}<h3>${empty[view][0]}</h3><p>${empty[view][1]}</p>${view === "local" ? '<button id="empty-import" class="primary">导入本地音乐</button>' : ""}${view === "playlist" ? '<button id="empty-back" class="outline">返回我的歌单</button>' : ""}</div>`,
    );
    syncRows();
    return;
  }
  container
    .querySelectorAll(".empty-state,.skeleton")
    .forEach((n) => n.remove());
  delete container.dataset.state;
  // Only rows created by this render arrive; a signature rewrite is an update
  // of something already on screen, and retained rows must not move at all.
  const fresh: HTMLElement[] = [];
  const existing = new Map(
    Array.from(container.querySelectorAll<HTMLElement>(".song-row")).map(
      (row) => [row.dataset.song!, row],
    ),
  );
  const wanted = new Set(songs.map((s) => songKey(s)));
  existing.forEach((row, id) => {
    if (!wanted.has(id)) row.remove();
  });
  const marked = markQuery();
  songs.forEach((song, i) => {
    let row = existing.get(songKey(song));
    const signature = JSON.stringify([
      song,
      view === "queue" && queueTab === "queue",
      view === "album",
      marked,
      !!downloadedCopy(song),
    ]);
    if (!row || row.dataset.signature !== signature) {
      const next = document.createElement("div");
      next.className = "song-row";
      next.dataset.song = songKey(song);
      next.dataset.signature = signature;
      next.tabIndex = 0;
      next.setAttribute("role", "group");
      next.setAttribute("aria-label", song.name);
      next.title = mobileDevice ? "轻点播放" : "单击选中，双击播放；回车播放";
      next.innerHTML = songRowMarkup(song);
      // The queue reorders by dragging on desktop (not while filtered).
      if (
        view === "queue" &&
        queueTab === "queue" &&
        !mobileDevice &&
        !listFilter.trim()
      )
        next.draggable = true;
      if (row) row.replaceWith(next);
      else fresh.push(next);
      row = next;
    }
    if (container.children[i] !== row)
      container.insertBefore(row, container.children[i] ?? null);
  });
  syncRows();
  if (stagger && fresh.length) animateArrival(visibleHead(fresh));
}
let playlistsLoaded = false;
const viewScroll = new Map<View, number>();
const NAV_LABELS: Partial<Record<View, string>> = {
  discover: "搜索",
  playlists: "歌单",
  favorites: "收藏",
  local: "本地",
  queue: "队列",
};
/** Where the back button leads, as a short label and a full accessible name. */
function backTarget(): { label: string; aria: string } {
  const top = backStack[backStack.length - 1];
  if (!top)
    return view === "playlist"
      ? { label: "歌单", aria: "返回歌单列表" }
      : { label: "搜索", aria: "返回搜索" };
  if (top.view === "playlists") return { label: "歌单", aria: "返回歌单列表" };
  if (top.view === "playlist")
    return {
      label: "歌单",
      aria: `返回歌单 ${top.playlist?.name || ""}`.trim(),
    };
  if (top.view === "artist")
    return {
      label: "歌手",
      aria: `返回歌手 ${top.artist?.ref.name || ""}`.trim(),
    };
  if (top.view === "album")
    return {
      label: "专辑",
      aria: `返回专辑 ${top.album?.ref.name || ""}`.trim(),
    };
  const label = NAV_LABELS[top.view] || "返回";
  return { label, aria: `返回${label}` };
}
/** The nav tab a page belongs to: the one its back stack started from. */
function navOwner(v: View): View {
  if (!isDetail(v)) return v;
  return backStack[0]?.view || (v === "playlist" ? "playlists" : "discover");
}
function sectionTitle(): string {
  switch (view) {
    case "playlist":
      return selectedPlaylist
        ? `${playlistLabel(selectedPlaylist)} · ${selectedPlaylist.name}`
        : "歌单";
    case "artist":
      return artistState?.page?.artist.name || artistState?.ref.name || "歌手";
    case "album":
      return albumState?.page?.album.name || albumState?.ref.name || "专辑";
    default:
      return {
        discover: "搜索结果",
        favorites: "收藏",
        playlists: "我的歌单",
        local: "本地音乐",
        queue: "播放队列",
      }[view];
  }
}
function renderHeading() {
  const heading = $("#section-title");
  const title = sectionTitle();
  if (heading.firstChild?.nodeValue !== title)
    heading.firstChild!.nodeValue = title;
}
/** Minimal refs only: a restored page fetches fresh data by id. */
const refOf = <T extends ArtistRef | AlbumRef>(r: T | undefined) =>
  r && {
    source: r.source,
    id: r.id,
    ...(r.mid ? { mid: r.mid } : {}),
    name: r.name,
    ...("artist" in r && r.artist ? { artist: r.artist } : {}),
  };
/** `fresh` re-enters the same kind of page as a new one (artist → artist). */
function setView(next: View, fresh = false) {
  const previous = view;
  const changed = view !== next || fresh;
  if (changed) {
    if (view === "playlists" && libraryBusy) playlistsLoaded = false;
    if (view !== next) viewScroll.set(view, $(".main-scroll").scrollTop);
    librarySerial++;
    libraryBusy = false;
    listFilter = "";
    selecting = false;
    selection.clear();
  }
  // Reaching a nav page by any route means nothing is left to go back to.
  if (!isDetail(next)) backStack = [];
  view = next;
  // The local shelf is only worth returning to where it persists.
  if (next !== "discover" && (next !== "local" || persistentLocals))
    saveSession({
      view: next,
      playlist: next === "playlist" ? selectedPlaylist : undefined,
      artist: next === "artist" ? refOf(artistState?.ref) : undefined,
      album: next === "album" ? refOf(albumState?.ref) : undefined,
    });
  const owner = navOwner(view);
  document
    .querySelectorAll("[data-view]")
    .forEach((el) =>
      el.classList.toggle("active", (el as HTMLElement).dataset.view === owner),
    );
  $("#search-form").hidden = view !== "discover";
  $("#import-top").hidden = view !== "local";
  $("#import-folder").hidden = view !== "local" || !isTauri() || mobileDevice;
  $("#back-button").hidden = !isDetail(view);
  if (isDetail(view)) {
    const target = backTarget();
    const back = $("#back-button");
    back.setAttribute("aria-label", target.aria);
    if (back.lastChild?.nodeValue !== target.label)
      back.lastChild!.nodeValue = target.label;
  }
  $(".topbar").hidden = view !== "discover" && view !== "local";
  $("#discover-tools").hidden = view !== "discover";
  $("#error").hidden = true;
  renderHeading();
  // The library itself carries the transition; its rows must not each animate.
  if (changed) suppressRowStagger = true;
  renderSongs();
  if (changed) {
    const restored = viewScroll.get(next) || 0;
    $(".main-scroll").scrollTop = restored;
    const move = viewMove(previous, next, navigatingBack);
    // A restored scroll position means the page was already here and is only
    // being revealed again, so it arrives softer than genuinely new content.
    animateContent($(".library"), {
      axis: "x",
      direction: move.direction,
      distance: restored > 0 ? Math.round(move.distance * 0.6) : move.distance,
      duration: restored > 0 ? MOTION.t3 : move.duration,
      from: 0,
      easing: MOTION.move,
    });
    // Entrance only: the hidden attribute alone owns the resting state, so a
    // pop can never strand the button visible.
    if (move.direction === 1 && isDetail(next) && !isDetail(previous))
      animateContent($("#back-button"), {
        axis: "x",
        direction: -1,
        distance: 8,
        duration: MOTION.t3,
        delay: 80,
        from: 0,
        easing: MOTION.enter,
      });
    updateNavIndicator();
  }
}
/** Remembers the page being left before a detail page opens on top of it. */
function pushCrumb(next: View) {
  // Opening another playlist from a playlist keeps the original way back.
  if (view === "playlist" && next === "playlist") return;
  backStack.push({
    view,
    scroll: $(".main-scroll").scrollTop,
    ...(view === "playlist"
      ? {
          playlist: selectedPlaylist,
          playlistSongs,
          playlistOffset,
          playlistTotal,
        }
      : {}),
    ...(view === "artist" ? { artist: artistState } : {}),
    ...(view === "album" ? { album: albumState } : {}),
  });
  // Artist → album → artist chains can go on forever; the way back needn't.
  if (backStack.length > 30) backStack.splice(1, 1);
}
// Back navigation always routes through setView so scroll restore, serial
// invalidation and nav highlighting behave exactly like a nav tap.
function goBack() {
  if (!isDetail(view)) return;
  const crumb = backStack.pop();
  navigatingBack = true;
  try {
    if (!crumb) {
      setView(view === "playlist" ? "playlists" : "discover");
      return;
    }
    viewScroll.set(crumb.view, crumb.scroll);
    if (crumb.view === "playlist") {
      // The recorded origin can become unreachable (logout cleared it); the
      // playlist list is the safe fallback for any stale detail view.
      if (!crumb.playlist) {
        setView("playlists");
        return;
      }
      selectedPlaylist = crumb.playlist;
      playlistSongs = crumb.playlist.internal
        ? internalSongsOrEmpty(crumb.playlist)
        : crumb.playlistSongs || [];
      playlistOffset = crumb.playlist.internal
        ? playlistSongs.length
        : crumb.playlistOffset || 0;
      playlistTotal = crumb.playlist.internal
        ? playlistSongs.length
        : crumb.playlistTotal || 0;
    } else if (crumb.view === "artist") artistState = crumb.artist;
    else if (crumb.view === "album") albumState = crumb.album;
    setView(crumb.view, true);
  } finally {
    navigatingBack = false;
  }
}
/** Opens an artist page on top of the current one. */
async function openArtist(ref: ArtistRef) {
  if (mobileDevice && !$("#lyrics-panel").hidden)
    void lyricFollower.setOpen(false);
  pushCrumb("artist");
  artistState = {
    ref,
    tab: "songs",
    albums: [],
    albumTotal: 0,
    albumMore: true,
    albumsLoaded: false,
  };
  viewScroll.delete("artist");
  // Re-entering "artist" from "artist" is still a new page arriving.
  setView("artist", true);
  $(".main-scroll").scrollTop = 0;
  const state = artistState;
  const serial = ++librarySerial;
  libraryBusy = true;
  renderSongs();
  try {
    const page = await loadArtist(cloud, ref, locals);
    if (serial !== librarySerial || artistState !== state) return;
    state.page = page;
    state.ref = { ...ref, ...refOf(page.artist)!, source: ref.source };
    saveSession({ artist: refOf(state.ref) });
  } catch (e) {
    if (serial !== librarySerial) return;
    $("#error").textContent = e instanceof Error ? e.message : String(e);
    $("#error").hidden = false;
  } finally {
    if (serial === librarySerial) {
      libraryBusy = false;
      renderHeading();
      renderSongs();
    }
  }
}
async function loadArtistAlbumPage(append = false) {
  const state = artistState;
  if (!state?.page || view !== "artist") return;
  const serial = ++librarySerial;
  libraryBusy = true;
  renderSongs();
  try {
    const list = await loadArtistAlbums(
      cloud,
      state.page.artist,
      append ? state.albums.length : 0,
      locals,
    );
    if (serial !== librarySerial || artistState !== state) return;
    const seen = new Set<string>();
    state.albums = [...(append ? state.albums : []), ...list.albums].filter(
      (a) => {
        const key = `${a.id}:${a.mid || ""}:${a.name}`;
        return !seen.has(key) && !!seen.add(key);
      },
    );
    state.albumTotal = list.total;
    state.albumMore = list.more && list.albums.length > 0;
    state.albumsLoaded = true;
  } catch (e) {
    if (serial !== librarySerial) return;
    $("#error").textContent = e instanceof Error ? e.message : String(e);
    $("#error").hidden = false;
  } finally {
    if (serial === librarySerial) {
      libraryBusy = false;
      renderSongs();
    }
  }
}
function setArtistTab(tab: ArtistState["tab"]) {
  if (!artistState || artistState.tab === tab) return;
  artistState.tab = tab;
  $("#error").hidden = true;
  suppressRowStagger = false;
  renderSongs();
  animateContent($(".library"), { distance: 5, duration: MOTION.t2 });
  if (tab === "albums" && !artistState.albumsLoaded) void loadArtistAlbumPage();
}
/** Opens an album page on top of the current one. */
async function openAlbum(ref: AlbumRef) {
  if (mobileDevice && !$("#lyrics-panel").hidden)
    void lyricFollower.setOpen(false);
  pushCrumb("album");
  albumState = { ref };
  viewScroll.delete("album");
  setView("album", true);
  $(".main-scroll").scrollTop = 0;
  const state = albumState;
  const serial = ++librarySerial;
  libraryBusy = true;
  renderSongs();
  try {
    const page = await loadAlbum(cloud, ref, locals);
    if (serial !== librarySerial || albumState !== state) return;
    state.page = page;
    state.ref = {
      ...ref,
      ...refOf(page.album)!,
      source: ref.source,
      artist: page.album.artist,
    };
    saveSession({ album: refOf(state.ref) });
  } catch (e) {
    if (serial !== librarySerial) return;
    $("#error").textContent = e instanceof Error ? e.message : String(e);
    $("#error").hidden = false;
  } finally {
    if (serial === librarySerial) {
      libraryBusy = false;
      renderHeading();
      renderSongs();
    }
  }
}
/** The local shelf grouped by artist or by album, as cards. */
function localCards(): Card[] {
  const playable = locals.filter((s) => !s.missing);
  if (localTab === "albums")
    return albumsOf(playable).map((g, i) => ({
      kind: "album" as const,
      value: {
        source: "local" as const,
        id: -(i + 1),
        name: g.name,
        artist: [...new Set(g.songs.map((s) => s.artist))].join(" / "),
        artistId: 0,
        cover: g.cover,
        publishTime: 0,
        trackCount: g.songs.length,
      },
    }));
  const artists = new Map<string, { name: string; songs: Song[] }>();
  for (const song of playable)
    for (const a of songArtists(song)) {
      const key = normalizeName(a.name);
      const entry = artists.get(key) || { name: a.name, songs: [] };
      entry.songs.push(song);
      artists.set(key, entry);
    }
  return [...artists.values()]
    .sort(
      (a, b) =>
        b.songs.length - a.songs.length ||
        a.name.localeCompare(b.name, "zh-Hans-CN"),
    )
    .map((a) => ({
      kind: "artist" as const,
      value: {
        source: "local" as const,
        id: 0,
        name: a.name,
        avatar: a.songs.find((s) => s.cover)?.cover || "",
        albumCount: albumsOf(a.songs).length,
        songCount: a.songs.length,
        alias: "",
      },
    }));
}
function openCard(card: Card) {
  if (card.kind === "artist") void openArtist(card.value);
  else if (card.kind === "album") void openAlbum(card.value);
  else void loadPlaylist(card.value);
}
function internalSongsOrEmpty(p: Playlist) {
  try {
    return internalSongs(p);
  } catch {
    return [];
  }
}
const KIND_LABELS: Record<SearchKind, string> = {
  song: "首",
  artist: "位歌手",
  album: "张专辑",
  playlist: "个歌单",
};
async function search(term: string, append = false) {
  term = term.trim();
  if (!term) return;
  const serial = ++searchSerial;
  query = term;
  const sources: Source[] =
    searchSource === "all" ? ["netease", "qq"] : [searchSource];
  if (!append) {
    // Old results stay visible, but cannot paginate a failed replacement query.
    searchOffsets = { netease: 0, qq: 0 };
    searchTotals = { netease: 0, qq: 0 };
    mergeSeen = new Set();
    bestMatch = undefined;
    renderBestMatch();
  }
  busy = true;
  setView("discover");
  $("#search").setAttribute("value", term);
  ($("#search") as HTMLInputElement).value = term;
  $("#search-summary").textContent = `正在寻找「${term}」…`;
  const kind = searchKind;
  try {
    if (!isTauri())
      throw new Error(
        "云端搜索需要在 Ting 应用中使用；浏览器预览可导入本地音乐。",
      );
    if (!append && kind === "song") void findBestMatch(term, serial);
    // Each platform pages on its own; one failing leaves the other's results.
    const wanted = sources.filter(
      (s) => !append || searchOffsets[s] < searchTotals[s],
    );
    const settled = await Promise.allSettled(
      wanted.map((source) =>
        kind === "song"
          ? cloud<{ songs: Song[]; total: number }>(
              "search_songs",
              { query: term, offset: searchOffsets[source] },
              source,
            ).then((data) => ({
              source,
              total: data.total,
              count: data.songs.length,
              songs: data.songs,
              cards: [] as Card[],
            }))
          : searchCatalogPage(
              cloud,
              source,
              term,
              kind,
              searchOffsets[source],
            ).then((page) => {
              const cards: Card[] = [
                ...page.artists.map((value) => ({
                  kind: "artist" as const,
                  value,
                })),
                ...page.albums.map((value) => ({
                  kind: "album" as const,
                  value,
                })),
                ...page.playlists.map((value) => ({
                  kind: "playlist" as const,
                  value,
                })),
              ];
              return {
                source,
                total: page.total,
                count: cards.length,
                songs: [] as Song[],
                cards,
              };
            }),
      ),
    );
    if (serial !== searchSerial) return;
    const pages = settled.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const failures = settled.flatMap((r, i) =>
      r.status === "rejected"
        ? [`${sourceName({ source: wanted[i] })}：${String(r.reason)}`]
        : [],
    );
    if (!pages.length)
      throw new Error(failures.join("；") || "暂时无法获取搜索结果");
    for (const page of pages) {
      searchOffsets[page.source] += page.count;
      // An empty page ends that platform's results whatever its total says.
      searchTotals[page.source] = page.count
        ? page.total
        : searchOffsets[page.source];
    }
    const netease = pages.find((p) => p.source === "netease"),
      qq = pages.find((p) => p.source === "qq");
    if (kind === "song") {
      const incoming =
        sources.length > 1
          ? mergeResults(netease?.songs || [], qq?.songs || [], mergeSeen)
          : pages[0].songs;
      results = append ? uniqueSongs([...results, ...incoming]) : incoming;
      resultsQuery = term;
    } else {
      // Cards from both platforms alternate so neither buries the other.
      const a = netease?.cards || [],
        b = qq?.cards || [];
      const incoming: Card[] = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++)
        incoming.push(...[a[i], b[i]].filter(Boolean));
      catalogResults = append ? [...catalogResults, ...incoming] : incoming;
      resultsQuery = term;
    }
    const totalCount = sources.reduce((sum, s) => sum + searchTotals[s], 0);
    const where = sources.length > 1 ? "两个平台 · " : "";
    $("#search-summary").textContent =
      `「${term}」的搜索结果 · ${where}共 ${totalCount} ${KIND_LABELS[kind]}${sources.length > 1 && kind === "song" ? "（已合并同一首歌）" : ""}`;
    if (failures.length) toast(`部分平台未返回结果：${failures.join("；")}`);
  } catch (e) {
    if (serial !== searchSerial) return;
    $("#error").textContent = String(e);
    $("#error").hidden = view !== "discover";
    const shown = kind === "song" ? results.length : catalogResults.length;
    $("#search-summary").textContent = shown
      ? "暂时无法获取搜索结果，保留上次结果"
      : "暂时无法获取搜索结果";
  } finally {
    if (serial === searchSerial) {
      busy = false;
      renderSongs();
    }
  }
}
/** When the query is an artist's (or an album's) name, lead with that page. */
async function findBestMatch(term: string, serial: number) {
  const source: Source = searchSource === "all" ? "netease" : searchSource;
  try {
    const artists = await searchCatalogPage(cloud, source, term, "artist", 0);
    if (serial !== searchSerial) return;
    const artist = artists.artists.find((a) => namesArtist(term, a));
    if (artist) bestMatch = { kind: "artist", value: artist };
    else {
      const albums = await searchCatalogPage(cloud, source, term, "album", 0);
      if (serial !== searchSerial) return;
      const album = albums.albums.find(
        (a) => normalizeName(a.name) === normalizeName(term),
      );
      if (album) bestMatch = { kind: "album", value: album };
    }
    renderBestMatch();
  } catch {
    /* The songs are the answer; a missing shortcut is not an error. */
  }
}
function renderBestMatch() {
  const slot = $("#best-match-slot");
  const markup =
    bestMatch && searchKind === "song" ? bestMatchMarkup(bestMatch) : "";
  if (slot.innerHTML === markup) return;
  slot.innerHTML = markup;
  if (markup) animateContent(slot, { distance: 6 });
}
function setSearchKind(kind: SearchKind) {
  if (kind === searchKind) return;
  searchKind = kind;
  catalogResults = [];
  document
    .querySelectorAll<HTMLElement>("[data-search-kind]")
    .forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.searchKind === kind)),
    );
  renderBestMatch();
  $(".main-scroll").scrollTop = 0;
  void search(($("#search") as HTMLInputElement).value || query);
}
/** Fetches every remaining page of the open online playlist. */
async function fetchRestOfPlaylist(): Promise<boolean> {
  const item = selectedPlaylist;
  if (!item || item.internal) return true;
  while (
    view === "playlist" &&
    selectedPlaylist === item &&
    playlistOffset < playlistTotal
  ) {
    const before = playlistOffset;
    await loadPlaylist(item, true);
    if (playlistOffset <= before) return false;
  }
  return selectedPlaylist === item && playlistOffset >= playlistTotal;
}
let wholeLoading = false;
/** Filtering or sorting a paged playlist means little until all of it is here. */
async function loadWholePlaylist() {
  if (
    wholeLoading ||
    view !== "playlist" ||
    playlistOffset >= playlistTotal ||
    (!listFilter.trim() && currentSort() === "default")
  )
    return;
  wholeLoading = true;
  try {
    await fetchRestOfPlaylist();
  } finally {
    wholeLoading = false;
  }
}
async function copyPlaylist() {
  const item = selectedPlaylist;
  if (!item || item.internal || view !== "playlist") return;
  const button = $("#copy-playlist") as HTMLButtonElement;
  button.disabled = true;
  try {
    if (playlistOffset < playlistTotal)
      toast(`正在读取完整歌单，共 ${playlistTotal} 首…`);
    if (!(await fetchRestOfPlaylist()))
      throw new Error("未能读取完整歌单，请稍后重试");
    const copy = copyToInternal(item.name, playlistSongs);
    playlists = [
      ...internalPlaylists(),
      ...playlists.filter((p) => !p.internal),
    ];
    toast(`已复制为本机歌单「${copy.name}」，共 ${copy.trackCount} 首`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    button.disabled = false;
  }
}
function toggleFavorite(song: Song) {
  if (transient(song)) return;
  const next = favorites.some((s) => songKey(s) === songKey(song))
    ? favorites.filter((s) => songKey(s) !== songKey(song))
    : [song, ...favorites];
  try {
    setFavoriteSongs(next);
    favorites = favoriteSongs();
  } catch {
    toast("本地存储空间不足，收藏修改未保存");
    return;
  }
  if (view === "favorites") renderSongs();
  else syncRows();
  updateFavorite();
}
let downloading = false;
function updateDownloadButton() {
  const saved = !!downloadedCopy(current);
  $("#download-current").toggleAttribute(
    "disabled",
    downloading || !current || localSong(current) || saved,
  );
  $("#download-current").classList.toggle("is-downloaded", saved);
  $("#download-current").title = saved
    ? "已下载到本机，可在「本地」中找到"
    : current?.source === "qq"
      ? "下载 QQ 歌曲最高可用音质"
      : "下载网易云歌曲最高可用音质";
}
function updateFavorite() {
  updateDownloadButton();
  $("#now-fav").toggleAttribute("disabled", !current || transient(current));
  $("#now-fav").classList.toggle(
    "is-favorite",
    !!current && favorites.some((s) => songKey(s) === songKey(current)),
  );
}
function updateTransport() {
  const playing = preparingPlayback ? resumeAfterLoad : !audio.paused;
  if ($("#toggle").dataset.playing !== String(playing)) {
    $("#toggle").innerHTML = icon(playing ? "Pause" : "Play");
    $("#toggle").dataset.playing = String(playing);
    animateContent($("#toggle svg"), {
      distance: 0,
      scaleFrom: 0.84,
      duration: MOTION.t1,
      from: 0,
      easing: MOTION.enter,
    });
  }
  $("#toggle").setAttribute("aria-label", playing ? "暂停" : "播放");
  document.body.classList.toggle("playing", playing);
  playback.refresh();
}
function updateNow(song: Song) {
  // Cover and title change together, in the direction the queue moved, so the
  // pair reads as one object being replaced rather than two separate edits.
  const dir = trackDirection;
  trackDirection = 0;
  updateCover(song.cover || "", `${song.album || song.name} 封面`, dir);
  $("#now-name").textContent = song.name;
  $("#lyrics-title").textContent = song.name;
  // Each artist is a way to their page, like in the lists.
  const credit = `${sourceName(song)} · ${transient(song) ? esc(song.artist) : artistLinks(song) || esc(song.artist)}`;
  $("#lyrics-artist").innerHTML = credit;
  $("#now-name").title = song.name;
  $("#now-artist").innerHTML = credit;
  animateContent($(".now-heading"), {
    axis: "x",
    direction: dir || 1,
    distance: dir ? 8 : 0,
    duration: MOTION.t3,
    from: 0.35,
    easing: MOTION.move,
  });
  updateFavorite();
  playback.refresh();
  broadcast(true);
  lastLyricKey = "";
}
function renderLyrics(markup: string) {
  const box = $("#lyrics");
  box.innerHTML = markup;
  box.inert = false;
  box.setAttribute("aria-busy", "false");
  lyricFollower.reset();
  // Start from the same 0.55 that marks the pane busy, so the resolution of
  // "loading lyrics" is actually visible instead of being swallowed.
  if (!box.hidden)
    animateContent(box, { distance: 0, duration: MOTION.t3, from: 0.55 });
}
let preparingPlayback = false;
async function play(
  song: Song,
  replaceQueue?: Song[],
  resumeAt = 0,
  shouldResume = true,
  fromHistory = false,
  playlistContext?: Playlist,
  preserveNavigation = false,
) {
  const serial = ++playSerial;
  resumeAfterLoad = shouldResume;
  preparingPlayback = true;
  // A crossfade already set the incoming fade; anything else starts at full.
  if (!crossfading) sound.resetFade();
  crossfading = false;
  prefetchKey = "";
  warm.removeAttribute("src");
  playlistToRemember = playlistContext
    ? {
        item: playlistContext,
        serial,
        account: accountKey(playlistContext.source || "netease"),
      }
    : preserveNavigation && playlistToRemember
      ? { ...playlistToRemember, serial }
      : undefined;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  updateTransport();
  const sameSong = songKey(current) === songKey(song);
  if (replaceQueue) {
    queueFillSerial++;
    queueExpected = 0;
    playbackQueue.replace(replaceQueue);
  }
  if (!preserveNavigation && !playbackQueue.start(song, { fromHistory })) {
    systemMedia.clear();
    preparingPlayback = false;
    return;
  }
  current = song;
  pendingSeek = resumeAt;
  resumePosition = undefined;
  // Session-only files cannot be reopened after a restart; skip those.
  if (transient(song)) saveSession({ song: undefined, position: 0 });
  else saveSession({ song: storable(song), position: Math.floor(resumeAt) });
  if (!sameSong) lyrics = [];
  activeLine = -1;
  trialStart = 0;
  syncAudioLoop();
  systemMedia.select(song);
  save();
  if (view === "queue") renderSongs();
  else syncRows();
  if (!sameSong) updateNow(song);
  $("#quality").toggleAttribute("disabled", localSong(song));
  $("#track-tag").textContent = "正在准备播放…";
  if (!sameSong) {
    const box = $("#lyrics");
    box.inert = true;
    box.setAttribute("aria-busy", "true");
    if (!box.querySelector("[data-line]"))
      box.innerHTML = '<p class="lyric-placeholder">正在寻找歌词…</p>';
  }
  ($("#seek") as HTMLInputElement).disabled = true;
  $("#elapsed").textContent = $("#duration").textContent = "0:00";
  ($("#seek") as HTMLInputElement).value = "0";
  paintRange($("#seek") as HTMLInputElement);
  try {
    let url = song.localUrl;
    if (song.localPath) {
      // Re-read the library entry: the file may have moved since this copy
      // of the song was queued.
      const fresh = localByKey(songKey(song));
      url = fresh?.localUrl;
      if (!url) {
        toast("本地文件已不存在，无法播放");
        $("#track-tag").textContent = "文件丢失";
        preparingPlayback = false;
        return;
      }
    }
    // A song downloaded earlier plays from disk: offline, and no stream to fetch.
    const copy = url ? undefined : downloadedCopy(song);
    if (copy?.localUrl) {
      url = copy.localUrl;
      $("#track-tag").textContent = "已下载 · 离线播放";
    } else if (!url) {
      const early =
        prefetched?.key === songKey(song) &&
        prefetched.level === quality &&
        Date.now() - prefetched.at < 4 * 60_000
          ? prefetched.data
          : undefined;
      prefetched = undefined;
      const data =
        early ||
        (await cloud<Playback>(
          "song_url",
          { id: song.id, mid: song.mid, level: quality },
          song.source,
        ));
      if (serial !== playSerial) return;
      url = data.url;
      trialStart = data.trialStart;
      const actual = actualQualityNames[data.level] || data.level || "标准";
      $("#track-tag").textContent = data.trial
        ? "试听片段 · 当前账号权限"
        : `${actual}${data.bitrate ? " · " + Math.round(data.bitrate / 1000) + " kbps" : ""}${data.format ? " · " + data.format.toUpperCase() : ""}`;
      if (quality !== "best" && data.level && data.level !== quality)
        toast(
          `已请求${qualityNames[quality]}，${sourceName(song)}实际提供${actual}音质`,
        );
    } else $("#track-tag").textContent = "本地音频 · 离线可听";
    sound.prepare();
    sound.setTrackGain(song.gain ?? copy?.gain);
    audio.src = url;
    audio.load();
    const playPromise = resumeAfterLoad ? audio.play() : Promise.resolve();
    if (!sameSong || !lyrics.length)
      void (
        localSong(song)
          ? localLyric(localByKey(songKey(song)) || song)
          : cloud<string>("song_lyric", { id: song.id }, song.source).catch(
              async (e) => {
                // Offline, the downloaded copy's own lyrics still answer.
                const text = copy ? await localLyric(copy) : "";
                if (text) return text;
                throw e;
              },
            )
      )
        .then((text) => {
          if (serial !== playSerial) return;
          lyrics = parseLyrics(text);
          renderLyrics(
            lyrics.length
              ? lyrics
                  .map((l, i) => `<p data-line="${i}">${esc(l.text)}</p>`)
                  .join("")
              : localSong(song)
                ? '<p class="lyric-placeholder">本地音乐<br>享受没有文字的片刻。</p>'
                : '<p class="lyric-placeholder">暂无歌词，让旋律说话。</p>',
          );
          lyricFollower.sync(
            lyricIndex(lyrics, audio.currentTime + trialStart),
            true,
            true,
          );
        })
        .catch(() => {
          if (serial === playSerial)
            renderLyrics(
              '<p class="lyric-placeholder">歌词暂不可用<br>音乐依然继续。</p>',
            );
        });
    await playPromise;
    if (serial !== playSerial) return;
    updateTransport();
  } catch (e) {
    if (serial !== playSerial) return;
    // A user pause may interrupt the pending HTMLMediaElement.play promise.
    if (e instanceof DOMException && e.name === "AbortError") {
      updateTransport();
      return;
    }
    // iOS can require a fresh user gesture after an async URL request. Keep
    // the selected song so a second tap restores the same system media session.
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      resumeAfterLoad = false;
      updateTransport();
      toast("轻点播放按钮继续播放");
      return;
    }
    systemMedia.clear();
    $("#track-tag").textContent = "播放未成功";
    if (!audio.getAttribute("src") && !lyrics.length)
      renderLyrics(
        '<p class="lyric-placeholder">可以换一首歌，<br>或导入本地音频。</p>',
      );
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    if (serial === playSerial) {
      preparingPlayback = false;
      updateTransport();
      if (!$("#lyrics").inert)
        lyricFollower.sync(lyricIndex(lyrics, audio.currentTime + trialStart));
    }
  }
}
function skip(delta: number, automatic = false, shouldResume = true) {
  trackDirection = delta > 0 ? 1 : -1;
  const next = playbackQueue.next(delta, playbackMode, automatic);
  if (next?.restart) audio.currentTime = 0;
  else if (next?.song)
    void play(next.song, undefined, 0, shouldResume, next.fromHistory);
  else updateTransport();
}
function syncAudioLoop() {
  audio.loop =
    playbackMode === "repeat" &&
    playbackQueue.songs.some((song) => songKey(song) === songKey(current));
}
function renderPlaybackMode() {
  const names = {
    sequence: "顺序播放",
    shuffle: "随机播放",
    repeat: "单曲循环",
  };
  const icons = {
    sequence: "ListOrdered",
    shuffle: "Shuffle",
    repeat: "Repeat1",
  };
  syncAudioLoop();
  if ($("#repeat").dataset.mode !== playbackMode) {
    $("#repeat").innerHTML = icon(icons[playbackMode]);
    $("#repeat").dataset.mode = playbackMode;
    animateContent($("#repeat svg"), {
      distance: 0,
      scaleFrom: 0.84,
      duration: MOTION.t1,
      from: 0,
      easing: MOTION.enter,
    });
  }
  $("#repeat").setAttribute("aria-label", `播放模式：${names[playbackMode]}`);
  $("#repeat").title = `${names[playbackMode]} · 点击切换`;
  $("#repeat").classList.toggle("active", playbackMode !== "sequence");
  $("#mode-label").textContent = names[playbackMode];
}

function toggle() {
  if (!current) {
    if (list().length) playSelection(list()[0]);
    return;
  }
  if (preparingPlayback) {
    resumeAfterLoad = !resumeAfterLoad;
    if (!resumeAfterLoad) audio.pause();
    updateTransport();
    return;
  }
  resumeAfterLoad = audio.paused;
  if (audio.paused) {
    if (!audio.getAttribute("src"))
      void play(current, undefined, resumePosition ?? 0);
    else {
      if (current && !systemMedia.active) systemMedia.select(current);
      void audio.play().catch(() => toast("播放失败，请重新选择歌曲"));
    }
  } else audio.pause();
}
async function importLibrary() {
  let added: Song[];
  try {
    added = await importLocals();
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
    return;
  }
  locals = localSongs();
  setView("local");
  if (added.length) toast(`已加入本地音乐库 ${added.length} 首`);
  else if (locals.length) toast("没有新增的音乐文件");
}
function pickLocalFiles() {
  if (isTauri() && !mobileDevice) void importLibrary();
  else ($("#file-input") as HTMLInputElement).click();
}
async function importLocalFolder() {
  try {
    const { folder, added } = await importFolder();
    if (!folder) return;
    locals = localSongs();
    setView("local");
    toast(
      added.length
        ? `已加入本地音乐库 ${added.length} 首 · 以后启动会自动发现这个文件夹里的新歌`
        : "这个文件夹里没有新的音乐文件",
    );
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}
/** Finds new downloads and remembered-folder files; quiet when nothing is new. */
async function discoverLocals(announce = true) {
  try {
    const added = await scanLocals();
    if (!added.length) return;
    locals = localSongs();
    // Rows elsewhere gain their "已下载" mark, so every list re-renders.
    renderSongs();
    updateDownloadButton();
    if (announce) toast(`已把 ${added.length} 首下载或新增的歌曲加入本地音乐`);
  } catch {
    /* A folder that went away is not worth an error at startup. */
  }
}
function isAudioFile(file: File) {
  return (
    file.type.startsWith("audio/") ||
    /\.(mp3|flac|m4a|wav|ogg|opus|aac|aiff?)$/i.test(file.name)
  );
}
function importFiles(files: FileList | null) {
  if (!files) return;
  if (isTauri()) {
    void storeFiles(Array.from(files).filter(isAudioFile));
    return;
  }
  const imported: Song[] = [];
  for (const file of Array.from(files)) {
    if (
      !file.type.startsWith("audio/") &&
      !/\.(mp3|flac|m4a|wav|ogg|aac)$/i.test(file.name)
    )
      continue;
    imported.push({
      id: -(Date.now() + locals.length + imported.length),
      name: file.name.replace(/\.[^.]+$/, ""),
      artist: "本地音乐",
      album: "从此设备导入",
      cover: "",
      duration: 0,
      fee: 0,
      localUrl: URL.createObjectURL(file),
    });
  }
  locals.push(...imported);
  setView("local");
  toast(
    imported.length
      ? `已导入 ${imported.length} 首音乐 · 关闭应用后需重新选择文件`
      : "请选择支持的音频文件",
  );
}
/** Phones copy each pick into the app, so it is still there after a restart. */
async function storeFiles(files: File[]) {
  if (!files.length) {
    toast("请选择支持的音频文件");
    return;
  }
  let done = 0;
  setView("local");
  for (const file of files) {
    toast(`正在导入 ${done + 1}/${files.length}：${file.name}`);
    try {
      await storeFile(file);
      done++;
    } catch (e) {
      toast(
        `${file.name} 导入失败：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    locals = localSongs();
    renderSongs();
  }
  if (done) toast(`已导入 ${done} 首音乐，已保存在应用内，重启后仍在`);
}
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (mobileDevice) $("#search").blur();
  void search(($("#search") as HTMLInputElement).value);
});
document.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const nav = el.closest<HTMLElement>("[data-view]");
  if (nav) {
    if (nav.dataset.view === view) return;
    if (nav.dataset.view === "playlists" && !playlistsLoaded)
      void loadPlaylists();
    else setView(nav.dataset.view as View);
    return;
  }
  const filter = el.closest<HTMLElement>("[data-playlist-filter]");
  if (filter) {
    if (playlistFilter === filter.dataset.playlistFilter) return;
    playlistFilter = filter.dataset.playlistFilter as PlaylistFilter;
    try {
      localStorage.setItem("ting.playlist-filter", playlistFilter);
    } catch {}
    renderSongs();
    animateContent($("#playlist-grid"), { distance: 6 });
    $(".main-scroll").scrollTop = 0;
    return;
  }
  const queueTabButton = el.closest<HTMLElement>("[data-queue-tab]");
  if (queueTabButton) {
    const tab = queueTabButton.dataset.queueTab as typeof queueTab;
    if (tab === queueTab) return;
    queueTab = tab;
    listFilter = "";
    document
      .querySelectorAll<HTMLElement>("[data-queue-tab]")
      .forEach((b) =>
        b.setAttribute("aria-selected", String(b.dataset.queueTab === tab)),
      );
    renderSongs();
    animateContent($(".library"), { distance: 5, duration: MOTION.t2 });
    return;
  }
  const localTabButton = el.closest<HTMLElement>("[data-local-tab]");
  if (localTabButton) {
    const tab = localTabButton.dataset.localTab as typeof localTab;
    if (tab === localTab) return;
    localTab = tab;
    document
      .querySelectorAll<HTMLElement>("[data-local-tab]")
      .forEach((b) =>
        b.setAttribute("aria-selected", String(b.dataset.localTab === tab)),
      );
    renderSongs();
    animateContent($(".library"), { distance: 5, duration: MOTION.t2 });
    return;
  }
  const kindTab = el.closest<HTMLElement>("[data-search-kind]");
  if (kindTab) {
    setSearchKind(kindTab.dataset.searchKind as SearchKind);
    return;
  }
  const artistTab = el.closest<HTMLElement>("[data-artist-tab]");
  if (artistTab) {
    setArtistTab(artistTab.dataset.artistTab as ArtistState["tab"]);
    return;
  }
  const card = el.closest<HTMLElement>("[data-card]");
  if (card) {
    const item = gridCards[Number(card.dataset.card)];
    if (item) openCard(item);
    return;
  }
  if (el.closest("[data-best-match]")) {
    if (bestMatch) openCard(bestMatch);
    return;
  }
  const brief = el.closest<HTMLElement>("[data-toggle-brief]");
  if (brief) {
    const text = brief.previousElementSibling as HTMLElement | null;
    if (text) {
      const clamped = text.dataset.clamped === "true";
      text.dataset.clamped = String(!clamped);
      brief.textContent = clamped ? "收起" : "展开";
    }
    return;
  }
  // Artist / album names inside a row, the player and the lyrics header.
  const metaLink = el.closest<HTMLElement>(
    "[data-artist-link],[data-album-link],[data-album-artist]",
  );
  if (metaLink) {
    if (metaLink.hasAttribute("data-album-artist")) {
      const album = albumState?.page?.album;
      if (!album) return;
      const index = Number(metaLink.dataset.albumArtist);
      const name = metaLink.textContent || "";
      void openArtist({
        source: album.source,
        // Only the album's lead artist comes with an id; others resolve by name.
        id: index === 0 ? album.artistId : 0,
        mid: index === 0 ? album.artistMid : undefined,
        name,
      });
      return;
    }
    const row = metaLink.closest<HTMLElement>("[data-song]");
    const song = row
      ? list().find((s) => songKey(s) === row.dataset.song)
      : current;
    if (!song) return;
    if (metaLink.hasAttribute("data-artist-link")) {
      const ref = artistRefs(song)[Number(metaLink.dataset.artistLink)];
      if (ref) void openArtist(ref);
    } else {
      const ref = albumRef(song);
      if (ref) void openAlbum(ref);
    }
    return;
  }
  const playlistButton = el.closest<HTMLElement>("[data-playlist]");
  if (playlistButton) {
    const item = displayedPlaylists().find(
      (p) => playlistKey(p) === playlistButton.dataset.playlist,
    );
    if (item) void loadPlaylist(item);
    return;
  }
  if (el.closest("#playlist-login")) {
    if (playlistFilter === "qq" || playlistFilter === "netease")
      chooseAccount(playlistFilter);
    void openAccount();
    return;
  }
  if (el.closest("#playlist-retry")) {
    void loadPlaylists();
    return;
  }
  const chip = el.closest<HTMLElement>("[data-query]");
  if (chip) {
    void search(chip.dataset.query!);
    return;
  }
  const menu = el.closest<HTMLElement>("[data-song-menu]");
  if (menu) {
    const song = list().find((s) => songKey(s) === menu.dataset.songMenu);
    if (song) library.songMenu(song);
    return;
  }
  const action = el.closest<HTMLElement>(
    "[data-favorite],[data-enqueue],[data-remove]",
  );
  if (action) {
    const id =
      action.dataset.favorite ??
      action.dataset.enqueue ??
      action.dataset.remove;
    const song = list().find((s) => songKey(s) === id);
    if (!song) return;
    if (action.hasAttribute("data-favorite")) toggleFavorite(song);
    else if (action.hasAttribute("data-remove")) {
      queueFillSerial++;
      queueExpected = 0;
      playbackQueue.remove(id);
      syncAudioLoop();
      save();
      renderSongs();
    } else {
      queueFillSerial++;
      queueExpected = 0;
      playbackQueue.append([song]);
      save();
      renderSongs();
      toast("已加入播放队列");
    }
    return;
  }
  const row = el.closest<HTMLElement>("[data-song]");
  // Picking several: a tick instead of select / play. On desktop, Cmd/Ctrl
  // or Shift with a click starts picking straight away.
  if (
    row &&
    (selecting || (!mobileDevice && (e.metaKey || e.ctrlKey || e.shiftKey))) &&
    !showsCards()
  ) {
    if (!selecting) {
      selecting = true;
      if (e.shiftKey && selectedSongId) selectionAnchor = selectedSongId;
    }
    toggleSelected(row.dataset.song!, e.shiftKey);
    return;
  }
  if (row) {
    const song = list().find((s) => songKey(s) === row.dataset.song!);
    if (song) {
      selectSong(songKey(song));
      if (mobileDevice && e.detail < 2) {
        if (current && songKey(current) === songKey(song)) {
          // A second tap must not restart a track or duplicate an in-flight request.
          if (!preparingPlayback && audio.paused) toggle();
        } else playSelection(song);
      }
    }
  }
  if (el.closest("#empty-back")) {
    goBack();
    return;
  }
  if (el.closest("#empty-import")) pickLocalFiles();
});
document.addEventListener("dblclick", (e) => {
  if (mobileDevice) return;
  const el = e.target as HTMLElement;
  if (selecting || el.closest(".row-actions,.meta-link")) return;
  const row = el.closest<HTMLElement>("[data-song]");
  const song = row && list().find((s) => songKey(s) === row.dataset.song!);
  if (song) {
    e.preventDefault();
    selectSong(songKey(song));
    playSelection(song);
  }
});
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    setView("discover");
    $("#search").focus();
    return;
  }
  const target = e.target as HTMLElement;
  if (
    e.key === "Enter" &&
    !e.repeat &&
    target.matches(".song-row,.song-title")
  ) {
    e.preventDefault();
    const row = target.closest<HTMLElement>("[data-song]");
    const song = row && list().find((s) => songKey(s) === row.dataset.song!);
    if (song) {
      selectSong(songKey(song));
      playSelection(song);
    }
    return;
  }
  if (e.key === "Escape" && selecting) {
    e.preventDefault();
    setSelecting(false);
    return;
  }
  // The lyrics panel owns Escape while open; only the detail view goes back.
  // Text fields keep Escape for themselves, but a focused button must not
  // swallow it: opening a playlist leaves focus on its card.
  if (
    e.key === "Escape" &&
    isDetail(view) &&
    $("#lyrics-panel").hidden &&
    !(e.target as HTMLElement).matches("input,textarea,select")
  ) {
    e.preventDefault();
    goBack();
    return;
  }
  if ((e.target as HTMLElement).matches("input,textarea,button,select")) return;
  if (e.code === "Space") {
    e.preventDefault();
    toggle();
  }
});
$(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  if (view !== "discover") setView("discover");
});
$("#import-top").onclick = pickLocalFiles;
$("#import-folder").onclick = () => void importLocalFolder();
// Drag and drop within the queue: the drop lands before or after the row
// under the pointer, whichever half it is in.
let draggedKey = "";
$("#songs").addEventListener("dragstart", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(
    ".song-row[draggable=true]",
  );
  if (!row) return;
  draggedKey = row.dataset.song!;
  e.dataTransfer?.setData("text/plain", draggedKey);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  row.classList.add("dragging");
});
function clearDropMarks() {
  document
    .querySelectorAll(".drop-before,.drop-after,.dragging")
    .forEach((n) =>
      n.classList.remove("drop-before", "drop-after", "dragging"),
    );
}
$("#songs").addEventListener("dragover", (e) => {
  if (!draggedKey) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>(".song-row");
  if (!row || row.dataset.song === draggedKey) return;
  e.preventDefault();
  const rect = row.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  document
    .querySelectorAll(".drop-before,.drop-after")
    .forEach(
      (n) => n !== row && n.classList.remove("drop-before", "drop-after"),
    );
  row.classList.toggle("drop-after", after);
  row.classList.toggle("drop-before", !after);
});
$("#songs").addEventListener("drop", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".song-row");
  const key = draggedKey;
  if (!row || !key) return;
  e.preventDefault();
  const after = row.classList.contains("drop-after");
  clearDropMarks();
  draggedKey = "";
  const songs = playbackQueue.songs.filter((s) => songKey(s) !== key);
  const target = songs.findIndex((s) => songKey(s) === row.dataset.song);
  if (target < 0) return;
  playbackQueue.move(key, target + (after ? 1 : 0));
  save();
  renderSongs();
});
$("#songs").addEventListener("dragend", () => {
  draggedKey = "";
  clearDropMarks();
});
$("#select-mode").onclick = () => setSelecting(!selecting);
$("#selection-bar").addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-sel]")
    ?.dataset.sel;
  if (!action) return;
  const songs = selectedSongs();
  switch (action) {
    case "all": {
      const keys = list().map(songKey);
      const all = keys.every((k) => selection.has(k));
      keys.forEach((k) => (all ? selection.delete(k) : selection.add(k)));
      return syncRows();
    }
    case "done":
      return setSelecting(false);
    case "next":
      queueFillSerial++;
      queueExpected = 0;
      playbackQueue.playNext(songs.filter((s) => !s.missing));
      save();
      toast(`${songs.length} 首将接在当前歌曲之后播放`);
      break;
    case "queue":
      queueFillSerial++;
      queueExpected = 0;
      playbackQueue.append(songs.filter((s) => !s.missing));
      save();
      toast(`已加入播放队列 ${songs.length} 首`);
      break;
    case "playlist":
      void library.chooseMany(songs.filter((s) => !transient(s)));
      break;
    case "favorite": {
      const next = [
        ...songs.filter(
          (s) =>
            !transient(s) && !favorites.some((f) => songKey(f) === songKey(s)),
        ),
        ...favorites,
      ];
      try {
        setFavoriteSongs(next);
        favorites = favoriteSongs();
        toast(`已收藏 ${songs.length} 首`);
      } catch {
        toast("本地存储空间不足，收藏修改未保存");
      }
      break;
    }
    case "download": {
      const added = downloadQueue.enqueue(songs);
      if (added) toast(`已加入下载队列 ${added} 首`);
      break;
    }
    case "remove":
      queueFillSerial++;
      queueExpected = 0;
      songs.forEach((s) => playbackQueue.remove(songKey(s)));
      syncAudioLoop();
      save();
      toast(`已移出队列 ${songs.length} 首`);
      break;
  }
  setSelecting(false);
  renderSongs();
});
$("#clear-list").onclick = () => {
  if (queueTab === "history") {
    playHistory = [];
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {}
    toast("已清空最近播放");
  } else {
    queueFillSerial++;
    queueExpected = 0;
    playbackQueue.clear();
    syncAudioLoop();
    save();
    toast(current ? "已清空播放队列，正在播放的歌曲保留" : "已清空播放队列");
  }
  renderSongs();
};
$("#file-input").onchange = () => {
  importFiles(($("#file-input") as HTMLInputElement).files);
  ($("#file-input") as HTMLInputElement).value = "";
};
$("#play-all").onclick = () => void playAll();
$("#back-button").onclick = goBack;
$("#refresh-playlists").onclick = () => void loadPlaylists();
$("#more").onclick = () => {
  if (view === "playlists") void loadPlaylists(true);
  else if (view === "playlist" && selectedPlaylist)
    void loadPlaylist(selectedPlaylist, true);
  else if (view === "artist") void loadArtistAlbumPage(true);
  else void search(query, true);
};
$("#enqueue-all").onclick = () => {
  const songs = list().filter((s) => !s.missing);
  if (!songs.length) return;
  queueFillSerial++;
  queueExpected = 0;
  playbackQueue.append(songs);
  save();
  syncRows();
  toast(`已加入播放队列 ${songs.length} 首`);
};
$("#list-filter").addEventListener("input", () => {
  listFilter = ($("#list-filter") as HTMLInputElement).value;
  suppressRowStagger = true;
  renderSongs();
  void loadWholePlaylist();
});
$("#list-sort").addEventListener("change", () => {
  listSorts.set(view, ($("#list-sort") as HTMLSelectElement).value);
  suppressRowStagger = true;
  renderSongs();
  animateContent($("#songs"), { distance: 4, duration: MOTION.t2 });
  void loadWholePlaylist();
});
$("#copy-playlist").onclick = () => void copyPlaylist();
$("#toggle").onclick = toggle;
$("#previous").onclick = () => skip(-1);
$("#next").onclick = () => skip(1);
$("#now-fav").onclick = () => {
  if (current) toggleFavorite(current);
};
$("#repeat").onclick = () => {
  playbackMode =
    playbackMode === "sequence"
      ? "shuffle"
      : playbackMode === "shuffle"
        ? "repeat"
        : "sequence";
  playbackQueue.resetShuffle();
  if (!writeSetting("ting.playbackMode", playbackMode))
    toast("播放模式未保存，本地存储不可用");
  renderPlaybackMode();
};
$("#volume").oninput = () => {
  sound.setVolume(Number(($("#volume") as HTMLInputElement).value));
  audio.muted = false;
  updateVolume();
};
$("#mute").onclick = () => {
  audio.muted = !audio.muted;
  updateVolume();
};
let seekDragging = false;
const seekSlider = $("#seek") as HTMLInputElement;
seekSlider.addEventListener("pointerdown", () => {
  seekDragging = true;
});
seekSlider.oninput = () => {
  // Keyboard input arrives without a pointerdown; mark the drag either way.
  seekDragging = true;
  if (Number.isFinite(audio.duration))
    audio.currentTime = Number(seekSlider.value);
};
const finishSeek = () => {
  if (!seekDragging) return;
  seekDragging = false;
  // Commit the final position once so the thumb and audio agree.
  if (Number.isFinite(audio.duration))
    audio.currentTime = Number(seekSlider.value);
};
seekSlider.addEventListener("change", finishSeek);
seekSlider.addEventListener("pointerup", finishSeek);
seekSlider.addEventListener("pointercancel", finishSeek);
seekSlider.addEventListener("lostpointercapture", finishSeek);
audio.addEventListener("playing", () => {
  if (current && historySerial !== playSerial) {
    historySerial = playSerial;
    recordHistory(current);
  }
  const pending = playlistToRemember;
  if (!pending || pending.serial !== playSerial) return;
  playlistToRemember = undefined;
  if (
    !pending.item.internal &&
    pending.account !== accountKey(pending.item.source || "netease")
  )
    return;
  try {
    rememberPlaylist(pending.item, pending.account);
  } catch {
    toast("最近播放记录未保存，本地空间可能不足");
  }
  if (view === "playlists") renderSongs();
});
function updateVolume() {
  // The slider is the listener's volume; fades and loudness never move it.
  const slider = $("#volume") as HTMLInputElement;
  if (slider.value !== String(sound.volume)) {
    slider.value = String(sound.volume);
    paintRange(slider);
  }
  $("#mute").setAttribute("aria-label", audio.muted ? "取消静音" : "静音");
  const button = $("#mute");
  const glyph = audio.muted || !sound.volume ? "VolumeX" : "Volume2";
  if (button.dataset.icon !== glyph) {
    button.dataset.icon = glyph;
    button.innerHTML = icon(glyph);
    animateContent(button.querySelector("svg")!, {
      distance: 0,
      scaleFrom: 0.84,
      duration: MOTION.t1,
      from: 0,
      easing: MOTION.enter,
    });
  }
}
audio.addEventListener("volumechange", updateVolume);
let mediaErrorShown = "degraded" in mediaBackend && mediaBackend.degraded;
if (mediaErrorShown) toast("系统媒体控制暂不可用，可继续使用应用内播放按钮");
window.addEventListener("system-media-error", () => {
  if (!mediaErrorShown) {
    mediaErrorShown = true;
    toast("系统媒体控制暂不可用，可继续使用应用内播放按钮");
  }
});
audio.addEventListener("play", updateTransport);
audio.addEventListener("pause", updateTransport);
audio.addEventListener("loadedmetadata", () => {
  if (!Number.isFinite(audio.duration)) return;
  const seek = $("#seek") as HTMLInputElement;
  seek.max = String(audio.duration);
  paintRange(seek);
  seek.disabled = false;
  $("#duration").textContent = formatTime(audio.duration);
  if (pendingSeek !== null) {
    audio.currentTime = Math.min(
      pendingSeek,
      Math.max(0, audio.duration - 0.1),
    );
    pendingSeek = null;
  }
  if (!resumeAfterLoad) audio.pause();
  updateTransport();
  if (current?.localUrl && !current.duration) {
    current.duration = audio.duration * 1000;
    renderSongs();
  }
});
audio.addEventListener("timeupdate", () => {
  const elapsed = formatTime(audio.currentTime);
  if ($("#elapsed").textContent !== elapsed)
    $("#elapsed").textContent = elapsed;
  if (!seekDragging)
    ($("#seek") as HTMLInputElement).value = String(audio.currentTime);
  if (!seekDragging) paintRange($("#seek") as HTMLInputElement);
  const index = lyricIndex(lyrics, audio.currentTime + trialStart);
  activeLine = index;
  if (!preparingPlayback && !$("#lyrics").inert)
    lyricFollower.sync(index, audio.seeking);
  if (!sessionTimer)
    sessionTimer = window.setTimeout(() => {
      sessionTimer = 0;
      savePosition();
    }, 5000);
  const remaining = audio.duration - audio.currentTime;
  if (!Number.isFinite(remaining) || preparingPlayback || audio.paused) return;
  // Ahead of the change, but not before the listener has settled on this song.
  if (remaining < 25 && audio.currentTime >= 3) void prefetchNext();
  const fade = sound.crossfade;
  if (
    fade > 0 &&
    !crossfading &&
    remaining <= fade &&
    remaining > 0.3 &&
    playbackMode !== "repeat" &&
    !soundPanel.armedForTrackEnd
  ) {
    const next = playbackQueue.peek(1, playbackMode, true);
    if (next?.song && !next.restart) {
      // The outgoing song finishes on a second element while the next fades in.
      crossfading = true;
      sound.playTail(audio.currentSrc, audio.currentTime);
      sound.fadeIn(fade);
      skip(1, true);
    }
  }
});
async function prefetchNext() {
  const next = playbackQueue.peek(1, playbackMode, true);
  const song = next?.song;
  if (!song || next.restart) return;
  const key = songKey(song);
  if (prefetchKey === key) return;
  prefetchKey = key;
  if (localSong(song) || downloadedCopy(song)) return;
  try {
    const level = quality;
    const data = await cloud<Playback>(
      "song_url",
      { id: song.id, mid: song.mid, level },
      song.source,
    );
    if (prefetchKey !== key) return;
    prefetched = { key, level, data, at: Date.now() };
    // Warm the cache with the opening seconds of the next song.
    if (!data.trial) {
      warm.crossOrigin = audio.crossOrigin;
      warm.src = data.url;
      warm.load();
    }
  } catch {
    /* The song fetches its stream as usual when its turn comes. */
  }
}
audio.addEventListener("pause", savePosition);
audio.addEventListener("seeked", savePosition);
window.addEventListener("pagehide", savePosition);
audio.addEventListener(
  "seeked",
  () =>
    !preparingPlayback &&
    !$("#lyrics").inert &&
    lyricFollower.resume(
      lyricIndex(lyrics, audio.currentTime + trialStart),
      true,
    ),
);
audio.addEventListener("ended", () => {
  // "本曲播完后停止" ends here instead of moving on.
  if (soundPanel.stopAtTrackEnd()) {
    updateTransport();
    return;
  }
  skip(1, true);
});
audio.addEventListener("error", () => {
  if (audio.getAttribute("src")) {
    $("#track-tag").textContent = "音频加载失败";
    toast("音频加载失败，可能已过期或格式不受支持；重新选择歌曲可重试。");
  }
});
window.addEventListener("offline", () => toast("网络已断开，本地音乐仍可播放"));
// iOS has no system back control; the left-edge swipe mirrors the back button.
if (mobileDevice) setupBackGesture(() => isDetail(view), goBack);
setupAccount({
  cloud,
  toast,
  signedIn: () => {
    playlistsLoaded = false;
    void loadPlaylists();
  },
  signedOut: (source) => {
    if (
      current &&
      !localSong(current) &&
      (current.source || "netease") === source
    ) {
      ++playSerial;
      systemMedia.clear();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      $("#track-tag").textContent = "该平台已退出登录";
    }
    playlistsLoaded = false;
    const keep = (s: Song) =>
      localSong(s) || (s.source || "netease") !== source;
    playbackQueue.replace(playbackQueue.songs.filter(keep));
    queueFillSerial++;
    queueExpected = 0;
    if (
      selectedPlaylist &&
      (selectedPlaylist.source || "netease") === source &&
      !selectedPlaylist.internal
    ) {
      playlistSongs = [];
      selectedPlaylist = undefined;
    }
    playlists = playlists.filter(
      (item) => item.internal || (item.source || "netease") !== source,
    );
    // A way back into that platform's private playlists is gone with it.
    backStack = backStack.map((c) =>
      c.view === "playlist" &&
      c.playlist &&
      !c.playlist.internal &&
      (c.playlist.source || "netease") === source
        ? { view: "playlist", scroll: 0 }
        : c,
    );
    save();
  },
  settled: (closed) => {
    if (closed) void loadPlaylists();
    else renderSongs();
  },
});
const soundPanel = setupSoundPanel({
  sound,
  desktop: !mobileDevice,
  audio,
  toast,
  reload: () => {
    // Re-open the same song at the same point so it passes through the EQ.
    if (!current || !audio.getAttribute("src")) return;
    void play(
      current,
      undefined,
      audio.currentTime,
      !audio.paused,
      false,
      undefined,
      true,
    );
  },
  currentGain: () => current?.gain ?? downloadedCopy(current)?.gain,
});
// ---- Desktop windows: mini player, floating lyrics, tray -----------------
const nativeDesktop = isTauri() && !mobileDevice;
let floatOpen = false,
  floatLocked = false,
  stateTimer = 0,
  trayKey = "";
function playerState(): PlayerState {
  return {
    title: current?.name || "",
    artist: current?.artist || "",
    cover: current?.cover || "",
    playing: preparingPlayback ? resumeAfterLoad : !audio.paused,
    position: audio.currentTime || 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0,
    hasSong: !!current,
  };
}
/** Tells the helper windows and the tray what is playing; cheap when idle. */
function broadcast(now = false) {
  if (!nativeDesktop) return;
  const send = () => {
    stateTimer = 0;
    const state = playerState();
    void emit("player-state", state).catch(() => {});
    const key = `${state.title}|${state.artist}|${state.playing}`;
    if (key !== trayKey) {
      trayKey = key;
      void invoke("tray_update", {
        title: state.hasSong ? `${state.title} · ${state.artist}` : "",
        playing: state.playing,
      }).catch(() => {});
    }
  };
  if (now) {
    clearTimeout(stateTimer);
    send();
  } else if (!stateTimer) stateTimer = window.setTimeout(send, 700);
}
let lastLyricKey = "";
function broadcastLyric() {
  if (!floatOpen) return;
  const line: LyricLine = {
    text: lyrics[activeLine]?.text || (current ? current.name : ""),
    next: lyrics[activeLine + 1]?.text || "",
    locked: floatLocked,
  };
  const key = JSON.stringify(line);
  if (key === lastLyricKey) return;
  lastLyricKey = key;
  void emit("lyric-line", line).catch(() => {});
}
async function toggleFloatLyrics() {
  try {
    floatOpen = await invoke<boolean>("float_lyrics", { show: !floatOpen });
    if (!floatOpen) floatLocked = false;
    lastLyricKey = "";
  } catch (e) {
    toast(String(e));
  }
}
function lockFloatLyrics(locked: boolean) {
  floatLocked = locked;
  void invoke("float_lyrics_lock", { locked }).catch((e) => toast(String(e)));
  lastLyricKey = "";
  broadcastLyric();
  if (locked) toast("桌面歌词已锁定，可在托盘菜单或设置中解锁");
}
if (nativeDesktop) {
  audio.addEventListener("play", () => broadcast(true));
  audio.addEventListener("pause", () => broadcast(true));
  audio.addEventListener("timeupdate", () => {
    broadcast();
    broadcastLyric();
  });
  listen<PlayerCommand>("player-command", ({ payload }) => {
    switch (payload) {
      case "toggle":
        return toggle();
      case "previous":
        return skip(-1);
      case "next":
        return skip(1);
      case "volume-up":
      case "volume-down":
        sound.setVolume(
          sound.volume + (payload === "volume-up" ? 0.05 : -0.05),
        );
        audio.muted = false;
        return updateVolume();
      case "lyrics":
        // The tray and shortcut toggle; while locked, the first press unlocks.
        if (floatOpen && floatLocked) return lockFloatLyrics(false);
        return void toggleFloatLyrics();
      case "lyrics-lock":
        return lockFloatLyrics(!floatLocked);
      case "lyrics-closed":
        floatOpen = false;
        floatLocked = false;
        return;
      case "show": {
        const w = getCurrentWindow();
        void w.show().then(() => w.setFocus());
        return;
      }
      case "hello":
        // A helper window just opened: bring it up to date at once.
        lastLyricKey = "";
        broadcast(true);
        return broadcastLyric();
    }
  }).catch(() => {
    /* Without the event bridge the helper windows simply stay idle. */
  });
}
// ---- Backups and diagnostics ------------------------------------------------
function saveInBrowser(name: string, text: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}
async function saveFile(name: string, text: string, what: string) {
  if (!isTauri()) return saveInBrowser(name, text);
  try {
    const path = await invoke<string>("backup_save", { name, content: text });
    if (path) toast(`${what}已保存：${path}`);
  } catch (e) {
    toast(String(e));
  }
}
function pickText(): Promise<string> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve("");
      void file.text().then(resolve, () => resolve(""));
    };
    input.click();
  });
}
async function importBackupFile() {
  try {
    const text = nativeDesktop
      ? await invoke<string>("backup_open")
      : await pickText();
    if (!text) return;
    const result = restoreBackup(text);
    toast(
      `已恢复：新增歌单 ${result.playlists} 个、歌曲 ${result.songs} 首、本地音乐 ${result.locals} 首，正在重新载入…`,
    );
    window.setTimeout(() => location.reload(), 1600);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}
async function exportDiagnostics() {
  let info: unknown = {};
  try {
    info = isTauri() ? await invoke("diagnostics") : {};
  } catch {}
  const report = {
    app: "ting",
    kind: "diagnostics",
    createdAt: new Date().toISOString(),
    info,
    userAgent: navigator.userAgent,
    platform: {
      mobile: mobileDevice,
      mac: platform.mac,
      ios: platform.ios,
      android: platform.android,
    },
    library: {
      favorites: favorites.length,
      locals: locals.length,
      queue: playbackQueue.songs.length,
      playlists: internalPlaylists().length,
      signedIn: signedInSources(),
    },
    sound: {
      normalize: sound.normalize,
      eq: sound.preset,
      crossfade: sound.crossfade,
    },
    recent: recentDiagnostics(),
  };
  await saveFile(
    `ting-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(report, null, 2),
    "诊断信息",
  );
}
let appVersion = "";
if (isTauri())
  void invoke<{ version: string }>("diagnostics")
    .then((d) => (appVersion = d.version))
    .catch(() => {});
setupSettingsPanel({
  toast,
  quality: {
    value: () => quality,
    names: qualityNames,
    set: (value) => {
      const select = $("#quality") as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event("change"));
    },
  },
  openSound: () => soundPanel.open(),
  openTheme: () => $("#theme-button").click(),
  exportBackup: () =>
    saveFile(backupName(), JSON.stringify(createBackup(), null, 1), "备份"),
  importBackup: importBackupFile,
  exportDiagnostics,
  localsChanged: () => {
    locals = localSongs();
    renderSongs();
    updateDownloadButton();
  },
  floatLyrics: {
    open: () => floatOpen,
    toggle: () => void toggleFloatLyrics(),
    locked: () => floatLocked,
    lock: lockFloatLyrics,
  },
  miniPlayer: () => void invoke("mini_player").catch((e) => toast(String(e))),
  version: () => (appVersion ? `版本 ${appVersion}` : "版本信息仅在应用内可见"),
});
renderSongs();
void initialize();

async function initialize() {
  renderPlaybackMode();
  renderAccount();
  ($("#quality") as HTMLSelectElement).value = quality;
  if (startupSession.song && !current) {
    // Show the last track without touching the network; the first play
    // fetches a fresh stream and seeks back to where it stopped.
    const song = startupSession.song;
    if (playbackQueue.start(song)) {
      current = song;
      resumePosition = startupSession.position || 0;
      updateNow(song);
      $("#track-tag").textContent = resumePosition
        ? `上次听到 ${formatTime(resumePosition)}`
        : "上次播放";
      updateTransport();
      updateFavorite();
      updateDownloadButton();
      syncRows();
    }
  }
  void search(query);
  if (!isTauri()) return;
  void restoreLocals().then(async ({ missing }) => {
    locals = localSongs();
    favorites = favoriteSongs();
    if (missing) toast(`有 ${missing} 首本地音乐的文件已找不到`);
    if (view === "local" || view === "favorites") renderSongs();
    else syncRows();
    updateDownloadButton();
    await discoverLocals();
  });
  await restoreAccounts();
  if (view === "playlists") void loadPlaylists();
  else if (view === "discover") await restoreBrowsing();
}
/** Reopen the list that was on screen at the last close, if it still exists. */
async function restoreBrowsing() {
  const { view: last, playlist } = startupSession;
  if (!last) return;
  if (last === "playlist" && playlist) {
    await loadPlaylists();
    const key = playlistKey(playlist);
    const item = playlists.find((p) => playlistKey(p) === key);
    if (item && view === "playlists") await loadPlaylist(item);
    return;
  }
  if (last === "artist" && startupSession.artist) {
    if (view === "discover") await openArtist(startupSession.artist);
    return;
  }
  if (last === "album" && startupSession.album) {
    if (view === "discover") await openAlbum(startupSession.album);
    return;
  }
  if (last === "playlists") await loadPlaylists();
  else if (last === "favorites" || last === "queue" || last === "local") {
    setView(last);
    renderSongs();
  }
}
function displayedPlaylists(): Playlist[] {
  if (playlistFilter === "recent")
    return recentPlaylists(playlists, accountKey);
  return sortPlaylists(
    playlists.filter((p) =>
      playlistFilter === "internal"
        ? p.internal
        : !p.internal && (p.source || "netease") === playlistFilter,
    ),
    accountKey,
  );
}
function renderPlaylists(stagger = true) {
  const box = $("#playlist-grid"),
    items = displayedPlaylists();
  document
    .querySelectorAll<HTMLElement>("[data-playlist-filter]")
    .forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.playlistFilter === playlistFilter),
      ),
    );
  if (
    (playlistFilter === "netease" && !profile("netease")) ||
    (playlistFilter === "qq" && !profile("qq"))
  ) {
    renderState(
      box,
      `<div class="empty-state">${icon("Library")}<h3>登录${sourceName({ source: playlistFilter as Source })}</h3><p>读取你创建和收藏的歌单。</p><button id="playlist-login" class="primary">登录账号</button></div>`,
    );
    return;
  }
  if (
    libraryBusy &&
    !items.length &&
    !["internal", "recent"].includes(playlistFilter)
  ) {
    renderState(box, '<div class="empty-state"><p>正在加载你的歌单…</p></div>');
    return;
  }
  if (!items.length) {
    renderState(
      box,
      playlistFilter === "recent"
        ? '<div class="empty-state"><h3>最近听过的歌单</h3><p>播放歌单后会自动排到这里。<br>切换上方平台，浏览你的全部歌单。</p></div>'
        : playlistFilter === "internal"
          ? '<div class="empty-state"><h3>跨平台收藏在一起</h3><p>点击右上角「＋ 新建」，创建本机混合歌单。</p></div>'
          : '<div class="empty-state"><h3>还没有读取到歌单</h3><button id="playlist-retry" class="outline">重新加载</button></div>',
    );
    return;
  }
  delete box.dataset.state;
  let cards = box.querySelector<HTMLElement>(".playlist-cards");
  if (!cards) {
    cards = document.createElement("div");
    cards.className = "playlist-cards";
    box.replaceChildren(cards);
  }
  const existing = new Map(
    Array.from(cards.querySelectorAll<HTMLElement>(".playlist-card")).map(
      (card) => [card.dataset.playlist!, card],
    ),
  );
  const wanted = new Set(items.map(playlistKey));
  const fresh: HTMLElement[] = [];
  existing.forEach((card, key) => {
    if (!wanted.has(key)) card.remove();
  });
  items.forEach((item, i) => {
    const key = playlistKey(item);
    let card = existing.get(key);
    if (!card) {
      card = document.createElement("button");
      card.className = "playlist-card";
      card.dataset.playlist = key;
      card.innerHTML =
        '<span class="playlist-art"><span class="fallback-cover">♪</span></span><strong></strong><span class="playlist-meta"></span><small></small>';
      fresh.push(card);
    }
    const name = card.querySelector("strong")!;
    if (name.textContent !== item.name) name.textContent = item.name;
    const details = `${playlistLabel(item)} · ${item.trackCount} 首 · ${item.owned ? "我创建的" : "我收藏的"}`;
    const meta = card.querySelector(".playlist-meta")!;
    if (meta.textContent !== details) meta.textContent = details;
    const creator = card.querySelector("small")!;
    if (creator.textContent !== item.creator)
      creator.textContent = item.creator;
    const art = card.querySelector<HTMLElement>(".playlist-art")!;
    const pictures = playlistArt(item);
    const artKey = pictures.join("|");
    if (art.dataset.cover !== artKey) {
      art.dataset.cover = artKey;
      art.classList.toggle("grid", pictures.length === 4);
      art.innerHTML = pictures.length
        ? pictures
            .map(
              (src) =>
                `<img src="${esc(src)}" alt="${esc(item.name)}" loading="lazy" referrerpolicy="no-referrer"/>`,
            )
            .join("")
        : '<span class="fallback-cover">♪</span>';
    }
    if (cards!.children[i] !== card)
      cards!.insertBefore(card, cards!.children[i] ?? null);
  });
  if (stagger && fresh.length) animateArrival(visibleHead(fresh));
}
async function loadPlaylists(append = false) {
  setView("playlists");
  const serial = ++librarySerial;
  if (!signedInSources().length) {
    playlists = internalPlaylists();
    neteasePlaylistsMore = qqPlaylistsMore = false;
    playlistsLoaded = true;
    renderSongs();
    return;
  }
  if (!append) {
    playlists = [
      ...internalPlaylists(),
      ...playlists.filter((p) => !p.internal),
    ];
    playlistsOffset = 0;
    qqPlaylistsOffset = 0;
    neteasePlaylistsMore = !!profile("netease");
    qqPlaylistsMore = !!profile("qq");
  }
  libraryBusy = true;
  renderSongs();
  const errors: string[] = [];
  await Promise.allSettled(
    (["netease", "qq"] as Source[]).map(async (source) => {
      if (append && playlistFilter !== source) return;
      if (
        source === "netease"
          ? !profile("netease") || !neteasePlaylistsMore
          : !profile("qq") || !qqPlaylistsMore
      )
        return;
      try {
        const offset = source === "qq" ? qqPlaylistsOffset : playlistsOffset;
        const data = await cloud<{
          playlists: Playlist[];
          more: boolean;
          nextOffset?: number;
        }>("my_playlists", { offset }, source);
        if (serial !== librarySerial) return;
        const items = data.playlists.map((p) => ({ ...p, source }));
        playlists = [
          ...new Map(
            [
              ...playlists.filter(
                (p) =>
                  append || p.internal || (p.source || "netease") !== source,
              ),
              ...items,
            ].map((p) => [playlistKey(p), p]),
          ).values(),
        ];
        if (source === "qq") {
          qqPlaylistsOffset = data.nextOffset ?? offset + data.playlists.length;
          qqPlaylistsMore = data.more;
        } else {
          playlistsOffset += data.playlists.length;
          neteasePlaylistsMore = data.more && data.playlists.length > 0;
        }
      } catch (e) {
        errors.push(`${sourceName({ source })}：${String(e)}`);
      }
    }),
  );
  if (serial !== librarySerial) return;
  libraryBusy = false;
  playlistsLoaded = !errors.length;
  $("#error").textContent = errors.join("；");
  $("#error").hidden = !errors.length;
  renderSongs();
}
async function loadPlaylist(item: Playlist, append = false) {
  const refreshing =
    view === "playlist" &&
    selectedPlaylist &&
    playlistKey(selectedPlaylist) === playlistKey(item);
  // Every fresh open starts at the top, so the depth left behind by another
  // playlist must not make this content look like somewhere we have been.
  const fresh = !append && !refreshing;
  if (fresh) viewScroll.delete("playlist");
  // A fresh open remembers the page it was entered from (see pushCrumb).
  if (fresh) pushCrumb("playlist");
  selectedPlaylist = item;
  if (item.internal) {
    librarySerial++;
    libraryBusy = false;
    playlistSongs = internalSongs(item);
    playlistTotal = playlistOffset = playlistSongs.length;
    setView("playlist");
    if (fresh) $(".main-scroll").scrollTop = 0;
    return;
  }
  if (!append) {
    if (!refreshing) playlistSongs = [];
    playlistOffset = 0;
    playlistTotal = item.trackCount;
  }
  setView("playlist");
  if (fresh) $(".main-scroll").scrollTop = 0;
  const serial = ++librarySerial;
  libraryBusy = true;
  renderSongs();
  try {
    const data = await cloud<{
      songs: Song[];
      total: number;
      nextOffset: number;
    }>(
      "playlist_tracks",
      { id: item.id, dirid: item.dirid, offset: playlistOffset },
      item.source,
    );
    if (serial !== librarySerial) return;
    const order =
      item.source === "qq" ? localOrder(item, accountKey("qq")) : [];
    let songs = append
      ? uniqueSongs([...playlistSongs, ...data.songs])
      : data.songs;
    let nextOffset = data.nextOffset,
      total = data.total;
    // A saved custom order needs every page before display/playback, not just the first 100.
    while (order.length && nextOffset < total) {
      const page = await cloud<{
        songs: Song[];
        total: number;
        nextOffset: number;
      }>(
        "playlist_tracks",
        { id: item.id, dirid: item.dirid, offset: nextOffset },
        item.source,
      );
      if (serial !== librarySerial) return;
      if (page.nextOffset <= nextOffset)
        throw new Error("未能加载完整歌单，无法应用本机顺序");
      songs = uniqueSongs([...songs, ...page.songs]);
      nextOffset = page.nextOffset;
      total = page.total;
    }
    playlistSongs = applyOrder(songs, order);
    playlistTotal = total;
    playlistOffset = nextOffset;
  } catch (e) {
    if (serial !== librarySerial) return;
    $("#error").textContent = String(e);
    $("#error").hidden = false;
  } finally {
    if (serial === librarySerial) {
      libraryBusy = false;
      renderSongs();
    }
  }
}
$("#search-source").onchange = () => {
  searchSource = ($("#search-source") as HTMLSelectElement)
    .value as SearchSource;
  void search(($("#search") as HTMLInputElement).value || query);
};
$("#quality").onchange = () => {
  quality = ($("#quality") as HTMLSelectElement).value;
  if (!writeSetting("ting.quality", quality))
    toast("音质偏好未保存，本地存储不可用");
  if (current && !localSong(current)) {
    const position = audio.currentTime,
      playing = !audio.paused;
    void play(current, undefined, position, playing, false, undefined, true);
  } else toast(`播放音质已设为${qualityNames[quality]}`);
};

function playAll() {
  trackDirection = 0;
  if (list().length) playSelection(list()[0]);
}

// Start the selected track immediately; pagination belongs to the queue, not the visible page.
function playSelection(song: Song) {
  // Picking from a list is a jump, not a step, so the cover simply dissolves.
  trackDirection = 0;
  const item = view === "playlist" ? selectedPlaylist : undefined;
  const startOffset = playlistOffset,
    expected = playlistTotal;
  void play(song, view === "queue" ? undefined : list(), 0, true, false, item);
  if (!item || item.internal || startOffset >= expected) return;
  const serial = queueFillSerial;
  queueExpected = expected;
  syncRows();
  toast(`正在补齐歌单队列，共 ${expected} 首`);
  void fillPlaylistQueue(item, startOffset, expected, serial);
}

async function fillPlaylistQueue(
  item: Playlist,
  offset: number,
  total: number,
  serial: number,
) {
  const editVersion = playlistEditVersion;
  try {
    while (offset < total) {
      const data = await cloud<{
        songs: Song[];
        total: number;
        nextOffset: number;
      }>(
        "playlist_tracks",
        { id: item.id, dirid: item.dirid, offset },
        item.source,
      );
      if (serial !== queueFillSerial) return;
      if (data.nextOffset <= offset) throw new Error("歌单分页未能继续");
      offset = data.nextOffset;
      total = data.total;
      queueExpected = total;
      playbackQueue.append(data.songs);
      if (
        editVersion === playlistEditVersion &&
        selectedPlaylist &&
        playlistKey(selectedPlaylist) === playlistKey(item)
      ) {
        playlistSongs = uniqueSongs([...playlistSongs, ...data.songs]);
        playlistOffset = Math.max(playlistOffset, offset);
        playlistTotal = total;
      }
      if (
        view === "queue" ||
        (view === "playlist" &&
          selectedPlaylist &&
          playlistKey(selectedPlaylist) === playlistKey(item))
      )
        renderSongs();
      else syncRows();
    }
    toast(`队列已就绪：${playbackQueue.songs.length} 首`);
  } catch (e) {
    if (serial === queueFillSerial)
      toast(
        `队列暂只加载了 ${playbackQueue.songs.length} 首：${String(e)}。可回歌单点击歌曲重试。`,
      );
  } finally {
    if (serial === queueFillSerial) {
      queueExpected = 0;
      save();
      syncRows();
    }
  }
}

/** "QQ 补源 · 无损 · FLAC · 16bit / 44.1kHz" for one finished download. */
function describeDownload(song: Song, result: DownloadResult) {
  const source =
    result.source === "qq"
      ? song.source === "qq"
        ? "QQ音乐"
        : "QQ 补源"
      : "网易云";
  const level = actualQualityNames[result.level] || result.level;
  const detail = result.bitDepth
    ? `${result.bitDepth}bit / ${result.sampleRate / 1000}kHz`
    : `${Math.round(result.bitrate / 1000)}kbps`;
  return `${source} · ${level} · ${result.format.toUpperCase()} · ${detail}`;
}
const downloadQueue = setupDownloads({
  toast,
  refuse: (song) =>
    transient(song) || localSong(song)
      ? "本地歌曲已在本机，无需下载"
      : downloadedCopy(song)
        ? `「${song.name}」已下载到本机`
        : undefined,
  changed: (song, status, detail) => {
    const mine = !!current && songKey(current) === songKey(song);
    downloading =
      !!current &&
      ["waiting", "active"].includes(downloadQueue?.statusOf(current) || "");
    updateDownloadButton();
    if (!mine) return;
    $("#download-info").hidden = false;
    if (status === "waiting")
      $("#download-status").textContent = `已加入下载队列：${song.name}`;
    else if (status === "active")
      $("#download-status").textContent = `正在获取音源并下载：${song.name}…`;
    else if (status === "done" && detail && typeof detail !== "string") {
      $("#download-status").textContent =
        `已保存 · ${describeDownload(song, detail)}`;
      $("#download-status").title = detail.path;
      toast(
        `${detail.filename} 已保存到${mobileDevice ? downloadLocation : detail.path.replace(/[\\/][^\\/]+$/, "")}${detail.warnings.length ? " · " + detail.warnings.join("；") : ""}`,
      );
    } else if (status === "failed") {
      $("#download-status").textContent = "下载未完成，可点击下载按钮重试";
      toast(String(detail || "下载失败"));
    }
  },
  // Finished files join the local shelf right away (unless turned off).
  saved: () => {
    if (autoImport()) void discoverLocals(false);
  },
});
$("#download-current").onclick = () => {
  if (!current || localSong(current) || downloading) return;
  downloadQueue.enqueue([current]);
};
$("#download-all").onclick = async () => {
  // A paged playlist is downloaded whole, not just the pages seen so far.
  if (view === "playlist" && !(await fetchRestOfPlaylist())) {
    toast("未能读取完整歌单，请稍后重试");
    return;
  }
  const songs = list().filter((s) => !localSong(s) && !downloadedCopy(s));
  if (!songs.length) {
    toast("这里的歌曲都已在本机");
    return;
  }
  const added = downloadQueue.enqueue(songs);
  if (added) toast(`已加入下载队列 ${added} 首，可在右上角查看进度`);
};
if (platform.android) $("#download-folder").textContent = "查看下载";
$("#download-folder").onclick = () => {
  if (platform.ios) toast(`请前往${downloadLocation}查看下载文件`);
  else void invoke("open_download_folder").catch((e) => toast(String(e)));
};
