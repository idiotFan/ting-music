import { invoke, isTauri } from "@tauri-apps/api/core";
import { $ } from "./dom";
import { esc, type Source } from "./library";
import { animateContent, openDialog, closeDialog } from "./motion";
import { makeLoginQr, verifyOriginalQr, qrPngForSharing } from "./qr";
import { mountPhoneLogin, type PhoneLoginResult } from "./phone-login";
import { mobileDevice, credentialNotice, loginInstructions } from "./platform";

/**
 * Both platform accounts: restoring them at launch, the login dialog (QR for
 * both, SMS for NetEase), and logging out. What a login or logout means for
 * the rest of the app — playlists, the queue, the player — is main's call.
 */
export type Profile = { userId: number; nickname: string; avatar: string };
type Context = {
  cloud: <T>(
    command: string,
    args?: Record<string, unknown>,
    source?: Source,
  ) => Promise<T>;
  toast: (message: string) => void;
  /** After a login: reload what that account can see. */
  signedIn: (source: Source) => void;
  /** After a logout, before the dialog decides whether to stay open. */
  signedOut: (source: Source) => void;
  /** Whether the logout also closed the dialog (then playlists reload). */
  settled: (closed: boolean) => void;
};
const platformName = (source: Source) =>
  source === "qq" ? "QQ音乐" : "网易云";

let ctx: Context;
const profiles: Record<Source, Profile | null> = { netease: null, qq: null };
let accountSource: Source = "netease",
  qqLoginKind = "qq",
  qrSource: Source | undefined,
  loginSerial = 0,
  loginTimer = 0;
const authVersions: Record<Source, number> = { netease: 0, qq: 0 };
const accountRestoring: Partial<Record<Source, Promise<void>>> = {};

export const profile = (source: Source) => profiles[source];
export const signedInSources = (): Source[] =>
  (["netease", "qq"] as Source[]).filter((s) => profiles[s]);
