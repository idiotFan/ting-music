import { invoke, isTauri } from "@tauri-apps/api/core";
import { animateContent } from "./motion";

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
function offerRestart(version: string, toast: (message: string) => void) {
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
      await invoke("update_install");
    } catch (error) {
      restart.disabled = later.disabled = false;
      restart.textContent = "重启更新";
      toast(String(error));
    }
  });
}
