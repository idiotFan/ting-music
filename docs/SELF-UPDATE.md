# 自更新

桌面版（macOS、Windows、Linux）在启动后静默检查并下载新版本，下载完成后只提示一次「重启更新」。用户点击后才安装并重启；选择「稍后」则本次运行不再打扰，下次启动重新提示。iOS / Android 不使用此机制，仍通过安装包更新。

## 流程

1. `src-tauri/src/updater.rs` 在 `setup` 末尾启动后台任务：读取 `plugins.updater.endpoints` 指向的 `latest.json`，版本更高时下载对应平台的更新包。
2. `tauri-plugin-updater` 在 `download()` 返回前用 `tauri.conf.json` 中的公钥校验 minisign 签名；校验失败、离线、超时或没有对应平台时全部静默放弃，不影响播放。
3. 下载完成的包留在内存，前端 `src/updater.ts` 通过 `update_ready` 得到版本号并显示提示条。
4. 用户点击「重启更新」→ `update_install`：歌曲下载进行中会拒绝；macOS 替换 `.app`、Linux 替换 AppImage（deb 经 `pkexec dpkg -i`）后由应用自行重启，Windows 以 passive 模式运行 NSIS 安装器并由安装器重启应用。安装失败保留已下载的包，可重试。

不会自更新的情形：`tauri dev` / debug 构建、macOS App Translocation 下的只读运行路径、既不是 AppImage 也不在 `/usr` 下的 Linux 可执行文件。

## 签名密钥

- 公钥在 `src-tauri/tauri.conf.json`，随应用分发。
- 私钥**不入库**：本机默认读取 `~/.tauri/ting-music-updater.key`（或 `TAURI_SIGNING_PRIVATE_KEY_PATH`），CI 使用仓库 secret `TAURI_SIGNING_PRIVATE_KEY`。
- 私钥丢失后，已安装的应用无法再验证新包，只能手动安装换了公钥的新版本；请离线备份。私钥泄露等同于可向所有用户推送任意代码，须立即更换公钥并发版。
- `scripts/tauri.mjs` 只在拿得到私钥时才追加 `src-tauri/tauri.updater.conf.json`（`createUpdaterArtifacts` 与 macOS ad-hoc 整包签名）。没有 secret 的 fork / Dependabot PR 仍能正常构建，只是不产出更新包。

## 发布

更新包与签名由 `npm run tauri -- build` 生成：

| 平台 | 更新包 | `latest.json` 键 |
| --- | --- | --- |
| macOS Apple Silicon | `听 · Ting.app.tar.gz` + `.sig` | `darwin-aarch64` |
| Windows x64 | `*-setup.exe` + `.sig` | `windows-x86_64` |
| Linux x64 | `*.AppImage` + `.sig`、`*.deb` + `.sig` | `linux-x86_64-appimage`、`linux-x86_64-deb` |

发布页附件沿用 ASCII 命名，签名针对文件内容，重命名不影响校验。把重命名后的包和同名 `.sig` 放在一起，生成清单：

```sh
node scripts/updater-manifest.mjs --out latest.json \
  darwin-aarch64=Ting-v0.9.8-macOS-AppleSilicon.app.tar.gz \
  windows-x86_64=Ting-v0.9.8-Windows-x64-Setup.exe \
  linux-x86_64-appimage=Ting-v0.9.8-Linux-x64.AppImage \
  linux-x86_64-deb=Ting-v0.9.8-Linux-x64.deb
```

把这些包和 `latest.json` 一起上传到 `v<version>` 发布页。应用读取 `releases/latest/download/latest.json`，因此**只有标为 Latest 的正式 Release 会被推送**；草稿和预发布不会。`latest.json` 必须最后上传：它一出现，旧版本就会开始下载。

macOS 更新包里的应用是 Tauri 构建时的 ad-hoc 整包签名；`scripts/release.py` 生成的 ZIP 会重新 ad-hoc 签名，两者内容一致但签名哈希不同，属正常现象。ad-hoc 签名每次构建都变，更新后首次读取钥匙串时系统可能再次询问授权。

## 验证边界

- 自动化：`tests/updater.spec.ts` 用模拟 IPC 覆盖提示、点击安装、失败重试和「稍后」。
- 本机实测（macOS 15+ Apple Silicon，2026-09-22）：0.9.7 测试构建指向本地 `latest.json`，启动后静默下载签名包，点击「重启更新」后应用包被替换为 0.9.8 并自动重启，`codesign --verify --deep --strict` 通过。
- 未实测：Windows NSIS passive 安装与重启、Linux AppImage / deb 替换、GitHub 在无代理网络下的下载速度。首个真实更新（0.9.7 → 下一版本）发布后需在各平台各确认一次。
