import { songKey, uniqueSongs, formatTime } from "./model.mjs";
import { changes, type Batch } from "./library-sync-model";
export type Source = "netease" | "qq";
export type Song = {
  source?: Source;
  mid?: string;
  id: number;
  name: string;
  artist: string;
  album: string;
  cover: string;
  duration: number;
  fee: number;
  localUrl?: string;
};
export type Playlist = {
  source?: Source;
  internal?: boolean;
  dirid?: number;
  id: number;
  name: string;
  cover: string;
  trackCount: number;
  creator: string;
  owned: boolean;
};
type SavedPlaylist = Playlist & { songs: Song[] };
type Page = { songs: Song[]; total: number; nextOffset: number };
export const playlistLabel = (p: Playlist) =>
  p.internal ? "本机 · 混合来源" : p.source === "qq" ? "QQ音乐" : "网易云";
export const playlistKey = (p: Playlist) =>
  p.internal ? `internal:${p.id}` : songKey(p);
const validSong = (s: Song) =>
  s &&
  Number.isSafeInteger(s.id) &&
  s.id > 0 &&
  !s.localUrl &&
  (!s.source || ["qq", "netease"].includes(s.source)) &&
  ["name", "artist", "album", "cover"].every(
    (k) => typeof s[k as keyof Song] === "string",
  );
function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
const envelope = read<{
  version?: number;
  playlists?: unknown;
  pending?: Batch[];
  device?: string;
} | null>("ting.library-sync.v1", null);
let syncEnabled =
  envelope?.version === 1 &&
  Array.isArray(envelope.playlists) &&
  Array.isArray(envelope.pending);
let backendDevice: string | undefined = syncEnabled
  ? envelope?.device
  : undefined;
let pending: Batch[] = syncEnabled ? envelope!.pending! : [];
const saved = syncEnabled
  ? envelope!.playlists
  : read<unknown>("ting.playlists", []);
let internal: SavedPlaylist[] = Array.isArray(saved)
  ? saved
      .filter(
        (p) =>
          p &&
          p.internal === true &&
          Number.isSafeInteger(p.id) &&
          p.id > 0 &&
          typeof p.name === "string" &&
          typeof p.creator === "string" &&
          Array.isArray(p.songs),
      )
      .map((p) => ({
        ...p,
        owned: true,
        songs: uniqueSongs(p.songs.filter(validSong)),
      }))
  : [];