/** Picks which platform the dialog opens on. */
export function chooseAccount(source: Source) {
  accountSource = source;
}
function activeProfile() {
  return profiles[accountSource];
}
export function renderAccount() {
  const { netease, qq } = profiles;
  const count = Number(!!netease) + Number(!!qq);
  $("#account-name").textContent =
    count === 2 ? "双账号" : (netease || qq)?.nickname || "登录";
  $("#account-button").setAttribute("aria-label", "账号设置");
  $("#account-button .avatar").textContent =
    (netease || qq)?.nickname.slice(0, 1) || "听";
  $("#account-netease").textContent =
    `网易云${netease ? " · 已登录" : " · 未登录"}`;
  $("#account-qq").textContent = `QQ音乐${qq ? " · 已登录" : " · 未登录"}`;
  $("#account-netease").classList.toggle("active", accountSource === "netease");
  $("#account-qq").classList.toggle("active", accountSource === "qq");
}
/** Restores both saved sessions; a failure only means "verify later". */
export function restoreAccounts(): Promise<unknown> {
  return Promise.allSettled(
    (["netease", "qq"] as Source[]).map((source) => {
      const version = authVersions[source];
      const request = (async () => {
        try {
          const restored = await ctx.cloud<Profile | null>(
            "account_status",
            {},
            source,
          );
          if (version !== authVersions[source]) return;
          profiles[source] = restored;
          renderAccount();
        } catch {
          if (version === authVersions[source])
            ctx.toast(
              `${platformName(source)}登录状态暂无法验证，可在账号中重试`,
            );
        } finally {
          delete accountRestoring[source];
        }
      })();
      accountRestoring[source] = request;
      return request;
    }),
  );
}
let neteaseLoginMethod: "phone" | "qr" = mobileDevice ? "phone" : "qr";
let disposePhoneLogin: (() => void) | undefined;
function clearPhoneLogin() {
  disposePhoneLogin?.();
  disposePhoneLogin = undefined;
}
function completeLogin(source: Source, data: PhoneLoginResult) {
  if (!data.profile) return;
  authVersions[source]++;
  profiles[source] = data.profile;
  renderAccount();
  closeAccount(false);
  ctx.toast(data.warning || `欢迎回来，${data.profile.nickname}`);
  ctx.signedIn(source);
}
export async function openAccount() {
  const dialog = $("#account-dialog") as HTMLDialogElement;
  openDialog(dialog);
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
    $("#account-title").textContent = `${platformName(source)}账号`;
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
  $("#account-title").textContent = `${platformName(accountSource)}账号`;
  $(".account-subtitle").textContent =
    "两个平台独立登录，退出当前账号不影响另一个。";
  $("#account-content").innerHTML =
    `<div class="account-profile"><span class="profile-initial">${esc(connected.nickname.slice(0, 1))}</span><h3>${esc(connected.nickname)}</h3><p>UID ${esc(String(connected.userId))}</p></div>`;
  animateContent($("#account-content"), { distance: 5 });
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
  const name = platformName(source);
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
    animateContent($("#account-content"), { distance: 5 });
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
    const data = await ctx.cloud<{ key: string; url?: string; image?: string }>(
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
    // QR pixels must be aligned after the enclosing entrance has settled.
    // Aligning against a moving/scaled dialog leaves a permanent subpixel offset.
    await Promise.allSettled(
      [
        ...$("#account-dialog").getAnimations(),
        ...$("#account-content").getAnimations(),
      ].map((animation) => animation.finished),
    );
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
    const data = await ctx.cloud<{
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
  closeDialog($("#account-dialog") as HTMLDialogElement);
  const pending = qrSource;
  qrSource = undefined;
  if (cancel && pending && isTauri())
    void ctx.cloud("login_qr_cancel", {}, pending).catch(() => {});
}
async function switchAccount(source: Source) {
  if (source === accountSource) return;
  clearPhoneLogin();
  const previous = accountSource;
  ++loginSerial;
  clearTimeout(loginTimer);
  accountSource = source;
  if (isTauri() && qrSource === previous)
    void ctx.cloud("login_qr_cancel", {}, previous).catch(() => {});
  qrSource = undefined;
  await openAccount();
}

async function logout() {
  const source = accountSource;
  const serial = ++loginSerial;
  $("#logout").setAttribute("disabled", "");
  try {
    clearTimeout(loginTimer);
    authVersions[source]++;
    await ctx.cloud("logout", {}, source);
    profiles[source] = null;
    ctx.signedOut(source);
    renderAccount();
    if (serial === loginSerial && source === accountSource) {
      closeAccount(false);
      ctx.settled(true);
    } else {
      ctx.settled(false);
      if (
        source === accountSource &&
        ($("#account-dialog") as HTMLDialogElement).open
      )
        void openAccount();
    }
    ctx.toast(`已退出${platformName(source)}，另一个平台不受影响`);
  } catch (e) {
    if (serial === loginSerial) $("#account-status").textContent = String(e);
    else ctx.toast(`退出${platformName(source)}失败，请重试`);
  } finally {
    $("#logout").removeAttribute("disabled");
  }
}

export function setupAccount(context: Context) {
  ctx = context;
  $("#account-netease").onclick = () => void switchAccount("netease");
  $("#account-qq").onclick = () => void switchAccount("qq");
  document.querySelectorAll<HTMLElement>("[data-qq-kind]").forEach(
    (el) =>
      (el.onclick = () => {
        qqLoginKind = el.dataset.qqKind!;
        void startLogin();
      }),
  );
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
          await ctx.cloud("login_qr_cancel", {}, "netease");
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
      if (mobileDevice && isTauri())
        await invoke("share_login_qr", { dataUrl });
      else {
        const blob = await (await fetch(dataUrl)).blob();
        const files = [
          new File([blob], "Ting-login.png", { type: "image/png" }),
        ];
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
        ctx.toast(String(error));
    } finally {
      button.disabled = false;
    }
  };
  $("#logout").onclick = () => void logout();
}
