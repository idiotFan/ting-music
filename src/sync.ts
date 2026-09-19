import { animateContent, openDialog, closeDialog } from "./motion";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { platform } from "./platform";
import {
  startSyncLibrary,
  syncDevice,
  pendingLibraryChanges,
  acceptSyncLibrary,
} from "./library";
import type { SavedPlaylist } from "./library-sync-model";
type Status = {
  device: string;
  playlists: SavedPlaylist[];
  ack: string[];
  connected: boolean;
  folder?: string;
  icloud: boolean;
  lastExchange?: number;
  pending: boolean;
  warning?: string;
};
export function setupSync(changed: () => void) {
  const button = document.querySelector<HTMLButtonElement>("#sync-button")!;
  if (!isTauri()) {
    button.hidden = true;
    return;
  }
  // All native platforms acknowledge local edits durably. Only Apple platforms
  // expose the folder picker and exchange those edits through iCloud Drive.
  const supportsCloud = platform.mac || platform.ios;
  button.hidden = !supportsCloud;
  const dialog = document.createElement("dialog");
  dialog.id = "sync-dialog";
  dialog.setAttribute("aria-labelledby", "sync-title");
  dialog.innerHTML = `<button class="dialog-close icon-button" id="sync-close" aria-label="关闭同步设置">×</button><h2 id="sync-title">iCloud 歌单同步</h2><p class="summary">在 Mac 和 iPhone 上，选择同一个 iCloud 云盘文件夹。两端都需安装 0.9.3 或更新版本并各自授权；只在手机上开启不会上传 Mac 的数据。首次可新建一个「Ting」文件夹。</p><p class="summary">同步 Ting 收藏、本机混合歌单、歌曲增删与顺序。网易云 / QQ 歌单需在各设备登录同一音乐账号后读取；不传输登录凭据或音频文件。</p><p id="sync-status" role="status"></p><p id="sync-folder" class="summary"></p><p id="sync-warning" role="alert" hidden></p><div class="sync-actions"><button id="sync-connect" class="primary">选择 iCloud 文件夹</button><button id="sync-now" class="outline" hidden>立即同步</button><button id="sync-disconnect" class="quiet" hidden>停用同步</button></div><small class="summary sync-note">离线修改自动保留。文件由 iCloud 传输，另一台设备可能稍后才收到；停用不会删除已有歌单或云端文件。</small>`;
  if (supportsCloud) document.body.append(dialog);
  const q = <T extends HTMLElement = HTMLElement>(s: string) =>
    dialog.querySelector<T>(s)!;
  let status: Status | undefined;
  let error = "";
  let running = false,
    again = false,
    wantCloud = false,
    choosing = false;
  let timer = 0,
    editTimer = 0;
  function render() {
    const previousStatus = q("#sync-status").textContent;
    q("#sync-status").textContent = running
      ? "正在处理歌单修改…"
      : status?.connected
        ? status.pending
          ? "等待 iCloud 下载其他设备的修改"
          : status.lastExchange
            ? `已与同步文件夹交换 · ${new Date(status.lastExchange * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "已连接文件夹，等待同步"
        : "未开启同步 · 歌单仍保存在本机";
    if (dialog.open && q("#sync-status").textContent !== previousStatus)
      animateContent(q("#sync-status"), { distance: 3, duration: 160 });
    q("#sync-folder").textContent = status?.folder
      ? `文件夹：${status.folder}${status.icloud ? "" : "（请确认位于 iCloud 云盘，本地文件夹不会跨设备同步）"}`
      : "";
    q("#sync-warning").textContent = error || status?.warning || "";
    q("#sync-warning").hidden = !(error || status?.warning);
    q("#sync-connect").textContent = status?.connected
      ? "重新选择文件夹"
      : "选择 iCloud 文件夹";
    q("#sync-now").hidden = q("#sync-disconnect").hidden = !status?.connected;
    for (const id of ["#sync-connect", "#sync-now", "#sync-disconnect"])
      q<HTMLButtonElement>(id).disabled = running || choosing;
    button.title =
      error || status?.warning
        ? "iCloud 同步需要处理"
        : status?.connected
          ? "iCloud 歌单同步"
          : "设置 iCloud 歌单同步";
    button.dataset.syncState =
      error || status?.warning
        ? "error"
        : status?.connected
          ? "connected"
          : "off";
  }
  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!document.hidden) void run(true);
      else schedule();
    }, 30_000);
  }
  async function run(cloud: boolean) {
    wantCloud ||= supportsCloud && cloud;
    if (running || choosing) {
      again = true;
      return;
    }
    running = true;
    error = "";
    render();
    try {
      startSyncLibrary();
      do {
        again = false;
        const exchange = wantCloud;
        wantCloud = false;
        // Older non-Apple builds accumulated an unacknowledged outbox. Drain it
        // in bounded chunks instead of permanently exceeding the native limit.
        const batches = pendingLibraryChanges().slice(0, 2000);
        const result = await invoke<Status>("sync_library", {
          batches,
          exchange,
          expectedDevice: syncDevice() || null,
        });
        if (
          !result ||
          typeof result.device !== "string" ||
          !Array.isArray(result.ack) ||
          !Array.isArray(result.playlists) ||
          batches.some((b) => !result.ack.includes(b.id))
        )
          throw new Error("同步服务暂不可用，本机修改已保留");
        const updated = acceptSyncLibrary(
          result.playlists,
          result.ack,
          result.device,
        );
        status = result;
        if (updated) changed();
        if (pendingLibraryChanges().length) again = true;
      } while (again);
    } catch (e) {
      error = String(e);
    } finally {
      running = false;
      render();
      schedule();
    }
  }
  button.onclick = () => {
    render();
    openDialog(dialog);
  };
  q("#sync-close").onclick = () => closeDialog(dialog);
  q("#sync-connect").onclick = async () => {
    if (running || choosing) return;
    choosing = true;
    error = "";
    render();
    try {
      await invoke<boolean>("sync_choose_folder");
    } catch (e) {
      error = String(e);
    } finally {
      choosing = false;
      render();
    }
    if (!error) await run(true);
  };
  q("#sync-now").onclick = () => void run(true);
  q("#sync-disconnect").onclick = async () => {
    if (running || choosing) return;
    choosing = true;
    render();
    try {
      await invoke("sync_disconnect");
    } catch (e) {
      error = String(e);
    } finally {
      choosing = false;
      render();
    }
    if (!error) await run(false);
  };
  window.addEventListener("ting:library-change", () => {
    clearTimeout(editTimer);
    editTimer = window.setTimeout(() => void run(true), 700);
  });
  window.addEventListener("online", () => void run(true));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void run(true);
  });
  void run(true);
}
