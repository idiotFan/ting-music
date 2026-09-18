import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  createElement,
  Search,
  Library,
  Heart,
  FolderOpen,
  Music2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ListMusic,
  Plus,
  X,
  ArrowUpRight,
  Disc3,
  Headphones,
  Repeat,
  Shuffle,
  Repeat1,
  Download,
  ListOrdered,
  Check,
  LoaderCircle,
  ChevronRight,
  Ellipsis,
  Palette,
  Cloud,
} from "lucide";
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
import { setupLyrics } from "./lyrics";
import { makeLoginQr, verifyOriginalQr, qrPngForSharing } from "./qr";
import { mountPhoneLogin, type PhoneLoginResult } from "./phone-login";
import { setupMobileViewport } from "./mobile-viewport";
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
  internalPlaylists,
  internalSongs,
  playlistKey,
  playlistLabel,
  localOrder,
  applyOrder,
  rememberPlaylist,
  recentPlaylists,
  sortPlaylists,
  type Source,
  type Song,
  type Playlist,
} from "./library";
const sourceName = (s?: { source?: Source; localUrl?: string }) =>
  s?.localUrl ? "本地" : s?.source === "qq" ? "QQ音乐" : "网易云";
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
  "discover" | "favorites" | "local" | "queue" | "playlists" | "playlist";
type Profile = { userId: number; nickname: string; avatar: string };
type PlaylistFilter = "recent" | Source | "internal";
let playlistFilter = (readSetting("ting.playlist-filter") ||
  "netease") as PlaylistFilter;
if (!["recent", "netease", "qq", "internal"].includes(playlistFilter))
  playlistFilter = "netease";
let qqProfile: Profile | null = null;
let accountSource: Source = "netease",
  searchSource: Source = "netease",
  qqLoginKind = "qq";
const authVersions: Record<Source, number> = { netease: 0, qq: 0 };
const accountRestoring: Partial<Record<Source, Promise<void>>> = {};
let qrSource: Source | undefined;
let qqPlaylistsOffset = 0,
  qqPlaylistsMore = false,
  neteasePlaylistsMore = false;
let profile: Profile | null = null,
  playlists: Playlist[] = [],
  playlistSongs: Song[] = [],
  selectedPlaylist: Playlist | undefined;
let playlistsMore = false,
  playlistsOffset = 0,
  playlistOffset = 0,
  playlistTotal = 0,
  librarySerial = 0,
  libraryBusy = false;
let loginSerial = 0,
  loginTimer = 0;
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

const iconSet = {
  Search,
  Library,
  Heart,
  FolderOpen,
  Music2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ListMusic,
  Plus,
  X,
  ArrowUpRight,
  Disc3,
  Headphones,
  Repeat,
  Shuffle,
  Repeat1,
  Download,
  ListOrdered,
  Check,
  LoaderCircle,
  ChevronRight,
  Ellipsis,
  Palette,
  Cloud,
};
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const iconCache = new Map<string, string>();
const icon = (name: string) => {
  if (!iconCache.has(name)) {
    const svg = createElement(iconSet[name as keyof typeof iconSet]);
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("aria-hidden", "true");
    iconCache.set(name, svg.outerHTML);
  }
  return iconCache.get(name)!;
};
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function restore(key: string): Song[] {
  try {
    const data = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(data)
      ? data.filter(
          (s) =>
            s &&
            !s.localUrl &&
            (!s.source || ["netease", "qq"].includes(s.source)) &&
            Number.isSafeInteger(s.id) &&
            s.id > 0 &&
            typeof s.name === "string" &&
            typeof s.artist === "string" &&
            typeof s.album === "string" &&
            typeof s.cover === "string",
        )
      : [];
  } catch {
    return [];
  }
}
let favorites = favoriteSongs(),
  locals: Song[] = [],
  results: Song[] = [];
const playbackQueue = new PlaybackQueue(restore("ting.queue"));
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
let queueFillSerial = 0,
  queueExpected = 0,
  playlistEditVersion = 0;
let playlistToRemember:
  { item: Playlist; serial: number; account: string } | undefined;
let lyrics: { time: number; text: string }[] = [],
  activeLine = -1,
  trialStart = 0;
