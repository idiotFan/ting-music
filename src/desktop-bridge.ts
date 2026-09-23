import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { $ } from "./dom";
import { backupName, createBackup, restoreBackup } from "./backup";
import { recent as recentDiagnostics } from "./diagnostics";
import { mobileDevice, platform } from "./platform";
import { setupSettingsPanel } from "./settings-panel";
import type { Song } from "./library";
import type { Sound } from "./sound";
import type { LyricLine, PlayerCommand, PlayerState } from "./panel-state";

/**
 * Everything around the player on the desktop and in settings: the mini
 * player and floating lyrics windows (state out, commands in), the tray line,
 * backups, diagnostics, and the settings sheet that ties them together.
 * main.ts owns playback; this module only reads it through the context.
 */
type Context = {
  audio: HTMLAudioElement;
  sound: Sound;
  toast: (message: string) => void;
  current: () => Song | undefined;
  /** What the play button shows (optimistic while a song is loading). */
  playing: () => boolean;
  /** The current (0) or next (1) lyric line. */
  lyric: (offset: 0 | 1) => string | undefined;
  toggle: () => void;
  skip: (delta: number) => void;
  volumeChanged: () => void;
  openSound: () => void;
  counts: () => Record<string, unknown>;
  quality: {
    value: () => string;
    names: Record<string, string>;
    set: (value: string) => void;
  };
  localsChanged: () => void;
};

export function setupDesktopBridge(o: Context) {
  // ---- Desktop windows: mini player, floating lyrics, tray -----------------
  const nativeDesktop = isTauri() && !mobileDevice;
  let floatOpen = false,
    floatLocked = false,
    stateTimer = 0,
    trayKey = "";
  function playerState(): PlayerState {
    return {
      title: o.current()?.name || "",
      artist: o.current()?.artist || "",
      cover: o.current()?.cover || "",
      playing: o.playing(),
      position: o.audio.currentTime || 0,
      duration: Number.isFinite(o.audio.duration) ? o.audio.duration : 0,
      hasSong: !!o.current(),
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
      text: o.lyric(0) || o.current()?.name || "",
      next: o.lyric(1) || "",
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
      o.toast(String(e));
    }
  }
  function lockFloatLyrics(locked: boolean) {
    floatLocked = locked;
    void invoke("float_lyrics_lock", { locked }).catch((e) =>
      o.toast(String(e)),
    );
    lastLyricKey = "";
    broadcastLyric();
    if (locked) o.toast("桌面歌词已锁定，可在托盘菜单或设置中解锁");
  }
  if (nativeDesktop) {
    o.audio.addEventListener("play", () => broadcast(true));
    o.audio.addEventListener("pause", () => broadcast(true));
    o.audio.addEventListener("timeupdate", () => {
      broadcast();
      broadcastLyric();
    });
    listen<PlayerCommand>("player-command", ({ payload }) => {
      switch (payload) {
        case "toggle":
          return o.toggle();
        case "previous":
          return o.skip(-1);
        case "next":
          return o.skip(1);
        case "volume-up":
        case "volume-down":
          o.sound.setVolume(
            o.sound.volume + (payload === "volume-up" ? 0.05 : -0.05),
          );
          o.audio.muted = false;
          return o.volumeChanged();
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
      if (path) o.toast(`${what}已保存：${path}`);
    } catch (e) {
      o.toast(String(e));
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
      // Reload at once: modules still holding the old data in memory must not
      // write it back over what was just restored.
      sessionStorage.setItem(
        "ting.restored",
        `已恢复：新增歌单 ${result.playlists} 个、歌曲 ${result.songs} 首、本地音乐 ${result.locals} 首`,
      );
      location.reload();
    } catch (e) {
      o.toast(e instanceof Error ? e.message : String(e));
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
      library: o.counts(),
      sound: {
        normalize: o.sound.normalize,
        eq: o.sound.preset,
        crossfade: o.sound.crossfade,
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
  const restored = sessionStorage.getItem("ting.restored");
  if (restored) {
    sessionStorage.removeItem("ting.restored");
    window.setTimeout(() => o.toast(restored), 600);
  }
  setupSettingsPanel({
    toast: o.toast,
    quality: o.quality,
    openSound: () => o.openSound(),
    openTheme: () => $("#theme-button").click(),
    exportBackup: () =>
      saveFile(backupName(), JSON.stringify(createBackup(), null, 1), "备份"),
    importBackup: importBackupFile,
    exportDiagnostics,
    localsChanged: o.localsChanged,
    floatLyrics: {
      open: () => floatOpen,
      toggle: () => void toggleFloatLyrics(),
      locked: () => floatLocked,
      lock: lockFloatLyrics,
    },
    miniPlayer: () =>
      void invoke("mini_player").catch((e) => o.toast(String(e))),
    version: () =>
      appVersion ? `版本 ${appVersion}` : "版本信息仅在应用内可见",
  });
  return {
    /** Push the player state now (a new song, play / pause). */
    broadcast,
    /** The lyrics changed wholesale (a new song); resend the line. */
    resetLyric: () => {
      lastLyricKey = "";
    },
  };
}
