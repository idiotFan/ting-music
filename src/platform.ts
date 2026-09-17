import { isTauri } from "@tauri-apps/api/core";

// iPadOS may identify itself as a Mac; touch support distinguishes it.
const ios =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const android = /Android/.test(navigator.userAgent);
export const platform = {
  ios,
  android,
  mac: !ios && !android && /Mac/.test(navigator.platform),
};
export const mobileDevice = platform.ios || platform.android;
export const credentialNotice = !isTauri()
  ? "浏览器预览不保存平台登录凭据。"
  : platform.ios
    ? "登录凭据保存在此设备的 iOS 钥匙串中，不保存密码。"
    : platform.mac
      ? "登录凭据保存在此 Mac 的 macOS 钥匙串中，不保存密码。"
      : /Win/.test(navigator.platform) || /Windows/.test(navigator.userAgent)
        ? "登录凭据保存在此电脑的 Windows 凭据管理器中，不保存密码。"
        : "登录凭据由系统凭据存储保管，不保存密码。";
export function loginInstructions(source: string, kind: string) {
  const app =
    source === "qq" ? (kind === "wx" ? "微信" : "手机 QQ") : "网易云音乐 App";
  return mobileDevice
    ? `保存二维码后，可尝试在${app}的扫一扫中从相册选取。若平台不支持，请在另一台设备显示二维码后扫描。`
    : `用${app}扫码，在${app}中确认登录。`;
}
export const downloadLocation = platform.ios
  ? "文件 App → 浏览 → 我的 iPhone / iPad → 听 · Ting → Ting"
  : "系统下载目录中的 Ting 文件夹";
