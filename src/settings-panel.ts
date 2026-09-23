import { invoke, isTauri } from "@tauri-apps/api/core";
import { $, icon, keepFocus } from "./dom";
import { esc } from "./library";
import { animateContent, closeDialog, openDialog } from "./motion";
import { pageScale, SCALES, setPageScale } from "./page-scale";
import { readSetting, writeSetting } from "./settings";
import {
  autoImport,
  downloadFolder,
  forgetFolder,
  localFolders,
  scanLocals,
  setAutoImport,
} from "./local-library";

/**
 * 设置: one sheet for the preferences that used to be scattered — playback,
 * appearance, local files and downloads, the desktop extras (tray, mini
 * player, floating lyrics, global shortcuts), backups and diagnostics.
 */
export const SHORTCUT_ACTIONS: [string, string][] = [
  ["toggle", "播放 / 暂停"],
  ["previous", "上一首"],
  ["next", "下一首"],
  ["volume-up", "音量加"],
  ["volume-down", "音量减"],
  ["lyrics", "桌面歌词"],
  ["mini", "迷你播放器"],
];
const DEFAULT_SHORTCUTS: Record<string, string> = {
  toggle: "CmdOrCtrl+Alt+Space",
  previous: "CmdOrCtrl+Alt+Left",
  next: "CmdOrCtrl+Alt+Right",
  "volume-up": "CmdOrCtrl+Alt+Up",
  "volume-down": "CmdOrCtrl+Alt+Down",
  lyrics: "CmdOrCtrl+Alt+L",
  mini: "CmdOrCtrl+Alt+M",
};
type DesktopPrefs = {
  closeToTray: boolean;
  shortcutsOn: boolean;
  shortcuts: Record<string, string>;
};
export function desktopPrefs(): DesktopPrefs {
  try {
    const saved = JSON.parse(readSetting("ting.desktop", "{}"));
    return {
      closeToTray: saved.closeToTray === true,
      shortcutsOn: saved.shortcutsOn === true,
      shortcuts: { ...DEFAULT_SHORTCUTS, ...(saved.shortcuts || {}) },
    };
  } catch {
    return {
      closeToTray: false,
      shortcutsOn: false,
      shortcuts: { ...DEFAULT_SHORTCUTS },
    };
  }
}
async function saveDesktop(prefs: DesktopPrefs) {
  writeSetting("ting.desktop", JSON.stringify(prefs));
  await invoke("desktop_prefs", {
    prefs: {
      close_to_tray: prefs.closeToTray,
      shortcuts: prefs.shortcutsOn ? prefs.shortcuts : {},
    },
  });
}
const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
/** "CmdOrCtrl+Alt+Right" as the keys printed on this keyboard. */
export function shortcutLabel(accelerator: string) {
  return accelerator
    .split("+")
    .map((k) =>
      k === "CmdOrCtrl"
        ? mac
          ? "⌘"
          : "Ctrl"
        : k === "Alt"
          ? mac
            ? "⌥"
            : "Alt"
          : k === "Shift"
            ? mac
              ? "⇧"
              : "Shift"
            : k === "Control"
              ? mac
                ? "⌃"
                : "Ctrl"
              : { Left: "←", Right: "→", Up: "↑", Down: "↓", Space: "空格" }[
                  k
                ] || k,
    )
    .join(mac ? "" : "+");
}
/** A key press as an accelerator; undefined until it has a real key. */
export function acceleratorOf(e: KeyboardEvent): string | undefined {
  const named: Record<string, string> = {
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    ArrowDown: "Down",
    " ": "Space",
  };
  let key =
    named[e.key] ||
    (e.key.length === 1
      ? e.key.toUpperCase()
      : /^F\d{1,2}$/.test(e.key)
        ? e.key
        : "");
  if (!key || ["Meta", "Control", "Alt", "Shift"].includes(e.key))
    return undefined;
  if (e.code?.startsWith("Key")) key = e.code.slice(3);
  if (e.code?.startsWith("Digit")) key = e.code.slice(5);
  const mods = [
    e.metaKey || (!mac && e.ctrlKey) ? "CmdOrCtrl" : "",
    mac && e.ctrlKey ? "Control" : "",
    e.altKey ? "Alt" : "",
    e.shiftKey ? "Shift" : "",
  ].filter(Boolean);
  // A global shortcut must include Cmd/Ctrl (or Control on a Mac); Shift or
  // Option alone would swallow ordinary typing in every other app.
  const strong = mods.includes("CmdOrCtrl") || mods.includes("Control");
  if (!strong && !/^F\d/.test(key)) return undefined;
  return [...mods, key].join("+");
}

