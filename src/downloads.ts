import { invoke } from "@tauri-apps/api/core";
import { $, icon } from "./dom";
import { esc, type Song } from "./library";
import { songKey } from "./model.mjs";
import { animateContent, closeDialog, openDialog } from "./motion";

/**
 * The download queue: whole albums and playlists go in, two songs download at
 * a time (the backend allows no more), failures wait for a retry, and songs
 * still waiting survive a restart — they come back paused, never silently.
 */
export type DownloadResult = {
  path: string;
  filename: string;
  source: string;
  level: string;
  format: string;
  bitrate: number;
  sampleRate: number;
  bitDepth: number;
  warnings: string[];
};
type Status = "waiting" | "active" | "done" | "failed";
type Item = {
  key: string;
  song: Song;
  status: Status;
  message?: string;
  result?: DownloadResult;
};
type Options = {
  toast: (message: string) => void;
  /** Why a song cannot be queued (local file, already downloaded), if so. */
  refuse: (song: Song) => string | undefined;
  /** Each change of a song's state, for the player's own status line. */
  changed: (
    song: Song,
    status: Status,
    detail?: DownloadResult | string,
  ) => void;
  /** A batch of files landed; the local shelf should look for them. */
  saved: () => void;
};

const STORE = "ting.download-queue";
const CONCURRENCY = 2;