function persist(
  next: SavedPlaylist[],
  outbox: Batch[],
  device = backendDevice,
) {
  localStorage.setItem(
    "ting.library-sync.v1",
    JSON.stringify({ version: 1, playlists: next, pending: outbox, device }),
  );
}
function commit(next: SavedPlaylist[]) {
  // The visible library and its outbox are one atomic localStorage value.
  if (syncEnabled) {
    const edits = changes(internal, next);
    const outbox = edits.length
      ? [...pending, { id: crypto.randomUUID(), changes: edits }]
      : pending;
    persist(next, outbox);
    pending = outbox;
  } else localStorage.setItem("ting.playlists", JSON.stringify(next));
  internal = next;
  window.dispatchEvent(new Event("ting:library-change"));
}
export function startSyncLibrary() {
  if (syncEnabled) return;
  const edits = changes([], internal);
  const outbox = edits.length
    ? [{ id: crypto.randomUUID(), changes: edits }]
    : [];
  persist(internal, outbox);
  pending = outbox;
  syncEnabled = true;
}
export function syncDevice(): string | undefined {
  return backendDevice;
}
export function pendingLibraryChanges(): Batch[] {
  return [...pending];
}
export function acceptSyncLibrary(
  playlists: SavedPlaylist[],
  ack: string[],
  device: string,
): boolean {
  if (
    !Array.isArray(playlists) ||
    !playlists.every(
      (p) =>
        p.internal === true &&
        Number.isSafeInteger(p.id) &&
        p.id > 0 &&
        typeof p.name === "string" &&
        Array.isArray(p.songs) &&
        p.songs.every(validSong),
    )
  )
    throw new Error("同步歌单数据无效");
  const confirmed = new Set(ack);
  const remaining = pending.filter((b) => !confirmed.has(b.id));
  // An edit made while IPC was in flight must be acknowledged in a later pass
  // before replacing the UI snapshot with the merged native state.
  const next = remaining.length ? internal : playlists;
  const changed = JSON.stringify(next) !== JSON.stringify(internal);
  persist(next, remaining, device);
  backendDevice = device;
  pending = remaining;
  internal = next;
  return changed;
}
export function internalPlaylists(): Playlist[] {
  return internal.map(({ songs, ...p }) => ({
    ...p,
    trackCount: songs.length,
    cover: songs[0]?.cover || "",
  }));
}
export function internalSongs(p: Playlist): Song[] {
  const found = internal.find((x) => x.id === p.id);
  if (!found) throw new Error("本机歌单已不存在");
  return [...found.songs];
}
function updateInternal(
  p: Playlist,
  update: (x: SavedPlaylist) => SavedPlaylist,
) {
  if (!internal.some((x) => x.id === p.id)) throw new Error("本机歌单已不存在");
  commit(internal.map((x) => (x.id === p.id ? update(x) : x)));
}
type Recent = { account: string; at: number; playlist: Playlist };
const recentData = read<unknown>("ting.playlist-recent", []);
let recents: Recent[] = Array.isArray(recentData)
  ? recentData.filter(
      (r) =>
        r &&
        typeof r.account === "string" &&
        Number.isFinite(r.at) &&
        r.playlist &&
        Number.isSafeInteger(r.playlist.id) &&
        typeof r.playlist.name === "string" &&
        typeof r.playlist.creator === "string" &&
        typeof r.playlist.cover === "string" &&
        (!r.playlist.source || ["qq", "netease"].includes(r.playlist.source)),
    )
  : [];
