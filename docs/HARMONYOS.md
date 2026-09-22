# HarmonyOS NEXT（OpenHarmony）构建

鸿蒙包目前由 GitHub Actions 的 `harmony` 任务在 Linux 上构建，产出**未签名**的 `entry-default-unsigned.hap`。本机没有鸿蒙设备时，可用 DevEco Studio 的模拟器（Apple 芯片 Mac 可用）安装验证，或在 AppGallery Connect 上传调试包生成下载链接。

## 依赖

- Tauri 的 OpenHarmony 支持在 `tauri-apps/tauri`、`wry`、`tao` 的 `feat/open-harmony` 分支上，尚未发布到 crates.io。`src-tauri/ohos/cargo-config.toml` 以 Cargo 配置层的 `[patch.crates-io]` 引入这些分支，只在鸿蒙构建时生效；其他平台仍用 `Cargo.lock` 锁定的正式版本。
- CLI：`cargo install tauri-cli --git https://github.com/tauri-apps/tauri --branch feat/open-harmony`（提供 `cargo tauri ohos init|dev|build`），以及 `cargo install ohrs`（交叉编译到 `aarch64-unknown-linux-ohos`）。`scripts/tauri.mjs` 会把 `ohos` 子命令转给 `cargo tauri`。
- HarmonyOS 命令行工具（`hvigorw`、`ohpm`、SDK、`hdc`）。CI 用 `ErBWs/setup-ohos` 安装；本机可从华为开发者网站下载（需登录）或直接用 DevEco Studio 自带的。
- 环境变量：`OHOS_HOME` 指向 `<sdk>/default/openharmony`（cargo-mobile2 由它推导 `OHOS_NDK_HOME` 与 `DEVECO_SDK_HOME`）。CI 里为了让推导出的 `DEVECO_SDK_HOME` 落在 `<sdk>`，用符号链接把 `OHOS_HOME` 放在多一层的路径上，见 `ci.yml`。

## 当前范围

- 复用全部前端与 Rust 核心（网易云 / QQ 协议、播放、下载校验、同步模型）。ArkWeb 的 UA 含 `OpenHarmony`，前端按手机布局渲染。
- 鸿蒙上 `target_os = "linux"` 且 `target_env = "ohos"`，桌面 Linux 专用的 D-Bus / MPRIS、Secret Service、`xdg-open` 和自更新都已排除。
- **暂未实现**：登录会话持久化（重启后需重新登录，应接 Asset Store Kit）、系统媒体控制（应接 AVSession）、下载目录浏览与分享、二维码原生分享。这些对应 Android 那套 Kotlin 插件，需要用 ArkTS + NAPI 重写。
- 产物未签名：签名需要 AppGallery Connect 的证书与 profile（debug 证书绑定设备 UDID），配好后可用 SDK 里的 `hap-sign-tool` 在 CI 签名。

## 验证边界

CI 只证明能交叉编译并打出 hap。界面、播放、登录流程在鸿蒙上尚未实测；模拟器或真机验收前，不要把鸿蒙包描述为可用版本。