export function setupDownloads(o: Options) {
  let items: Item[] = [];
  let paused = false;
  let savedTimer = 0;

  const dialog = document.createElement("dialog");
  dialog.id = "downloads-dialog";
  dialog.setAttribute("aria-labelledby", "downloads-title");
  document.body.append(dialog);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog(dialog);
  });

  const button = $("#downloads-button");

  function persist() {
    const keep = items
      .filter(
        (i) =>
          i.status === "waiting" ||
          i.status === "active" ||
          i.status === "failed",
      )
      .map((i) => ({
        song: i.song,
        failed: i.status === "failed" ? i.message || "下载失败" : undefined,
      }));
    try {
      if (keep.length) localStorage.setItem(STORE, JSON.stringify(keep));
      else localStorage.removeItem(STORE);
    } catch {
      /* The queue still runs; it just would not survive a restart. */
    }
  }
  function counts() {
    const by = (s: Status) => items.filter((i) => i.status === s).length;
    return {
      waiting: by("waiting"),
      active: by("active"),
      done: by("done"),
      failed: by("failed"),
    };
  }
  function renderButton() {
    const c = counts();
    const open = c.waiting + c.active;
    button.hidden = !items.length;
    button.classList.toggle("is-busy", c.active > 0);
    button.querySelector(".downloads-count")!.textContent = open
      ? String(open)
      : c.failed
        ? "!"
        : "";
    button.setAttribute(
      "aria-label",
      open
        ? `下载队列：${open} 首进行中`
        : c.failed
          ? `下载队列：${c.failed} 首失败`
          : "下载队列",
    );
  }
  const label: Record<Status, string> = {
    waiting: "等待中",
    active: "下载中…",
    done: "已完成",
    failed: "失败",
  };
  function render() {
    renderButton();
    if (!dialog.open) return;
    const c = counts();
    const rows = items
      .map(
        (item, i) =>
          `<li class="download-item" data-status="${item.status}"><div><strong>${esc(item.song.name)}</strong><small>${esc(item.song.artist)}${item.message ? ` · ${esc(item.message)}` : ""}</small></div><span class="download-state">${item.status === "active" ? icon("LoaderCircle") : ""}${label[item.status]}</span>${
            item.status === "waiting"
              ? `<button class="icon-button" data-download-cancel="${i}" aria-label="取消下载 ${esc(item.song.name)}">${icon("X")}</button>`
              : item.status === "failed"
                ? `<button class="quiet" data-download-retry="${i}">重试</button>`
                : ""
          }</li>`,
      )
      .join("");
    dialog.innerHTML = `<button class="dialog-close icon-button" data-downloads-close aria-label="关闭下载队列">${icon("X")}</button><h2 id="downloads-title">下载队列</h2><p class="summary">${c.active ? `正在下载 ${c.active} 首` : paused && c.waiting ? "已暂停" : c.waiting ? "准备下载" : "没有进行中的下载"}${c.waiting ? ` · 等待 ${c.waiting} 首` : ""}${c.done ? ` · 完成 ${c.done} 首` : ""}${c.failed ? ` · 失败 ${c.failed} 首` : ""}</p><div class="download-actions">${
      c.waiting
        ? `<button class="outline" data-downloads-toggle>${paused ? "继续下载" : "暂停队列"}</button>`
        : ""
    }${c.failed ? '<button class="outline" data-downloads-retry>全部重试</button>' : ""}${c.done || c.failed ? '<button class="quiet" data-downloads-clear>清除已结束</button>' : ""}</div><ol class="download-list">${rows || '<li class="summary">队列是空的</li>'}</ol><p class="summary download-note">暂停只停止开始新的下载，进行中的歌曲会下载完成。</p>`;
  }
  function changed(item: Item, detail?: DownloadResult | string) {
    o.changed(item.song, item.status, detail);
    persist();
    render();
  }
  async function run(item: Item) {
    item.status = "active";
    item.message = undefined;
    changed(item);
    try {
      const result = await invoke<DownloadResult>("download_song", {
        id: item.song.id,
        source: item.song.source || "netease",
      });
      item.status = "done";
      item.result = result;
      if (result.warnings.length) item.message = result.warnings.join("；");
      changed(item, result);
      clearTimeout(savedTimer);
      savedTimer = window.setTimeout(o.saved, 300);
    } catch (e) {
      item.status = "failed";
      item.message = e instanceof Error ? e.message : String(e);
      changed(item, item.message);
    }
    pump();
  }
  function pump() {
    if (paused) return;
    while (items.filter((i) => i.status === "active").length < CONCURRENCY) {
      const next = items.find((i) => i.status === "waiting");
      if (!next) break;
      void run(next);
    }
    if (!items.some((i) => i.status === "waiting" || i.status === "active")) {
      const c = counts();
      if (c.done + c.failed > 1 && !dialog.open)
        o.toast(
          c.failed
            ? `下载结束：成功 ${c.done} 首，失败 ${c.failed} 首`
            : `已下载 ${c.done} 首`,
        );
    }
  }

  /** Queues songs; returns how many were new (already queued / refused skip). */
  function enqueue(songs: Song[]) {
    let added = 0;
    const reasons = new Set<string>();
    for (const song of songs) {
      const reason = o.refuse(song);
      if (reason) {
        reasons.add(reason);
        continue;
      }
      const key = songKey(song);
      const existing = items.find((i) => i.key === key);
      if (
        existing &&
        existing.status !== "done" &&
        existing.status !== "failed"
      )
        continue;
      if (existing) items = items.filter((i) => i !== existing);
      items.push({ key, song, status: "waiting" });
      added++;
    }
    if (added) {
      persist();
      render();
      pump();
    } else if (reasons.size) o.toast([...reasons][0]);
    renderButton();
    return added;
  }
  const statusOf = (song: Song | undefined): Status | undefined =>
    song && items.find((i) => i.key === songKey(song))?.status;

  dialog.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-downloads-close]")) closeDialog(dialog);
    else if (el.closest("[data-downloads-toggle]")) {
      paused = !paused;
      render();
      pump();
    } else if (el.closest("[data-downloads-retry]")) {
      items.forEach(
        (i) =>
          i.status === "failed" &&
          ((i.status = "waiting"), (i.message = undefined)),
      );
      paused = false;
      persist();
      render();
      pump();
    } else if (el.closest("[data-downloads-clear]")) {
      items = items.filter(
        (i) => i.status === "waiting" || i.status === "active",
      );
      persist();
      render();
    } else {
      const cancel = el.closest<HTMLElement>("[data-download-cancel]");
      const retry = el.closest<HTMLElement>("[data-download-retry]");
      const item =
        items[
          Number(
            (cancel || retry)?.dataset.downloadCancel ??
              retry?.dataset.downloadRetry,
          )
        ];
      if (!item) return;
      if (cancel && item.status === "waiting") {
        items = items.filter((i) => i !== item);
        o.changed(item.song, "done");
      } else if (retry && item.status === "failed") {
        item.status = "waiting";
        item.message = undefined;
      }
      persist();
      render();
      pump();
    }
  });
  button.onclick = () => {
    openDialog(dialog);
    render();
    animateContent(dialog, { distance: 5 });
  };

  // Songs left waiting at the last close come back paused.
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "[]");
    if (Array.isArray(saved))
      items = saved
        .filter(
          (x) =>
            x &&
            x.song &&
            Number.isSafeInteger(x.song.id) &&
            x.song.id > 0 &&
            typeof x.song.name === "string",
        )
        .map((x) => ({
          key: songKey(x.song),
          song: x.song,
          status: x.failed ? ("failed" as const) : ("waiting" as const),
          message: x.failed || undefined,
        }));
  } catch {
    items = [];
  }
  if (items.some((i) => i.status === "waiting")) {
    paused = true;
    o.toast(
      `有 ${items.filter((i) => i.status === "waiting").length} 首歌曲等待下载，打开下载队列可继续`,
    );
  }
  renderButton();
  return { enqueue, statusOf };
}