export function rememberPlaylist(p: Playlist, account: string) {
  if (!p.internal && !account) return;
  const {
    id,
    name,
    source,
    internal,
    dirid,
    cover,
    trackCount,
    creator,
    owned,
  } = p;
  const item = {
    account: p.internal ? "local" : account,
    at: Date.now(),
    playlist: {
      id,
      name,
      source,
      internal,
      dirid,
      cover,
      trackCount,
      creator,
      owned,
    },
  };
  const next = [
    item,
    ...recents.filter(
      (r) =>
        !(
          r.account === item.account &&
          playlistKey(r.playlist) === playlistKey(p)
        ),
    ),
  ];
  localStorage.setItem("ting.playlist-recent", JSON.stringify(next));
  recents = next;
}
export function recentPlaylists(
  available: Playlist[],
  account: (source: Source) => string,
): Playlist[] {
  const known = new Map(available.map((p) => [playlistKey(p), p]));
  return recents
    .filter((r) =>
      r.playlist.internal
        ? known.has(playlistKey(r.playlist))
        : !!account(r.playlist.source || "netease") &&
          account(r.playlist.source || "netease") === r.account,
    )
    .sort((a, b) => b.at - a.at)
    .map((r) => known.get(playlistKey(r.playlist)) || r.playlist);
}
export function sortPlaylists(
  items: Playlist[],
  account: (source: Source) => string,
): Playlist[] {
  const ranks = new Map(
    recents
      .filter(
        (r) =>
          r.playlist.internal ||
          r.account === account(r.playlist.source || "netease"),
      )
      .map((r) => [playlistKey(r.playlist), r.at]),
  );
  return [...items].sort(
    (a, b) =>
      (ranks.get(playlistKey(b)) || 0) - (ranks.get(playlistKey(a)) || 0),
  );
}
function orderKey(p: Playlist, account: string) {
  return `ting.playlist-order:${account}:${playlistKey(p)}`;
}
export function localOrder(p: Playlist, account: string): string[] {
  const v = read<unknown>(orderKey(p, account), []);
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
export function applyOrder(songs: Song[], order: string[]): Song[] {
  const ranks = new Map(order.map((id, i) => [id, i]));
  return [...songs].sort(
    (a, b) =>
      (ranks.get(songKey(a)) ?? Infinity) - (ranks.get(songKey(b)) ?? Infinity),
  );
}
function move(songs: Song[], song: Song, action: string): Song[] {
  const next = [...songs],
    from = next.findIndex((s) => songKey(s) === songKey(song));
  if (from < 0) throw new Error("歌曲已不在歌单中，请刷新");
  const to =
    action === "top"
      ? 0
      : action === "bottom"
        ? next.length - 1
        : action === "up"
          ? Math.max(0, from - 1)
          : Math.min(next.length - 1, from + 1);
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Options = {
  cloud: <T>(
    command: string,
    args?: Record<string, unknown>,
    source?: Source,
  ) => Promise<T>;
  sources: () => Source[];
  account: (source: Source) => string;
  changed: (p?: Playlist) => Promise<void>;
  toast: (message: string) => void;
  selected: () => Playlist | undefined;
};
export function setupLibrary(o: Options) {
  const dialog = document.createElement("dialog");
  dialog.id = "library-dialog";
  dialog.setAttribute("aria-labelledby", "library-title");
  document.body.append(dialog);
  let generation = 0,
    working = false;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) =>
    dialog.querySelector<T>(selector)!;
  const close = () => {
    if (!working) {
      generation++;
      dialog.close();
    }
  };
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  function screen(title: string, body: string) {
    generation++;
    working = false;
    dialog.innerHTML = `<button class="dialog-close icon-button" id="library-close" aria-label="关闭歌单操作">×</button><h2 id="library-title">${esc(title)}</h2>${body}<p id="library-error" role="alert" hidden></p>`;
    q("#library-close").onclick = close;
    if (!dialog.open) dialog.showModal();
  }
  function error(e: unknown) {
    q("#library-error").hidden = false;
    q("#library-error").textContent = String(e);
  }
  async function write(fn: () => Promise<void>, message: string, p?: Playlist) {
    if (working) return;
    working = true;
    generation++;
    q("#library-error").hidden = true;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    const states = buttons.map((b) => b.disabled);
    buttons.forEach((b) => (b.disabled = true));
    const status = document.createElement("p");
    status.className = "summary";
    status.textContent = "正在保存…";
    dialog.append(status);
    try {
      await fn();
      working = false;
      close();
      o.toast(message);
      await o.changed(p);
    } catch (e) {
      working = false;
      status.remove();
      buttons.forEach((b, i) => (b.disabled = states[i]));
      error(e);
    }
  }
  async function allTracks(p: Playlist) {
    const songs: Song[] = [];
    let offset = 0,
      total = Infinity;
    while (offset < total) {
      const page = await o.cloud<Page>(
        "playlist_tracks",
        { id: p.id, dirid: p.dirid, offset },
        p.source,
      );
      songs.push(...page.songs);
      total = page.total;
      if (page.nextOffset <= offset && page.nextOffset < total)
        throw new Error("歌单未完整加载，未保存排序，请重试");
      offset = page.nextOffset;
    }
    return uniqueSongs(songs) as Song[];
  }
  async function edit(p: Playlist, song: Song, action: string) {
    if (!p.owned) throw new Error("只能修改自己创建的歌单");
    if (p.internal) {
      updateInternal(p, (x) => ({
        ...x,
        songs:
          action === "add"
            ? uniqueSongs([...x.songs, song])
            : action === "remove"
              ? x.songs.filter((s) => songKey(s) !== songKey(song))
              : move(x.songs, song, action),
      }));
      return;
    }
    if (p.source === "qq" && !["add", "remove"].includes(action)) {
      const account = o.account("qq");
      if (!account) throw new Error("请先登录 QQ 音乐");
      const songs = applyOrder(await allTracks(p), localOrder(p, account));
      if (account !== o.account("qq"))
        throw new Error("账号已变化，请重新操作");
      localStorage.setItem(
        orderKey(p, account),
        JSON.stringify(move(songs, song, action).map(songKey)),
      );
      return;
    }
    if ((song.source || "netease") !== (p.source || "netease"))
      throw new Error("请先选择目标平台的歌曲版本");
    await o.cloud(
      "playlist_edit",
      { id: p.id, dirid: p.dirid, trackId: song.id, action },
      p.source,
    );
  }
  function create(song?: Song) {
    screen(
      "新建本机歌单",
      `<p class="summary">可混合收纳网易云和 QQ 歌曲。歌单离线保存在本机，可通过 iCloud 同步。在线歌曲仍需联网播放。</p><form id="playlist-name-form"><label for="playlist-name">歌单名称</label><input id="playlist-name" maxlength="60" required placeholder="给歌单起个名字"/><button class="primary" type="submit">${song ? "创建并加入" : "创建歌单"}</button></form>`,
    );
    q<HTMLFormElement>("#playlist-name-form").onsubmit = (e) => {
      e.preventDefault();
      const name = q<HTMLInputElement>("#playlist-name").value.trim();
      if (!name) return;
      void write(
        async () => {
          const random = crypto.getRandomValues(new Uint32Array(2));
          let id = (random[0] & 0x1fffff) * 0x100000000 + random[1];
          if (!id) id = 1;
          while (internal.some((p) => p.id === id)) id++;
          commit([
            ...internal,
            {
              internal: true,
              id,
              name,
              cover: "",
              creator: "本机",
              owned: true,
              trackCount: song ? 1 : 0,
              songs: song ? [song] : [],
            },
          ]);
        },
        song ? "已创建歌单并加入歌曲" : "已创建本机歌单",
      );
    };
    q("#playlist-name").focus();
  }
  function add(song: Song, p: Playlist) {
    void write(() => edit(p, song, "add"), `已加入「${p.name}」`, p);
  }
  async function matching(song: Song, p: Playlist) {
    const source = p.source || "netease";
    let candidates: Song[] = [],
      offset = 0,
      total = 0,
      chosen: Song | undefined;
    screen(
      `在${playlistLabel(p)}选择对应版本`,
      `<p class="summary">原曲：${esc(song.name)} · ${esc(song.artist)}<br>${esc(song.album)} · ${formatTime(song.duration / 1000)}<br>请核对歌手、专辑和时长，确认后加入「${esc(p.name)}」。</p><form id="match-form"><input id="match-query" aria-label="匹配歌曲关键词" maxlength="100" value="${esc(`${song.name} ${song.artist}`)}"/><button class="outline">搜索</button></form><div id="match-results"></div><button id="match-more" class="quiet" hidden>更多结果</button><button id="match-confirm" class="primary" disabled>确认版本并加入</button>`,
    );
    const token = generation;
    let request = 0;
    async function search(append = false) {
      const term = q<HTMLInputElement>("#match-query").value.trim();
      if (!term) return;
      const serial = ++request;
      q("#library-error").hidden = true;
      if (!append) {
        offset = 0;
        candidates = [];
        chosen = undefined;
        q<HTMLButtonElement>("#match-confirm").disabled = true;
        q("#match-results").textContent = "正在查找…";
      }
      q<HTMLButtonElement>("#match-more").disabled = true;
      try {
        const data = await o.cloud<{ songs: Song[]; total: number }>(
          "search_songs",
          { query: term, offset },
          source,
        );
        if (token !== generation || serial !== request) return;
        candidates = uniqueSongs([
          ...candidates,
          ...data.songs.map((s) => ({ ...s, source })),
        ]);
        offset += data.songs.length;
        total = data.total;
        q("#match-results").innerHTML = candidates.length
          ? candidates
              .map(
                (s, i) =>
                  `<button class="match-choice" data-candidate="${i}" aria-pressed="false"><strong>${esc(s.name)}</strong><span>${esc(s.artist)} · ${formatTime(s.duration / 1000)}</span><small>${esc(s.album)}</small></button>`,
              )
              .join("")
          : '<p class="summary">未找到对应歌曲。可修改关键词，或保留在本机混合歌单中。</p>';
        chosen = undefined;
        q<HTMLButtonElement>("#match-confirm").disabled = true;
        q("#match-more").hidden = offset >= total || !data.songs.length;
        q<HTMLButtonElement>("#match-more").disabled = false;
        dialog.querySelectorAll<HTMLButtonElement>("[data-candidate]").forEach(
          (button) =>
            (button.onclick = () => {
              chosen = candidates[Number(button.dataset.candidate)];
              dialog
                .querySelectorAll("[data-candidate]")
                .forEach((b) =>
                  b.setAttribute("aria-pressed", String(b === button)),
                );
              q<HTMLButtonElement>("#match-confirm").disabled = false;
            }),
        );
      } catch (e) {
        if (token === generation && serial === request) {
          error(e);
          q<HTMLButtonElement>("#match-more").disabled = false;
        }
      }
    }
    q<HTMLFormElement>("#match-form").onsubmit = (e) => {
      e.preventDefault();
      void search();
    };
    q("#match-more").onclick = () => void search(true);
    q("#match-confirm").onclick = () => {
      if (chosen) add(chosen, p);
    };
    void search();
  }
  async function choose(song: Song) {
    screen(
      "加入歌单",
      `<p class="summary">${esc(song.name)} · ${esc(song.artist)}<br>跨平台加入时会先让你确认对应歌曲版本。</p><button id="create-and-add" class="outline">＋ 新建本机歌单并加入</button><div class="target-filters" role="group" aria-label="目标歌单平台"><button data-target-filter="netease">网易云</button><button data-target-filter="qq">QQ音乐</button><button data-target-filter="internal">本机</button></div><div id="playlist-targets"></div><p id="target-status" class="summary">正在读取你的歌单…</p>`,
    );
    q("#create-and-add").onclick = () => create(song);
    const token = generation;
    const targets: Playlist[] = [...internalPlaylists()];
    const errors: string[] = [];
    let targetSource: string = song.source || "netease";
    function render() {
      dialog
        .querySelectorAll<HTMLElement>("[data-target-filter]")
        .forEach((b) =>
          b.setAttribute(
            "aria-pressed",
            String(b.dataset.targetFilter === targetSource),
          ),
        );
      q("#playlist-targets").innerHTML = targets
        .map((p, i) => ({ p, i }))
        .filter(({ p }) =>
          targetSource === "internal"
            ? p.internal
            : !p.internal && (p.source || "netease") === targetSource,
        )
        .map(
          ({ p, i }) =>
            `<button class="playlist-target" data-target="${i}"><strong>${esc(p.name)}</strong><span>${playlistLabel(p)}</span></button>`,
        )
        .join("");
      dialog.querySelectorAll<HTMLButtonElement>("[data-target]").forEach(
        (b) =>
          (b.onclick = () => {
            const p = targets[Number(b.dataset.target)];
            if (
              !p.internal &&
              (p.source || "netease") !== (song.source || "netease")
            )
              void matching(song, p);
            else add(song, p);
          }),
      );
    }
    dialog.querySelectorAll<HTMLButtonElement>("[data-target-filter]").forEach(
      (b) =>
        (b.onclick = () => {
          targetSource = b.dataset.targetFilter!;
          render();
        }),
    );
    render();
    await Promise.all(
      o.sources().map(async (source) => {
        let offset = 0,
          more = true;
        const account = o.account(source);
        try {
          while (more) {
            const data = await o.cloud<{
              playlists: Playlist[];
              more: boolean;
              nextOffset?: number;
            }>("my_playlists", { offset }, source);
            if (token !== generation || account !== o.account(source)) return;
            targets.push(
              ...data.playlists
                .filter((p) => p.owned)
                .map((p) => ({ ...p, source })),
            );
            render();
            more = data.more;
            const next = data.nextOffset ?? offset + data.playlists.length;
            if (next <= offset && more)
              throw new Error("歌单未完整返回，请稍后重试");
            offset = next;
          }
        } catch (e) {
          errors.push(String(e));
        }
      }),
    );
    if (token !== generation) return;
    q("#target-status").textContent = errors.length
      ? errors.join("；")
      : targets.length
        ? "仅显示自己创建的歌单。"
        : "暂无可编辑歌单，可新建本机歌单或先登录账号。";
  }
  function songMenu(song: Song) {
    const p = o.selected();
    const editable = !!p?.owned;
    screen(
      song.name,
      `<p class="summary">${esc(song.artist)} · ${song.source === "qq" ? "QQ音乐" : "网易云"}</p><div class="library-actions"><button id="song-add" class="outline">加入歌单…</button>${
        editable
          ? `<button id="song-remove" class="outline">从此歌单移除…</button><p class="summary">调整顺序${p!.source === "qq" && !p!.internal ? " · 仅本机，重开后保留" : p!.internal ? " · 保存在本机" : " · 同步到网易云"}</p><div class="move-actions">${[
              ["up", "上移"],
              ["down", "下移"],
              ["top", "置顶"],
              ["bottom", "置底"],
            ]
              .map(
                ([action, label]) =>
                  `<button class="outline" data-move="${action}">${label}</button>`,
              )
              .join("")}</div>`
          : ""
      }</div>`,
    );
    q("#song-add").onclick = () => void choose(song);
    if (editable) {
      q("#song-remove").onclick = () => {
        screen(
          "移除歌曲",
          `<p class="summary">将「${esc(song.name)}」从「${esc(p!.name)}」移除${p!.internal ? "" : "，同步到" + playlistLabel(p!)}。当前播放队列不变。</p><button id="confirm-remove" class="primary">确认移除</button>`,
        );
        q("#confirm-remove").onclick = () =>
          void write(() => edit(p!, song, "remove"), "已从歌单移除", p);
      };
      dialog
        .querySelectorAll<HTMLButtonElement>("[data-move]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              void write(
                () => edit(p!, song, b.dataset.move!),
                p!.source === "qq" && !p!.internal
                  ? "已保存本机顺序"
                  : "已调整歌单顺序",
                p,
              )),
        );
    }
  }
  function manage(p: Playlist) {
    screen(
      "管理歌单",
      `<p class="summary">${esc(p.name)} · ${playlistLabel(p)}<br>歌曲的加入、移除、排序可从每首歌右侧的“…”操作。</p>${p.internal ? `<form id="rename-form"><label for="playlist-name">歌单名称</label><input id="playlist-name" maxlength="60" value="${esc(p.name)}" required/><button class="outline">保存名称</button></form><button id="delete-playlist" class="quiet">删除本机歌单…</button>` : p.source === "qq" ? '<p class="summary">增删歌曲同步到 QQ；排序只保存在本机。</p><button id="reset-order" class="outline">恢复 QQ 原始顺序</button>' : '<p class="summary">增删歌曲和排序同步到网易云。</p>'}`,
    );
    if (p.internal) {
      q<HTMLFormElement>("#rename-form").onsubmit = (e) => {
        e.preventDefault();
        const name = q<HTMLInputElement>("#playlist-name").value.trim();
        if (name)
          void write(
            async () => updateInternal(p, (x) => ({ ...x, name })),
            "已更新名称",
            p,
          );
      };
      q("#delete-playlist").onclick = () => {
        screen(
          "删除本机歌单",
          `<p class="summary">确定删除「${esc(p.name)}」？只删除本机歌单，平台歌曲不受影响。</p><button id="confirm-delete" class="primary">确认删除歌单</button>`,
        );
        q("#confirm-delete").onclick = () =>
          void write(
            async () => commit(internal.filter((x) => x.id !== p.id)),
            "已删除本机歌单",
            p,
          );
      };
    } else if (p.source === "qq") {
      q("#reset-order").onclick = () =>
        void write(
          async () => localStorage.removeItem(orderKey(p, o.account("qq"))),
          "已恢复 QQ 原始顺序",
          p,
        );
    }
  }
  return { create: () => create(), songMenu, manage };
}