const audio = new Audio();
audio.preload = "metadata";
audio.volume = 0.7;
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
      JSON.stringify(playbackQueue.songs.filter((s) => !s.localUrl)),
    );
  } catch {
    toast("本地存储空间不足，本次列表未保存");
  }
}
function toast(message: string) {
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
setupMobileViewport(mobileDevice);
if (isTauri() && platform.mac)
  document.documentElement.classList.add("mac-window");
$("#app").innerHTML = `
<header class="app-header" data-tauri-drag-region><button type="button" class="brand" aria-label="听 首页"><span class="brand-mark">听</span><strong>Ting</strong></button><span class="app-caption" data-tauri-drag-region>音乐，简单一点。</span><button id="sync-button" class="icon-button" aria-label="iCloud 歌单同步" title="iCloud 歌单同步">${icon("Cloud")}</button><button id="theme-button" class="icon-button" aria-label="切换主题" title="主题配色">${icon("Palette")}</button><button id="account-button" class="account-button" aria-label="登录网易云"><span class="avatar">听</span><span id="account-name">登录</span></button></header>
<section class="now-panel" aria-label="正在播放"><div class="now-card"><div id="now-cover" class="now-cover"><span class="fallback-cover">${icon("Music2")}</span></div><div class="now-heading"><h3 id="now-name">选一首喜欢的歌</h3><p id="now-artist">搜索音乐，或打开你的歌单</p><div class="track-tag" id="track-tag">等待播放</div></div><button id="download-current" class="icon-button" aria-label="下载当前歌曲最高可用音质" title="下载当前歌曲最高可用音质" disabled>${icon("Download")}</button><button id="now-fav" class="icon-button" aria-label="收藏当前歌曲" disabled>${icon("Heart")}</button></div></section>
<section class="player" aria-label="播放控制"><div class="transport"><div class="timeline"><span id="elapsed">0:00</span><input id="seek" aria-label="播放进度" type="range" min="0" max="100" value="0" step="0.1" disabled/><span id="duration">0:00</span></div><div class="transport-buttons"><button id="repeat" class="icon-button mode-button" aria-label="播放模式：顺序播放" title="切换播放模式">${icon("ListOrdered")}</button><button id="previous" class="icon-button" aria-label="上一首">${icon("SkipBack")}</button><button id="toggle" class="play-toggle" aria-label="播放">${icon("Play")}</button><button id="next" class="icon-button" aria-label="下一首">${icon("SkipForward")}</button><button id="lyrics-toggle" class="icon-button lyrics-toggle" aria-label="显示歌词" aria-expanded="false" aria-controls="lyrics-panel">词</button></div></div><div class="player-options"><div class="volume"><button id="mute" class="icon-button" aria-label="静音">${icon("Volume2")}</button><input id="volume" aria-label="音量" type="range" min="0" max="1" value="0.7" step="0.01"/></div><span id="mode-label">顺序播放</span><select id="quality" aria-label="播放音质">${Object.entries(
  qualityNames,
)
  .map(([value, label]) => `<option value="${value}">${label}</option>`)
  .join(
    "",
  )}</select></div><div id="download-info" hidden><span id="download-status" role="status"></span><button id="download-folder" class="quiet">打开文件夹</button></div></section>
<nav aria-label="音乐导航"><button data-view="discover" class="active">搜索</button><button data-view="playlists">歌单</button><button data-view="favorites">收藏<span id="fav-count">0</span></button><button data-view="local">本地</button><button data-view="queue">队列<span id="queue-count">0</span></button></nav>
<main><div class="topbar"><form id="search-form" role="search"><label class="sr-only" for="search">搜索歌曲或歌手</label>${icon("Search")}<input id="search" placeholder="搜索歌曲、歌手…" maxlength="100" autocomplete="off"/><select id="search-source" aria-label="搜索平台"><option value="netease">网易云</option><option value="qq">QQ音乐</option></select><button class="search-submit" aria-label="搜索" type="submit">搜索</button></form><button id="import-top" class="quiet" hidden>${icon("Plus")}导入</button></div><div class="main-scroll"><section class="library"><div class="section-top"><h2 id="section-title">搜索结果<span id="result-count"></span></h2><button id="refresh-playlists" class="quiet" hidden>刷新</button><button id="new-playlist" class="outline" hidden>＋ 新建</button><button id="manage-playlist" class="quiet" hidden>管理</button><button id="play-all" class="outline">${icon("Play")}播放全部</button></div><div id="discover-tools"><p id="search-summary" class="summary"></p></div><div id="error" role="alert" hidden></div><div id="playlist-filters" role="group" aria-label="歌单分类" hidden>${[
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
  )}</div><div id="playlist-grid" hidden></div><div class="table-head" hidden></div><div id="songs"></div><button id="more" class="load-more" hidden>加载更多 ${icon("ChevronRight")}</button></section></div></main>
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
setupThemes();
const accountKey = (source: Source) =>
  String((source === "qq" ? qqProfile : profile)?.userId || "");
const library = setupLibrary({
  cloud,
  toast,
  account: accountKey,
  sources: () => [
    ...(profile ? ["netease" as const] : []),
    ...(qqProfile ? ["qq" as const] : []),
  ],
  selected: () => (view === "playlist" ? selectedPlaylist : undefined),
  changed: async (item) => {
    // Keep filling the playback queue, but do not let old pages overwrite an edited library.
    playlistEditVersion++;
    save();
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
$("#manage-playlist").onclick = () => {
  if (selectedPlaylist) library.manage(selectedPlaylist);
};

function list() {
  return view === "discover"
    ? results
    : view === "favorites"
      ? favorites
      : view === "local"
        ? locals
        : view === "playlist"
          ? playlistSongs
          : view === "playlists"
            ? []
            : playbackQueue.songs;
}
function coverMarkup(song: Song, cls = "") {
  return song.cover
    ? `<img class="${cls}" src="${esc(song.cover)}" alt="${esc(song.album || song.name)} 封面" loading="lazy" referrerpolicy="no-referrer"/>`
    : `<span class="fallback-cover ${cls}">${icon("Music2")}</span>`;
}
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
  document.querySelectorAll<HTMLElement>(".song-row").forEach((row, i) => {
    const id = row.dataset.song!,
      selected = id === songKey(current);
    row.classList.toggle("playing", selected);
    row.classList.toggle("selected", id === selectedSongId);
    row
      .querySelector(".song-title")
      ?.setAttribute("aria-pressed", String(id === selectedSongId));
    const number = row.querySelector<HTMLElement>(".row-number")!;
    const text = selected ? "♫" : String(i + 1).padStart(2, "0");
    if (number.textContent !== text) number.textContent = text;
    const fav = row.querySelector<HTMLButtonElement>("[data-favorite]")!;
    const liked = favoriteIds.has(id);
    fav.classList.toggle("is-favorite", liked);
    fav.setAttribute(
      "aria-label",
      `${liked ? "取消收藏" : "收藏"} ${visibleSongs.get(id)?.name || ""}`,
    );
  });
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
function renderSongs() {
  const songs = list(),
    grid = view === "playlists";
  $("#playlist-grid").hidden = !grid;
  $("#playlist-filters").hidden = !grid;
  $("#songs").hidden = grid;
  $(".table-head").hidden = true;
  $("#play-all").hidden = grid;
  $("#new-playlist").hidden = !grid;
  $("#refresh-playlists").hidden = !grid;
  $("#refresh-playlists").toggleAttribute("disabled", libraryBusy);
  $("#manage-playlist").hidden =
    view !== "playlist" || !selectedPlaylist?.owned;
  $("#result-count").textContent = (
    grid ? displayedPlaylists().length : songs.length
  )
    ? ` / ${grid ? displayedPlaylists().length : songs.length}`
    : "";
  $("#play-all").toggleAttribute("disabled", !songs.length);
  $("#more").hidden =
    view === "discover"
      ? results.length >= total || !results.length
      : view === "playlists"
        ? !(playlistFilter === "netease"
            ? neteasePlaylistsMore
            : playlistFilter === "qq"
              ? qqPlaylistsMore
              : false)
        : view === "playlist"
          ? playlistOffset >= playlistTotal
          : true;
  $("#more").toggleAttribute("disabled", busy || libraryBusy);
  if (grid) {
    renderPlaylists();
    syncRows();
    return;
  }
  const container = $("#songs");
  if (
    ((busy && view === "discover") || (libraryBusy && view === "playlist")) &&
    !songs.length
  ) {
    container.innerHTML = '<div class="empty-state"><p>正在加载音乐…</p></div>';
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
    playlist: ["歌单暂时没有歌曲", "可以返回我的歌单选择其他歌单。"],
  };
  if (!songs.length) {
    container.innerHTML = `<div class="empty-state">${icon(view === "local" ? "FolderOpen" : "Music2")}<h3>${empty[view][0]}</h3><p>${empty[view][1]}</p>${view === "local" ? '<button id="empty-import" class="primary">导入本地音乐</button>' : ""}</div>`;
    syncRows();
    return;
  }
  container
    .querySelectorAll(".empty-state,.skeleton")
    .forEach((n) => n.remove());
  const existing = new Map(
    Array.from(container.querySelectorAll<HTMLElement>(".song-row")).map(
      (row) => [row.dataset.song!, row],
    ),
  );
  const wanted = new Set(songs.map((s) => songKey(s)));
  existing.forEach((row, id) => {
    if (!wanted.has(id)) row.remove();
  });
  songs.forEach((song, i) => {
    let row = existing.get(songKey(song));
    const signature = JSON.stringify([song, view === "queue"]);
    if (!row || row.dataset.signature !== signature) {
      const next = document.createElement("div");
      next.className = "song-row";
      next.dataset.song = songKey(song);
      next.dataset.signature = signature;
      next.tabIndex = 0;
      next.setAttribute("role", "group");
      next.setAttribute("aria-label", song.name);
      next.title = mobileDevice ? "轻点播放" : "单击选中，双击播放；回车播放";
      next.innerHTML = `<span class="row-number"></span><div class="song-info">${coverMarkup(song)}<div><button class="song-title" aria-label="${mobileDevice ? "播放" : "选中"} ${esc(song.name)}" aria-pressed="false">${esc(song.name)}</button>${song.localUrl ? "<em>本地</em>" : song.fee === 1 ? "<em>VIP</em>" : ""}<small><span class="source-badge" data-source="${song.source || "netease"}">${sourceName(song)}</span> ${esc(song.artist)}</small></div></div><span class="album">${esc(song.album)}</span><span class="song-duration">${song.duration ? formatTime(song.duration / 1000) : "—"}</span><div class="row-actions"><button class="icon-button favorite" data-favorite="${songKey(song)}" ${song.localUrl ? "disabled" : ""}>${icon("Heart")}</button><button class="icon-button" data-${view === "queue" ? "remove" : "enqueue"}="${songKey(song)}" aria-label="${view === "queue" ? "移出队列" : "加入队列"} ${esc(song.name)}">${icon(view === "queue" ? "X" : "Plus")}</button><button class="icon-button" data-song-menu="${songKey(song)}" aria-label="歌曲操作 ${esc(song.name)}" ${song.localUrl ? "disabled" : ""}>${icon("Ellipsis")}</button></div>`;
      if (row) row.replaceWith(next);
      row = next;
    }
    if (container.children[i] !== row)
      container.insertBefore(row, container.children[i] ?? null);
  });
  syncRows();
}
let playlistsLoaded = false;
const viewScroll = new Map<View, number>();
function setView(next: View) {
  const changed = view !== next;
  if (changed) {
    if (view === "playlists" && libraryBusy) playlistsLoaded = false;
    viewScroll.set(view, $(".main-scroll").scrollTop);
    librarySerial++;
    libraryBusy = false;
  }
  view = next;
  $("#play-all").innerHTML = icon("Play") + "播放全部";
  document
    .querySelectorAll("[data-view]")
    .forEach((el) =>
      el.classList.toggle("active", (el as HTMLElement).dataset.view === view),
    );
  $("#search-form").hidden = view !== "discover";
  $("#import-top").hidden = view !== "local";
  $(".topbar").hidden = view !== "discover" && view !== "local";
  $("#discover-tools").hidden = view !== "discover";
  $("#error").hidden = true;
  const titles = {
    discover: "搜索结果",
    favorites: "收藏",
    playlists: "我的歌单",
    playlist: selectedPlaylist
      ? `${playlistLabel(selectedPlaylist)} · ${selectedPlaylist.name}`
      : "歌单",
    local: "本地音乐",
    queue: "播放队列",
  };
  $("#section-title").innerHTML =
    `${esc(titles[view])}<span id="result-count"></span>`;
  renderSongs();
  if (changed) $(".main-scroll").scrollTop = viewScroll.get(next) || 0;
}
async function search(term: string, append = false) {
  term = term.trim();
  if (!term) return;
  const serial = ++searchSerial;
  query = term;
  if (!append) {
    offset = 0;
    results = [];
  }
  busy = true;
  setView("discover");
  $("#search").setAttribute("value", term);
  ($("#search") as HTMLInputElement).value = term;
  $("#search-summary").textContent = `正在寻找「${term}」…`;
  try {
    if (!isTauri())
      throw new Error(
        "云端搜索需要在 Ting 应用中使用；浏览器预览可导入本地音乐。",
      );
    const data = await cloud<{ songs: Song[]; total: number }>(
      "search_songs",
      { query: term, offset },
      searchSource,
    );
    if (serial !== searchSerial) return;
    results = append ? uniqueSongs([...results, ...data.songs]) : data.songs;
    offset += data.songs.length;
    total = data.total;
    if (!data.songs.length) total = results.length;
    $("#search-summary").textContent =
      `「${term}」的搜索结果 · 共 ${data.total} 首`;
  } catch (e) {
    if (serial !== searchSerial) return;
    $("#error").textContent = String(e);
    $("#error").hidden = view !== "discover";
    $("#search-summary").textContent = "暂时无法获取搜索结果";
  } finally {
    if (serial === searchSerial) {
      busy = false;
      renderSongs();
    }
  }
}
function toggleFavorite(song: Song) {
  if (song.localUrl) return;
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
  $("#download-current").toggleAttribute(
    "disabled",
    downloading || !current || !!current.localUrl,
  );
  $("#download-current").title =
    current?.source === "qq"
      ? "下载 QQ 歌曲最高可用音质"
      : "下载网易云歌曲最高可用音质";
}
function updateFavorite() {
  updateDownloadButton();
  $("#now-fav").toggleAttribute("disabled", !current || !!current.localUrl);
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
  }
  $("#toggle").setAttribute("aria-label", playing ? "暂停" : "播放");
  document.body.classList.toggle("playing", playing);
}
function updateNow(song: Song) {
  $("#now-cover").innerHTML = coverMarkup(song);
  $("#now-name").textContent = song.name;
  $("#lyrics-title").textContent = song.name;
  $("#lyrics-artist").textContent = `${sourceName(song)} · ${song.artist}`;
  $("#now-name").title = song.name;
  $("#now-artist").textContent = `${sourceName(song)} · ${song.artist}`;
  updateFavorite();
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
  systemMedia.clear();
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
  current = song;
  pendingSeek = resumeAt;
  if (!sameSong) lyrics = [];
  activeLine = -1;
  lyricFollower.reset();
  trialStart = 0;
  if (replaceQueue) {
    queueFillSerial++;
    queueExpected = 0;
    playbackQueue.replace(replaceQueue);
  }
  if (!preserveNavigation && !playbackQueue.start(song, { fromHistory })) {
    preparingPlayback = false;
    return;
  }
  syncAudioLoop();
  systemMedia.select(song);
  save();
  if (view === "queue") renderSongs();
  else syncRows();
  if (!sameSong) updateNow(song);
  $("#quality").toggleAttribute("disabled", !!song.localUrl);
  $("#track-tag").textContent = "正在准备播放…";
  if (!sameSong)
    $("#lyrics").innerHTML = '<p class="lyric-placeholder">正在寻找歌词…</p>';
  ($("#seek") as HTMLInputElement).disabled = true;
  $("#elapsed").textContent = $("#duration").textContent = "0:00";
  ($("#seek") as HTMLInputElement).value = "0";
  try {
    let url = song.localUrl;
    if (!url) {
      const data = await cloud<Playback>(
        "song_url",
        { id: song.id, mid: song.mid, level: quality },
        song.source,
      );
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
    audio.src = url;
    audio.load();
    const playPromise = resumeAfterLoad ? audio.play() : Promise.resolve();
    if (song.localUrl)
      $("#lyrics").innerHTML =
        '<p class="lyric-placeholder">本地音乐<br>享受没有文字的片刻。</p>';
    else if (!sameSong || !lyrics.length)
      void cloud<string>("song_lyric", { id: song.id }, song.source)
        .then((text) => {
          if (songKey(current) !== songKey(song)) return;
          lyrics = parseLyrics(text);
          $("#lyrics").innerHTML = lyrics.length
            ? lyrics
                .map((l, i) => `<p data-line="${i}">${esc(l.text)}</p>`)
                .join("")
            : '<p class="lyric-placeholder">暂无歌词，让旋律说话。</p>';
          lyricFollower.reset();
          lyricFollower.sync(
            lyricIndex(lyrics, audio.currentTime + trialStart),
            true,
            true,
          );
        })
        .catch(() => {
          if (songKey(current) === songKey(song))
            $("#lyrics").innerHTML =
              '<p class="lyric-placeholder">歌词暂不可用<br>音乐依然继续。</p>';
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
      $("#lyrics").innerHTML =
        '<p class="lyric-placeholder">可以换一首歌，<br>或导入本地音频。</p>';
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    if (serial === playSerial) {
      preparingPlayback = false;
      updateTransport();
    }
  }
}
function skip(delta: number, automatic = false, shouldResume = true) {
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
  $("#repeat").innerHTML = icon(icons[playbackMode]);
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
    if (!audio.getAttribute("src")) void play(current);
    else {
      if (current && !systemMedia.active) systemMedia.select(current);
      void audio.play().catch(() => toast("播放失败，请重新选择歌曲"));
    }
  } else audio.pause();
}
function importFiles(files: FileList | null) {
  if (!files) return;
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
    playlistFilter = filter.dataset.playlistFilter as PlaylistFilter;
    try {
      localStorage.setItem("ting.playlist-filter", playlistFilter);
    } catch {}
    renderSongs();
    $(".main-scroll").scrollTop = 0;
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
      accountSource = playlistFilter;
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
  if (el.closest("#empty-import"))
    ($("#file-input") as HTMLInputElement).click();
});
document.addEventListener("dblclick", (e) => {
  if (mobileDevice) return;
  const el = e.target as HTMLElement;
  if (el.closest(".row-actions")) return;
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
  if ($("#account-dialog").hasAttribute("open")) return;
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
  if (
    (e.target as HTMLElement).matches("input,textarea,button,select") ||
    $("#account-dialog").hasAttribute("open")
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    toggle();
  }
});
$(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  if (view !== "discover") setView("discover");
});
$("#import-top").onclick = () => ($("#file-input") as HTMLInputElement).click();
$("#file-input").onchange = () => {
  importFiles(($("#file-input") as HTMLInputElement).files);
  ($("#file-input") as HTMLInputElement).value = "";
};
$("#play-all").onclick = () => void playAll();
$("#refresh-playlists").onclick = () => void loadPlaylists();
$("#more").onclick = () => {
  if (view === "playlists") void loadPlaylists(true);
  else if (view === "playlist" && selectedPlaylist)
    void loadPlaylist(selectedPlaylist, true);
  else void search(query, true);
};
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
  audio.volume = Number(($("#volume") as HTMLInputElement).value);
  audio.muted = false;
  $("#mute").innerHTML = icon(audio.volume ? "Volume2" : "VolumeX");
};
$("#mute").onclick = () => {
  audio.muted = !audio.muted;
  $("#mute").setAttribute("aria-label", audio.muted ? "取消静音" : "静音");
  $("#mute").innerHTML = icon(audio.muted ? "VolumeX" : "Volume2");
};
$("#seek").oninput = () => {
  if (Number.isFinite(audio.duration))
    audio.currentTime = Number(($("#seek") as HTMLInputElement).value);
};
audio.addEventListener("playing", () => {
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
audio.addEventListener("volumechange", () => {
  ($("#volume") as HTMLInputElement).value = String(audio.volume);
  $("#mute").setAttribute("aria-label", audio.muted ? "取消静音" : "静音");
  $("#mute").innerHTML = icon(
    audio.muted || !audio.volume ? "VolumeX" : "Volume2",
  );
});
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
  if (current?.localUrl) {
    current.duration = audio.duration * 1000;
    renderSongs();
  }
});
audio.addEventListener("timeupdate", () => {
  const elapsed = formatTime(audio.currentTime);
  if ($("#elapsed").textContent !== elapsed)
    $("#elapsed").textContent = elapsed;
  ($("#seek") as HTMLInputElement).value = String(audio.currentTime);
  const index = lyricIndex(lyrics, audio.currentTime + trialStart);
  activeLine = index;
  lyricFollower.sync(index, audio.seeking);
});
audio.addEventListener("seeked", () =>
  lyricFollower.resume(
    lyricIndex(lyrics, audio.currentTime + trialStart),
    true,
  ),
);
audio.addEventListener("ended", () => {
  skip(1, true);
});
audio.addEventListener("error", () => {
  if (audio.getAttribute("src")) {
    $("#track-tag").textContent = "音频加载失败";
    toast("音频加载失败，可能已过期或格式不受支持；重新选择歌曲可重试。");
  }
});
window.addEventListener("offline", () => toast("网络已断开，本地音乐仍可播放"));
renderSongs();
void initialize();

function activeProfile() {
  return accountSource === "qq" ? qqProfile : profile;
}
function renderAccount() {
  const count = Number(!!profile) + Number(!!qqProfile);
  $("#account-name").textContent =
    count === 2 ? "双账号" : (profile || qqProfile)?.nickname || "登录";
  $("#account-button").setAttribute("aria-label", "账号设置");
  $("#account-button .avatar").textContent =
    (profile || qqProfile)?.nickname.slice(0, 1) || "听";
  $("#account-netease").textContent =
    `网易云${profile ? " · 已登录" : " · 未登录"}`;
  $("#account-qq").textContent =
    `QQ音乐${qqProfile ? " · 已登录" : " · 未登录"}`;
  $("#account-netease").classList.toggle("active", accountSource === "netease");
  $("#account-qq").classList.toggle("active", accountSource === "qq");
}
async function initialize() {
  renderPlaybackMode();
  renderAccount();
  ($("#quality") as HTMLSelectElement).value = quality;
  void search(query);
  if (!isTauri()) return;
  await Promise.allSettled(
    (["netease", "qq"] as Source[]).map((source) => {
      const version = authVersions[source];
      const request = (async () => {
        try {
          const restored = await cloud<Profile | null>(
            "account_status",
            {},
            source,
          );
          if (version !== authVersions[source]) return;
          if (source === "qq") qqProfile = restored;
          else profile = restored;
          renderAccount();
        } catch {
          if (version === authVersions[source])
            toast(
              `${sourceName({ source })}登录状态暂无法验证，可在账号中重试`,
            );
        } finally {
          delete accountRestoring[source];
        }
      })();
      accountRestoring[source] = request;
      return request;
    }),
  );
  if (view === "playlists") void loadPlaylists();
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
function renderPlaylists() {
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
    (playlistFilter === "netease" && !profile) ||
    (playlistFilter === "qq" && !qqProfile)
  ) {
    box.innerHTML = `<div class="empty-state">${icon("Library")}<h3>登录${sourceName({ source: playlistFilter as Source })}</h3><p>读取你创建和收藏的歌单。</p><button id="playlist-login" class="primary">登录账号</button></div>`;
    return;
  }
  if (
    libraryBusy &&
    !items.length &&
    !["internal", "recent"].includes(playlistFilter)
  ) {
    box.innerHTML = '<div class="empty-state"><p>正在加载你的歌单…</p></div>';
    return;
  }
  box.innerHTML = items.length
    ? `<div class="playlist-cards">${items.map((p) => `<button class="playlist-card" data-playlist="${playlistKey(p)}">${p.cover ? `<img src="${esc(p.cover)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer"/>` : '<span class="fallback-cover">♪</span>'}<strong>${esc(p.name)}</strong><span>${playlistLabel(p)} · ${p.trackCount} 首 · ${p.owned ? "我创建的" : "我收藏的"}</span><small>${esc(p.creator)}</small></button>`).join("")}</div>`
    : playlistFilter === "recent"
      ? '<div class="empty-state"><h3>最近听过的歌单</h3><p>播放歌单后会自动排到这里。<br>切换上方平台，浏览你的全部歌单。</p></div>'
      : playlistFilter === "internal"
        ? '<div class="empty-state"><h3>跨平台收藏在一起</h3><p>点击右上角「＋ 新建」，创建本机混合歌单。</p></div>'
        : '<div class="empty-state"><h3>还没有读取到歌单</h3><button id="playlist-retry" class="outline">重新加载</button></div>';
}
async function loadPlaylists(append = false) {
  setView("playlists");
  const serial = ++librarySerial;
  if (!profile && !qqProfile) {
    playlists = internalPlaylists();
    playlistsMore = false;
    neteasePlaylistsMore = qqPlaylistsMore = false;
    playlistsLoaded = true;
    renderSongs();
    return;
  }
  if (!append) {
    playlists = internalPlaylists();
    playlistsOffset = 0;
    qqPlaylistsOffset = 0;
    neteasePlaylistsMore = !!profile;
    qqPlaylistsMore = !!qqProfile;
  }
  libraryBusy = true;
  renderSongs();
  const errors: string[] = [];
  await Promise.allSettled(
    (["netease", "qq"] as Source[]).map(async (source) => {
      if (append && playlistFilter !== source) return;
      if (
        source === "netease"
          ? !profile || !neteasePlaylistsMore
          : !qqProfile || !qqPlaylistsMore
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
            [...playlists, ...items].map((p) => [playlistKey(p), p]),
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
  playlistsMore = neteasePlaylistsMore || qqPlaylistsMore;
  libraryBusy = false;
  playlistsLoaded = !errors.length;
  $("#error").textContent = errors.join("；");
  $("#error").hidden = !errors.length;
  renderSongs();
}
async function loadPlaylist(item: Playlist, append = false) {
  selectedPlaylist = item;
  if (item.internal) {
    librarySerial++;
    libraryBusy = false;
    playlistSongs = internalSongs(item);
    playlistTotal = playlistOffset = playlistSongs.length;
    setView("playlist");
    if (!append) $(".main-scroll").scrollTop = 0;
    return;
  }
  if (!append) {
    playlistSongs = [];
    playlistOffset = 0;
    playlistTotal = item.trackCount;
  }
  setView("playlist");
  if (!append) $(".main-scroll").scrollTop = 0;
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
let neteaseLoginMethod: "phone" | "qr" = mobileDevice ? "phone" : "qr";
let disposePhoneLogin: (() => void) | undefined;
function clearPhoneLogin() {
  disposePhoneLogin?.();
  disposePhoneLogin = undefined;
}
function completeLogin(source: Source, data: PhoneLoginResult) {
  if (!data.profile) return;
  playlistsLoaded = false;
  authVersions[source]++;
  if (source === "qq") qqProfile = data.profile;
  else profile = data.profile;
  renderAccount();
  closeAccount(false);
  toast(data.warning || `欢迎回来，${data.profile.nickname}`);
  void loadPlaylists();
}
async function openAccount() {
  const dialog = $("#account-dialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
  renderAccount();
  $("#share-login-qr").hidden = true;
  $("#netease-login-method").hidden = true;
  $("#account-dialog").dataset.provider = accountSource;
  if (!isTauri()) {
    $("#account-content").innerHTML = "<p>请在 Ting 应用内登录。</p>";
    return;
  }
  const source = accountSource,
    serial = loginSerial;
  const restoring = accountRestoring[source];
  if (restoring) {
    $("#account-title").textContent = `${sourceName({ source })}账号`;
    $(".account-subtitle").textContent = "正在恢复已有登录状态…";
    $("#account-content").innerHTML =
      '<p class="summary">正在验证账号，请稍候。</p>';
    $("#account-status").textContent = "";
    $("#qq-login-method").hidden = true;
    $("#refresh-qr").hidden = $("#logout").hidden = true;
    await restoring;
    if (serial !== loginSerial || source !== accountSource || !dialog.open)
      return;
  }
  const connected = activeProfile();
  $("#qq-login-method").hidden = accountSource !== "qq" || !!connected;
  if (!connected) {
    await startLogin();
    return;
  }
  $("#account-title").textContent =
    `${sourceName({ source: accountSource })}账号`;
  $(".account-subtitle").textContent =
    "两个平台独立登录，退出当前账号不影响另一个。";
  $("#account-content").innerHTML =
    `<div class="account-profile"><span class="profile-initial">${esc(connected.nickname.slice(0, 1))}</span><h3>${esc(connected.nickname)}</h3><p>UID ${esc(String(connected.userId))}</p></div>`;
  $("#account-status").textContent = credentialNotice;
  $("#refresh-qr").hidden = true;
  $("#logout").hidden = false;
}
async function startLogin() {
  clearTimeout(loginTimer);
  clearPhoneLogin();
  $("#share-login-qr").hidden = true;
  const serial = ++loginSerial;
  const source = accountSource;
  qrSource = source;
  const name = sourceName({ source });
  $("#account-dialog").dataset.loginMethod =
    source === "netease" ? neteaseLoginMethod : "qr";
  $("#account-title").textContent = `登录${name}`;
  $(".account-subtitle").textContent = loginInstructions(source, qqLoginKind);
  $("#qq-login-method").hidden = source !== "qq";
  $("#netease-login-method").hidden = source !== "netease";
  document
    .querySelectorAll<HTMLElement>("[data-netease-method]")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        el.dataset.neteaseMethod === neteaseLoginMethod,
      ),
    );
  if (source === "netease" && neteaseLoginMethod === "phone") {
    $(".account-subtitle").textContent =
      "输入网易云账号绑定的手机号，用短信验证码登录。";
    $("#refresh-qr").hidden = $("#logout").hidden = true;
    $("#account-status").textContent = "";
    disposePhoneLogin = mountPhoneLogin(
      $("#account-content"),
      $("#account-status"),
      () =>
        serial === loginSerial &&
        ($("#account-dialog") as HTMLDialogElement).open,
      (data) => completeLogin(source, data),
    );
    return;
  }
  document
    .querySelectorAll<HTMLElement>("[data-qq-kind]")
    .forEach((el) =>
      el.classList.toggle("active", el.dataset.qqKind === qqLoginKind),
    );
  $("#logout").hidden = true;
  $("#refresh-qr").hidden = false;
  $("#refresh-qr").setAttribute("disabled", "");
  $("#account-content").innerHTML =
    '<div class="qr-loading">正在生成二维码…</div>';
  $("#account-status").textContent = "";
  try {
    const data = await cloud<{ key: string; url?: string; image?: string }>(
      "login_qr_start",
      { kind: qqLoginKind },
      source,
    );
    if (serial !== loginSerial) return;
    const maxSize = Math.min(340, $("#account-content").clientWidth);
    const qr =
      source === "qq"
        ? await verifyOriginalQr(data.image!, maxSize)
        : { src: await makeLoginQr(data.url!, maxSize), payload: data.url! };
    if (serial !== loginSerial) return;
    $("#account-content").innerHTML =
      `<img id="login-qr" src="${qr.src}" alt="${name}登录二维码"/>`;
    $("#login-qr").dataset.payload = qr.payload;
    $("#share-login-qr").hidden = !mobileDevice;
    if ("width" in qr) $("#login-qr").style.width = `${qr.width}px`;
    $("#account-status").textContent = "等待扫码 · 二维码约 3 分钟内有效";
    requestAnimationFrame(() => {
      if (serial !== loginSerial) return;
      const img = $("#login-qr"),
        rect = img.getBoundingClientRect();
      img.style.position = "relative";
      img.style.left = `${Math.round(rect.x) - rect.x}px`;
      img.style.top = `${Math.round(rect.y) - rect.y}px`;
    });
    loginTimer = window.setTimeout(
      () => void pollLogin(data.key, serial, source),
      1800,
    );
  } catch (e) {
    if (serial === loginSerial) {
      $("#account-content").innerHTML =
        '<div class="qr-loading">二维码暂不可用</div>';
      $("#account-status").textContent = String(e);
    }
  } finally {
    if (serial === loginSerial) $("#refresh-qr").removeAttribute("disabled");
  }
}
async function pollLogin(key: string, serial: number, source: Source) {
  if (
    serial !== loginSerial ||
    !($("#account-dialog") as HTMLDialogElement).open
  )
    return;
  try {
    const data = await cloud<{
      code: number;
      profile: Profile | null;
      warning?: string;
    }>("login_qr_check", { key }, source);
    if (serial !== loginSerial) return;
    if (data.code === 803 && data.profile) {
      completeLogin(source, data);
      return;
    }
    if (data.code === 800 || data.code === 804) {
      $("#account-status").textContent =
        data.code === 804
          ? "已取消授权，可刷新二维码重新登录"
          : "二维码已过期，请点击刷新二维码";
      return;
    }
    $("#account-status").textContent =
      data.code === 802
        ? `已扫码，请在${source === "qq" ? (qqLoginKind === "wx" ? "微信" : "手机 QQ") : "网易云音乐 App"}中确认登录`
        : `等待扫码 · ${source === "qq" ? (qqLoginKind === "wx" ? "请使用微信" : "请使用手机 QQ") : "请使用网易云音乐 App"}`;
  } catch (e) {
    if (serial !== loginSerial) return;
    $("#account-status").textContent = `${String(e)} · 正在重试`;
  }
  if (serial === loginSerial)
    loginTimer = window.setTimeout(
      () => void pollLogin(key, serial, source),
      2000,
    );
}
function closeAccount(cancel = true) {
  loginSerial++;
  clearPhoneLogin();
  clearTimeout(loginTimer);
  ($("#account-dialog") as HTMLDialogElement).close();
  const pending = qrSource;
  qrSource = undefined;
  if (cancel && pending && isTauri())
    void cloud("login_qr_cancel", {}, pending).catch(() => {});
}
async function switchAccount(source: Source) {
  if (source === accountSource) return;
  clearPhoneLogin();
  const previous = accountSource;
  ++loginSerial;
  clearTimeout(loginTimer);
  accountSource = source;
  if (isTauri() && qrSource === previous)
    void cloud("login_qr_cancel", {}, previous).catch(() => {});
  qrSource = undefined;
  await openAccount();
}
$("#account-netease").onclick = () => void switchAccount("netease");
$("#account-qq").onclick = () => void switchAccount("qq");
document.querySelectorAll<HTMLElement>("[data-qq-kind]").forEach(
  (el) =>
    (el.onclick = () => {
      qqLoginKind = el.dataset.qqKind!;
      void startLogin();
    }),
);
$("#search-source").onchange = () => {
  searchSource = ($("#search-source") as HTMLSelectElement).value as Source;
  void search(($("#search") as HTMLInputElement).value || query);
};
$("#account-button").onclick = () => void openAccount();
$("#account-close").onclick = () => closeAccount();
$("#account-dialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeAccount();
});
$("#refresh-qr").onclick = () => void startLogin();
document.querySelectorAll<HTMLElement>("[data-netease-method]").forEach(
  (el) =>
    (el.onclick = async () => {
      const method = el.dataset.neteaseMethod as "phone" | "qr";
      if (method === neteaseLoginMethod) return;
      const serial = ++loginSerial;
      clearPhoneLogin();
      clearTimeout(loginTimer);
      neteaseLoginMethod = method;
      try {
        await cloud("login_qr_cancel", {}, "netease");
      } catch {
        /* Starting a new attempt also replaces the pending session. */
      }
      if (serial === loginSerial) void startLogin();
    }),
);
$("#share-login-qr").onclick = async () => {
  const button = $("#share-login-qr") as HTMLButtonElement;
  const qr = $("#login-qr") as HTMLImageElement;
  if (!qr || button.disabled) return;
  const serial = loginSerial;
  button.disabled = true;
  try {
    const dataUrl = await qrPngForSharing(qr.src, qr.dataset.payload!);
    if (serial !== loginSerial) return;
    if (platform.ios && isTauri()) await invoke("share_login_qr", { dataUrl });
    else {
      const blob = await (await fetch(dataUrl)).blob();
      const files = [new File([blob], "Ting-login.png", { type: "image/png" })];
      if (!navigator.canShare?.({ files }))
        throw new Error(
          "此设备尚不支持系统分享，请截取完整二维码后使用另一设备扫码",
        );
      await navigator.share({ files });
    }
  } catch (error) {
    if (
      serial === loginSerial &&
      !(error instanceof DOMException && error.name === "AbortError")
    )
      toast(String(error));
  } finally {
    button.disabled = false;
  }
};
$("#logout").onclick = async () => {
  const source = accountSource;
  const serial = ++loginSerial;
  $("#logout").setAttribute("disabled", "");
  try {
    clearTimeout(loginTimer);
    authVersions[source]++;
    await cloud("logout", {}, source);
    if (
      current &&
      !current.localUrl &&
      (current.source || "netease") === source
    ) {
      ++playSerial;
      systemMedia.clear();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      $("#track-tag").textContent = "该平台已退出登录";
    }
    if (source === "qq") qqProfile = null;
    else profile = null;
    playlistsLoaded = false;
    const keep = (s: Song) =>
      !!s.localUrl || (s.source || "netease") !== source;
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
    save();
    renderAccount();
    if (serial === loginSerial && source === accountSource) {
      closeAccount(false);
      void loadPlaylists();
    } else {
      renderSongs();
      if (
        source === accountSource &&
        ($("#account-dialog") as HTMLDialogElement).open
      )
        void openAccount();
    }
    toast(`已退出${sourceName({ source })}，另一个平台不受影响`);
  } catch (e) {
    if (serial === loginSerial) $("#account-status").textContent = String(e);
    else toast(`退出${sourceName({ source })}失败，请重试`);
  } finally {
    $("#logout").removeAttribute("disabled");
  }
};
$("#quality").onchange = () => {
  quality = ($("#quality") as HTMLSelectElement).value;
  if (!writeSetting("ting.quality", quality))
    toast("音质偏好未保存，本地存储不可用");
  if (current && !current.localUrl) {
    const position = audio.currentTime,
      playing = !audio.paused;
    void play(current, undefined, position, playing, false, undefined, true);
  } else toast(`播放音质已设为${qualityNames[quality]}`);
};

function playAll() {
  if (list().length) playSelection(list()[0]);
}

// Start the selected track immediately; pagination belongs to the queue, not the visible page.
function playSelection(song: Song) {
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

$("#download-current").onclick = async () => {
  if (!current || current.localUrl || downloading) return;
  const song = current;
  downloading = true;
  updateDownloadButton();
  $("#download-info").hidden = false;
  $("#download-status").textContent = `正在获取音源并下载：${song.name}…`;
  try {
    const result = await invoke<{
      path: string;
      filename: string;
      source: string;
      level: string;
      format: string;
      bitrate: number;
      sampleRate: number;
      bitDepth: number;
      warnings: string[];
    }>("download_song", { id: song.id, source: song.source || "netease" });
    const source =
      result.source === "qq"
        ? song.source === "qq"
          ? "QQ音乐"
          : "QQ 补源"
        : "网易云";
    const quality = actualQualityNames[result.level] || result.level;
    const detail = result.bitDepth
      ? `${result.bitDepth}bit / ${result.sampleRate / 1000}kHz`
      : `${Math.round(result.bitrate / 1000)}kbps`;
    $("#download-status").textContent =
      `已保存 · ${source} · ${quality} · ${result.format.toUpperCase()} · ${detail}`;
    $("#download-status").title = result.path;
    toast(
      `${result.filename} 已保存到${mobileDevice ? downloadLocation : result.path.replace(/[\\/][^\\/]+$/, "")}${result.warnings.length ? " · " + result.warnings.join("；") : ""}`,
    );
  } catch (e) {
    $("#download-status").textContent = "下载未完成，可点击下载按钮重试";
    toast(e instanceof Error ? e.message : String(e));
  } finally {
    downloading = false;
    updateDownloadButton();
  }
};
$("#download-folder").onclick = () => {
  if (mobileDevice) toast(`请前往${downloadLocation}查看下载文件`);
  else void invoke("open_download_folder").catch((e) => toast(String(e)));
};
