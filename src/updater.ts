import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { animateContent } from "./motion";

export type UpdateCheckResult = {
  status: "ready" | "available" | "up_to_date" | "unsupported" | "error";
  version?: string | null;
  notes?: string | null;
  message?: string | null;
};

export type UpdateProgress = {
  downloaded: number;
  total?: number | null;
};

/** The backend stages a signed package silently; this only offers the restart. */
export function setupUpdater(toast: (message: string) => void) {
  if (!isTauri()) return;
  void invoke<string | null>("update_ready")
    .then((version) => {
      if (version) offerRestart(version, toast);
    })
    // Update checks never interrupt listening.
    .catch(() => {});
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  if (!isTauri()) {
    return { status: "unsupported", message: "当前环境不支持应用内更新" };
  }
  return invoke<UpdateCheckResult>("update_check");
}

export async function downloadUpdate(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<string> {
  if (!isTauri()) throw new Error("当前环境不支持应用内更新");
  let unlisten: (() => void) | undefined;
  if (onProgress) {
    try {
      unlisten = await listen<UpdateProgress>("ting://update-progress", (e) => {
        if (e.payload) onProgress(e.payload);
      });
    } catch {
      /* Event listener optional in mocked/web contexts; download still runs. */
    }
  }
  try {
    return await invoke<string>("update_download");
  } finally {
    unlisten?.();
  }
}

export async function installUpdate(): Promise<void> {
  await invoke("update_install");
}

export function offerRestart(
  version: string,
  toast: (message: string) => void,
) {
  const existing = document.getElementById("update-notice");
  if (existing) existing.remove();
  const notice = document.createElement("div");
  notice.id = "update-notice";
  notice.setAttribute("role", "status");
  const label = document.createElement("span");
  label.textContent = `新版本 ${version} 已下载`;
  const restart = document.createElement("button");
  restart.id = "update-restart";
  restart.className = "primary";
  restart.textContent = "重启更新";
  const later = document.createElement("button");
  later.id = "update-later";
  later.className = "quiet";
  later.textContent = "稍后";
  notice.append(label, restart, later);
  document.body.append(notice);
  // Visible by default: an occluded window pauses frame callbacks.
  animateContent(notice, { distance: 6 });
  later.addEventListener("click", () => {
    notice.remove();
    toast("下次启动时会再次提醒更新");
  });
  restart.addEventListener("click", async () => {
    restart.disabled = later.disabled = true;
    restart.textContent = "正在安装…";
    try {
      await installUpdate();
    } catch (error) {
      restart.disabled = later.disabled = false;
      restart.textContent = "重启更新";
      toast(String(error));
    }
  });
}
