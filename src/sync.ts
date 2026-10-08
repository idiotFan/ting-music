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
  provider?: "icloud" | "webdav";
  server?: string;
  account?: string;
};
type Provider = "icloud" | "webdav";
const NUTSTORE = "https://dav.jianguoyun.com/dav/";
const NUTSTORE_HOST = "dav.jianguoyun.com";
export function setupSync(changed: () => void) {
  const button = document.querySelector<HTMLButtonElement>("#sync-button")!;
  if (!isTauri()) {
    button.hidden = true;
    return;
  }
  // iCloud Drive needs the Apple folder picker; WebDAV works on every platform.
  const supportsICloud = platform.mac || platform.ios;
  const dialog = document.createElement("dialog");
  dialog.id = "sync-dialog";
  dialog.setAttribute("aria-labelledby", "sync-title");
  dialog.innerHTML = `<button class="dialog-close icon-button" id="sync-close" aria-label="关闭同步设置">×</button><h2 id="sync-title">歌单同步</h2><p class="summary">同步 Ting 收藏、本机混合歌单、歌曲增删与顺序。网易云 / QQ 歌单需在各设备登录同一音乐账号后读取；不传输登录凭据或音频文件。</p><div class="sync-providers" role="group" aria-label="同步方式"${supportsICloud ? "" : " hidden"}><button type="button" data-provider="icloud">iCloud 云盘</button><button type="button" data-provider="webdav">坚果云 / WebDAV</button></div><p id="sync-status" role="status"></p><p id="sync-folder" class="summary"></p><p id="sync-warning" role="alert" hidden></p><section id="sync-icloud" hidden><p class="summary">在 Mac 和 iPhone 上，选择同一个 iCloud 云盘文件夹。两端都需安装 0.9.3 或更新版本并各自授权；只在手机上开启不会上传 Mac 的数据。首次可新建一个「Ting」文件夹。</p><div class="sync-actions"><button id="sync-connect" class="primary">选择 iCloud 文件夹</button></div></section><form id="sync-webdav" novalidate hidden><p class="summary">每台设备填写同一个账号和文件夹即可互相同步，Mac、Windows、Linux、iPhone、Android 均可使用。</p><label for="webdav-service">服务</label><select id="webdav-service"><option value="nutstore">坚果云</option><option value="custom">其他 WebDAV</option></select><div id="webdav-server-field" hidden><label for="webdav-server">服务器地址</label><input id="webdav-server" type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" placeholder="https://example.com/dav/"></div><label for="webdav-user">账号</label><input id="webdav-user" autocomplete="username" autocapitalize="off" spellcheck="false"><label for="webdav-password" id="webdav-password-label">应用密码</label><input id="webdav-password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"><small id="webdav-hint" class="summary"></small><label for="webdav-folder">文件夹</label><input id="webdav-folder" value="Ting" autocapitalize="off" spellcheck="false"><div class="sync-actions"><button id="webdav-connect" class="primary" type="submit">测试并连接</button><button id="webdav-cancel" class="quiet" type="button" hidden>取消</button></div></form><div class="sync-actions"><button id="sync-now" class="outline" hidden>立即同步</button><button id="sync-edit" class="outline" hidden>更换账号</button><button id="sync-disconnect" class="quiet" hidden>停用同步</button></div><small class="summary sync-note" id="sync-note"></small>`;
  document.body.append(dialog);
  const q = <T extends HTMLElement = HTMLElement>(s: string) =>
    dialog.querySelector<T>(s)!;
  const service = q<HTMLSelectElement>("#webdav-service");
  const server = q<HTMLInputElement>("#webdav-server");
  const user = q<HTMLInputElement>("#webdav-user");
  const password = q<HTMLInputElement>("#webdav-password");
  const folder = q<HTMLInputElement>("#webdav-folder");
  let status: Status | undefined;
  let error = "";
  let running = false,
    again = false,
    wantCloud = false,
    choosing = false,
    connecting = false,
    editing = false,
    failures = 0;
  let tab: Provider | undefined;
  let timer = 0,
    editTimer = 0;
  const connectedProvider = (): Provider | undefined =>
    status?.connected ? (status.provider ?? "icloud") : undefined;
  function renderForm() {
    const nutstore = service.value === "nutstore";
    q("#webdav-server-field").hidden = nutstore;
    user.placeholder = nutstore ? "坚果云登录邮箱或手机号" : "WebDAV 用户名";
    q("#webdav-password-label").textContent = nutstore ? "应用密码" : "密码";
    q("#webdav-hint").textContent = nutstore
      ? "在坚果云网页版「账户信息 → 安全选项 → 第三方应用管理」中添加应用，填写生成的应用密码，不是登录密码。"
      : "使用 https:// 地址；仅局域网内的 NAS 可用 http://。";
  }
  function fillForm() {
    const custom = !!status?.server && status.server !== NUTSTORE_HOST;
    service.value = custom ? "custom" : "nutstore";
    if (status?.account) user.value = status.account;
    if (status?.provider === "webdav" && status.folder)
      folder.value = status.folder;
    password.value = "";
    renderForm();
  }
  function render() {
    const active = connectedProvider();
    const view: Provider = supportsICloud
      ? (tab ?? active ?? "icloud")
      : "webdav";
    const webdav = active === "webdav";
    for (const b of dialog.querySelectorAll<HTMLButtonElement>(
      "[data-provider]",
    ))
      b.setAttribute("aria-pressed", String(b.dataset.provider === view));
    const previousStatus = q("#sync-status").textContent;
    q("#sync-status").textContent = connecting
      ? "正在连接 WebDAV…"
      : running
        ? "正在处理歌单修改…"
        : active && active !== view
          ? `当前使用${active === "icloud" ? " iCloud 云盘" : "坚果云 / WebDAV"}同步；连接后将改用${view === "icloud" ? " iCloud 云盘" : " WebDAV"}`
          : active
            ? status!.pending
              ? "等待 iCloud 下载其他设备的修改"
              : `${webdav ? `已连接${status!.server === NUTSTORE_HOST ? "坚果云" : ` ${status!.server}`} · ${status!.account} · ` : ""}${
                  status!.lastExchange
                    ? `${webdav ? "上次同步" : "已与同步文件夹交换"} · ${new Date(status!.lastExchange * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : webdav
                      ? "等待同步"
                      : "已连接文件夹，等待同步"
                }`
            : "未开启同步 · 歌单仍保存在本机";
    if (dialog.open && q("#sync-status").textContent !== previousStatus)
      animateContent(q("#sync-status"), { distance: 3, duration: 160 });
    q("#sync-folder").textContent =
      !status?.folder || active !== view
        ? ""
        : webdav
          ? `文件夹：${status.folder}/Ting-Sync-v1`
          : `文件夹：${status.folder}${status.icloud ? "" : "（请确认位于 iCloud 云盘，本地文件夹不会跨设备同步）"}`;
    q("#sync-warning").textContent = error || status?.warning || "";
    q("#sync-warning").hidden = !(error || status?.warning);
    q("#sync-icloud").hidden = view !== "icloud";
    q("#sync-webdav").hidden = view !== "webdav" || (webdav && !editing);
    q("#webdav-cancel").hidden = !(webdav && editing);
    q("#sync-connect").textContent =
      active === "icloud" ? "重新选择文件夹" : "选择 iCloud 文件夹";
    q("#webdav-connect").textContent = connecting
      ? "正在测试连接…"
      : "测试并连接";
    q("#sync-now").hidden = q("#sync-disconnect").hidden = active !== view;
    q("#sync-edit").hidden = !(webdav && view === "webdav" && !editing);
    q("#sync-note").textContent =
      view === "webdav"
        ? "离线修改自动保留。每台设备只上传自己的快照文件，不会互相覆盖；密码保存在系统钥匙串或凭据管理器中。停用不会删除已有歌单或云端文件。"
        : "离线修改自动保留。文件由 iCloud 传输，另一台设备可能稍后才收到；停用不会删除已有歌单或云端文件。";
    for (const id of [
      "#sync-connect",
      "#sync-now",
      "#sync-disconnect",
      "#sync-edit",
      "#webdav-connect",
    ])
      q<HTMLButtonElement>(id).disabled = running || choosing;
    const name = webdav ? "WebDAV" : active ? "iCloud" : "";
    button.title =
      error || status?.warning
        ? `${name || "歌单"}同步需要处理`
        : active
          ? `${name} 歌单同步`
          : "设置歌单同步";
    button.setAttribute("aria-label", button.title);
    button.dataset.syncState =
      error || status?.warning ? "error" : active ? "connected" : "off";
  }
  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!document.hidden) void run(true);
      else schedule();
    }, delay());
  }
  // Nutstore allows 600 requests per 30 minutes on free plans; back off on errors.
  const delay = () =>
    (connectedProvider() === "webdav" ? 60_000 : 30_000) *
    2 ** Math.min(failures, 4);
  async function run(cloud: boolean) {
    wantCloud ||= cloud;
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
        const exchange =
          wantCloud && (supportsICloud || connectedProvider() === "webdav");
        if (exchange) wantCloud = false;
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
        if (wantCloud) {
          if (result.connected) again = true;
          else wantCloud = false;
        }
      } while (again);
    } catch (e) {
      error = String(e);
    } finally {
      failures = error || status?.warning ? failures + 1 : 0;
      running = false;
      render();
      schedule();
    }
  }
  button.onclick = () => {
    if (!q("#sync-webdav").hidden || connectedProvider() !== "webdav")
      fillForm();
    render();
    openDialog(dialog);
  };
  q("#sync-close").onclick = () => closeDialog(dialog);
  for (const b of dialog.querySelectorAll<HTMLButtonElement>("[data-provider]"))
    b.onclick = () => {
      tab = b.dataset.provider as Provider;
      if (tab === "webdav" && connectedProvider() !== "webdav") fillForm();
      render();
    };
  service.onchange = renderForm;
  q("#sync-edit").onclick = () => {
    editing = true;
    fillForm();
    render();
    user.focus();
  };
  q("#webdav-cancel").onclick = () => {
    editing = false;
    password.value = "";
    render();
  };
  q<HTMLFormElement>("#sync-webdav").onsubmit = async (event) => {
    event.preventDefault();
    if (running || choosing) return;
    const nutstore = service.value === "nutstore";
    error = !user.value.trim()
      ? "请填写账号"
      : !password.value
        ? nutstore
          ? "请填写坚果云第三方应用密码"
          : "请填写密码"
        : !nutstore && !server.value.trim()
          ? "请填写 WebDAV 服务器地址"
          : "";
    if (error) return render();
    choosing = connecting = true;
    render();
    try {
      await invoke("sync_webdav_connect", {
        server: nutstore ? NUTSTORE : server.value.trim(),
        folder: folder.value.trim() || "Ting",
        username: user.value.trim(),
        password: password.value,
      });
      password.value = "";
      editing = false;
      tab = "webdav";
    } catch (e) {
      error = String(e);
    } finally {
      choosing = connecting = false;
      render();
    }
    if (!error) await run(true);
  };
  q("#sync-connect").onclick = async () => {
    if (running || choosing) return;
    choosing = true;
    error = "";
    render();
    try {
      if (await invoke<boolean>("sync_choose_folder")) tab = "icloud";
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
      editing = false;
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