type Options = {
  toast: (message: string) => void;
  quality: {
    value: () => string;
    names: Record<string, string>;
    set: (v: string) => void;
  };
  openSound: () => void;
  openTheme: () => void;
  exportBackup: () => Promise<void>;
  importBackup: () => Promise<void>;
  exportDiagnostics: () => Promise<void>;
  /** The local shelf changed (a folder was forgotten or rescanned). */
  localsChanged: () => void;
  floatLyrics: {
    open: () => boolean;
    toggle: () => void;
    locked: () => boolean;
    lock: (on: boolean) => void;
  };
  miniPlayer: () => void;
  version: () => string;
};

export function setupSettingsPanel(o: Options) {
  const native = isTauri();
  const desktop =
    native && !document.documentElement.classList.contains("mobile-device");
  const dialog = document.createElement("dialog");
  dialog.id = "settings-dialog";
  dialog.dataset.presentation = "page";
  dialog.setAttribute("aria-labelledby", "settings-title");
  document.body.append(dialog);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (recording) stopRecording();
    else closeDialog(dialog);
  });
  let downloadPath = "";
  let recording: string | undefined;
  let prefs = desktopPrefs();

  // A row holding a switch is a <label>, so tapping its text flips it too.
  const row = (title: string, detail: string, control: string) => {
    const tag = control.includes('class="toggle"') ? "label" : "div";
    return `<${tag} class="setting-row"><span><strong>${title}</strong>${detail ? `<small>${detail}</small>` : ""}</span>${control}</${tag}>`;
  };
  const toggle = (id: string, on: boolean) =>
    `<span class="toggle"><input type="checkbox" role="switch" id="${id}" ${on ? "checked" : ""}/><i aria-hidden="true"></i></span>`;

  const phone = document.documentElement.classList.contains("mobile-device");
  /** Phones: a full-screen page in the iOS grouped-list idiom. */
  function renderPhone() {
    const q = o.quality;
    const cell = (label: string, trailing: string) =>
      `<div class="cell"><span class="cell-label">${label}</span>${trailing}</div>`;
    const nav = (label: string, value: string, data: string) =>
      `<button class="cell nav" ${data}><span class="cell-label">${label}</span><span class="cell-value">${value}</span>${icon("ChevronRight")}</button>`;
    const action = (label: string, data: string) =>
      `<button class="cell action" ${data}><span class="cell-label">${label}</span></button>`;
    const group = (title: string, cells: string[], footer = "") =>
      `<section class="cell-group"><h3>${title}</h3><div class="cells">${cells.join("")}</div>${footer ? `<p class="cell-footer">${footer}</p>` : ""}</section>`;
    const toggleCell = (label: string, id: string, on: boolean) =>
      `<label class="cell"><span class="cell-label">${label}</span>${toggle(id, on)}</label>`;
    const parts = [
      `<header class="sheet-nav"><span></span><h2 id="settings-title">设置</h2><button class="sheet-done" data-settings-close>完成</button></header>`,
      group(
        "播放",
        [
          cell(
            "音质",
            `<span class="cell-select"><select id="settings-quality" aria-label="音质">${Object.entries(
              q.names,
            )
              .map(
                ([v, label]) =>
                  `<option value="${v}" ${v === q.value() ? "selected" : ""}>${label}</option>`,
              )
              .join("")}</select>${icon("ChevronRight")}</span>`,
          ),
          nav("音效与睡眠定时", "", "data-open-sound"),
        ],
        "音质按账号权限提供，播放区显示实际返回的档位。",
      ),
      group("外观", [nav("主题配色", "", "data-open-theme")]),
    ];
    if (native)
      parts.push(
        group(
          "本地与下载",
          [
            toggleCell(
              "下载后自动加入本地",
              "settings-auto-import",
              autoImport(),
            ),
          ],
          "下载完成的歌曲会出现在「本地」，在线播放时优先用手机里的文件。",
        ),
      );
    parts.push(
      group(
        "数据",
        [
          action("导出备份", 'data-backup="export"'),
          action("从备份恢复", 'data-backup="import"'),
        ],
        "包含收藏、本机歌单、本地音乐、最近播放与偏好，不含账号登录。",
      ),
      group(
        "关于",
        [
          cell(
            "版本",
            `<span class="cell-value">${esc(o.version().replace(/^版本\s*/, ""))}</span>`,
          ),
          action("导出诊断信息", "data-diagnostics"),
        ],
        "诊断信息含版本、系统、曲库数量和最近的提示与错误摘要；文件路径、网址参数与登录凭据已去除。",
      ),
    );
    keepFocus(dialog, () => (dialog.innerHTML = parts.join("")));
  }
  function render() {
    if (phone) return renderPhone();
    const q = o.quality;
    const scale = pageScale();
    const parts = [
      `<button class="dialog-close icon-button" data-settings-close aria-label="关闭设置">${icon("X")}</button><h2 id="settings-title">设置</h2>`,
      `<section><h3>播放</h3>${row(
        "音质",
        "按账号权限提供，播放区显示实际返回的档位",
        `<select id="settings-quality">${Object.entries(q.names)
          .map(
            ([v, label]) =>
              `<option value="${v}" ${v === q.value() ? "selected" : ""}>${label}</option>`,
          )
          .join("")}</select>`,
      )}${row("音效与睡眠定时", "响度均衡、均衡器、淡入淡出、定时停止", `<button class="outline" data-open-sound>打开</button>`)}</section>`,
      `<section><h3>外观</h3>${row("主题配色", "11 套配色，可跟随系统深浅色", `<button class="outline" data-open-theme>选择</button>`)}${row(
        "界面缩放",
        `当前 ${Math.round(scale * 100)}%${desktop ? " · 也可用 ⌘/Ctrl 加减号调整" : ""}`,
        `<div class="scale-steps" role="group" aria-label="界面缩放">${SCALES.map(
          (s) =>
            `<button data-scale="${s}" aria-pressed="${s === scale}">${Math.round(s * 100)}%</button>`,
        ).join("")}</div>`,
      )}</section>`,
    ];
    if (native)
      parts.push(
        `<section><h3>本地与下载</h3>${row("下载后自动加入本地", "下载完成的歌曲出现在「本地」，在线播放时优先用本机文件", toggle("settings-auto-import", autoImport()))}${
          desktop
            ? row(
                "下载文件夹",
                esc(downloadPath || downloadFolder || "默认：下载 / Ting"),
                `<span class="row-buttons"><button class="outline" data-download-dir="pick">更改</button><button class="quiet" data-download-dir="reset">默认</button></span>`,
              )
            : ""
        }${
          localFolders.length
            ? `<div class="folder-list"><small>自动发现新歌的文件夹</small>${localFolders
                .map(
                  (f, i) =>
                    `<div class="folder-row"><span title="${esc(f)}">${esc(f)}</span><button class="quiet" data-forget-folder="${i}">移除</button></div>`,
                )
                .join("")}</div>`
            : ""
        }</section>`,
      );
    if (desktop)
      parts.push(
        `<section><h3>桌面</h3>${row("关闭窗口时留在托盘", "音乐继续播放，从托盘（菜单栏）图标回到主窗口", toggle("settings-tray", prefs.closeToTray))}${row(
          "迷你播放器",
          "置顶的小窗，只留封面和播放控制",
          `<button class="outline" data-mini>打开 / 关闭</button>`,
        )}${row(
          "桌面歌词",
          o.floatLyrics.open()
            ? "已打开；锁定后鼠标可以穿透歌词"
            : "悬浮在所有窗口之上",
          `<span class="row-buttons"><button class="outline" data-float-lyrics>${o.floatLyrics.open() ? "关闭" : "打开"}</button>${
            o.floatLyrics.open()
              ? `<button class="quiet" data-float-lock>${o.floatLyrics.locked() ? "解锁" : "锁定"}</button>`
              : ""
          }</span>`,
        )}${row("全局快捷键", "应用在后台时也能控制播放", toggle("settings-shortcuts", prefs.shortcutsOn))}${
          prefs.shortcutsOn
            ? `<div class="shortcut-list">${SHORTCUT_ACTIONS.map(
                ([action, label]) =>
                  `<div class="shortcut-row"><span>${label}</span><button class="shortcut-key${recording === action ? " recording" : ""}" data-record="${action}">${
                    recording === action
                      ? "请按下新组合…"
                      : esc(shortcutLabel(prefs.shortcuts[action] || "")) ||
                        "未设置"
                  }</button></div>`,
              ).join(
                "",
              )}<button class="quiet" data-shortcuts-reset>恢复默认快捷键</button></div>`
            : ""
        }</section>`,
      );
    parts.push(
      `<section><h3>数据</h3>${row("备份与恢复", "收藏、本机歌单、本地音乐、最近播放与偏好；不含账号登录", `<span class="row-buttons"><button class="outline" data-backup="export">导出</button><button class="outline" data-backup="import">导入</button></span>`)}</section>`,
      `<section><h3>关于</h3>${row("听 · Ting", esc(o.version()), `<button class="outline" data-diagnostics>导出诊断信息</button>`)}<small class="summary">诊断信息含版本、系统、曲库数量和最近的提示与错误摘要；文件路径、网址参数与登录凭据已去除。</small></section>`,
    );
    keepFocus(dialog, () => (dialog.innerHTML = parts.join("")));
  }

  async function refreshDownloadPath() {
    if (!desktop) return;
    try {
      downloadPath = await invoke<string>("download_dir", {
        pick: false,
        reset: false,
      });
      if (dialog.open) render();
    } catch {
      /* The default still applies. */
    }
  }
  function stopRecording() {
    recording = undefined;
    render();
  }
  async function applyDesktop(next: DesktopPrefs) {
    prefs = next;
    render();
    try {
      await saveDesktop(prefs);
    } catch (e) {
      o.toast(String(e));
    }
  }

  dialog.addEventListener("keydown", (e) => {
    if (!recording || e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return stopRecording();
    const accelerator = acceleratorOf(e);
    if (!accelerator) return;
    const action = recording;
    recording = undefined;
    // One combination drives one action; taking it moves it here.
    const shortcuts = Object.fromEntries(
      Object.entries(prefs.shortcuts).map(([k, v]) => [
        k,
        v === accelerator ? "" : v,
      ]),
    );
    void applyDesktop({
      ...prefs,
      shortcuts: { ...shortcuts, [action]: accelerator },
    });
  });
  dialog.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === "settings-quality") o.quality.set(el.value);
    else if (el.id === "settings-auto-import") {
      setAutoImport(el.checked);
      if (el.checked)
        void scanLocals(true).then((added) => {
          if (added.length) {
            o.localsChanged();
            o.toast(`已把 ${added.length} 首下载的歌曲加入本地音乐`);
          }
        });
    } else if (el.id === "settings-tray")
      void applyDesktop({ ...prefs, closeToTray: el.checked });
    else if (el.id === "settings-shortcuts")
      void applyDesktop({ ...prefs, shortcutsOn: el.checked });
  });
  dialog.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-settings-close]")) return closeDialog(dialog);
    // Phones push the sheet on top and come back here; desktop swaps.
    if (el.closest("[data-open-sound]")) {
      if (!phone) closeDialog(dialog);
      return o.openSound();
    }
    if (el.closest("[data-open-theme]")) {
      if (!phone) closeDialog(dialog);
      return o.openTheme();
    }
    const scale = el.closest<HTMLElement>("[data-scale]");
    if (scale) {
      setPageScale(Number(scale.dataset.scale));
      return render();
    }
    const dir = el.closest<HTMLElement>("[data-download-dir]");
    if (dir) {
      try {
        downloadPath = await invoke<string>("download_dir", {
          pick: dir.dataset.downloadDir === "pick",
          reset: dir.dataset.downloadDir === "reset",
        });
        render();
        if (autoImport())
          void scanLocals(true).then((a) => a.length && o.localsChanged());
      } catch (err) {
        o.toast(String(err));
      }
      return;
    }
    const forget = el.closest<HTMLElement>("[data-forget-folder]");
    if (forget) {
      const folder = localFolders[Number(forget.dataset.forgetFolder)];
      if (!folder) return;
      const removed = await forgetFolder(folder);
      o.localsChanged();
      o.toast(
        removed
          ? `已移除文件夹及其中 ${removed} 首歌曲（文件本身未删除）`
          : "已不再扫描这个文件夹",
      );
      return render();
    }
    if (el.closest("[data-mini]")) return o.miniPlayer();
    if (el.closest("[data-float-lyrics]")) {
      o.floatLyrics.toggle();
      return window.setTimeout(render, 150);
    }
    if (el.closest("[data-float-lock]")) {
      o.floatLyrics.lock(!o.floatLyrics.locked());
      return render();
    }
    const record = el.closest<HTMLElement>("[data-record]");
    if (record) {
      recording = record.dataset.record;
      render();
      dialog
        .querySelector<HTMLElement>(`[data-record="${recording}"]`)
        ?.focus();
      return;
    }
    if (el.closest("[data-shortcuts-reset]"))
      return void applyDesktop({
        ...prefs,
        shortcuts: { ...DEFAULT_SHORTCUTS },
      });
    const backup = el.closest<HTMLElement>("[data-backup]");
    if (backup)
      return backup.dataset.backup === "export"
        ? o.exportBackup()
        : o.importBackup();
    if (el.closest("[data-diagnostics]")) return o.exportDiagnostics();
  });
  window.addEventListener("ting:scale", () => dialog.open && render());

  $("#settings-button").onclick = () => {
    recording = undefined;
    prefs = desktopPrefs();
    render();
    openDialog(dialog);
    // The phone page slides in whole; only the desktop sheet eases its rows.
    if (!phone) animateContent(dialog, { distance: 5 });
    void refreshDownloadPath();
  };
  return { rerender: () => dialog.open && render() };
}
