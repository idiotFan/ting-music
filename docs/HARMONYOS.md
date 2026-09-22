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
- 系统能力由 ArkTS 桥提供，源码在 `src-tauri/ohos/entry/`，`scripts/prepare-ohos.mjs` 在 `ohos init` 后把它们覆盖进被忽略的生成工程，并补上权限与版本号：
  - **登录持久化**：`Credentials.ets` 用 Asset Store Kit 保存两个平台的会话（别名 `com.ting.music.demo:<account>`，仅本机、首次解锁后可读）。`EntryAbility.onCreate` 在原生模块初始化前同步读取并通过 `bootstrap()` 注入 Rust，保存 / 删除由 Rust 单向通知 ArkTS 完成；会话值不经过 WebView。
  - **系统媒体控制**：`Media.ets` 创建 AVSession（元数据、播放状态、播放 / 暂停 / 上下曲 / seek 回调），命令经 `mediaCommand()` 回到唯一播放队列；播放时启动 `AUDIO_PLAYBACK` 长时任务保证后台播放，暂停即停止。Rust 侧 `system_media/ohos.rs` 与 Android 后端同一契约，前端把后端名 `harmony` 视为原生媒体会话。
  - **下载浏览**：`Downloads.ets` 列出沙箱 `files/Ting` 下的音频，ActionSheet 选中后经 `DocumentViewPicker.save` 复制到用户选择的位置；二维码同样经文件选择器保存（`Qr.ets`），不依赖 HMS 专有的 Share Kit。
- Rust 与 ArkTS 之间是一个同步 JSON 分发器（`ohos_bridge.rs` ↔ `TingBridge.ets`）：Rust 在非主线程阻塞等待 ArkTS 主线程的即时应答，耗时的系统调用在 ArkTS 侧后台继续并只写日志。
- 签名：HarmonyOS NEXT 不能安装未签名 hap。在 AppGallery Connect 创建应用（包名 `com.ting.music.demo`）并签发调试证书与 profile（登记目标设备 UDID）后，把材料配成仓库 secret，CI 的 `Sign hap` 步骤会用 SDK 自带的 `hap-sign-tool` 签名并产出 `entry-default-signed.hap`；没有 secret 时只产出未签名包。所需 secret：`HARMONY_KEYSTORE_P12`（.p12 的 base64）、`HARMONY_KEYSTORE_PASSWORD`、`HARMONY_KEY_ALIAS`、`HARMONY_KEY_PASSWORD`、`HARMONY_CERT_CER`（.cer 的 base64）、`HARMONY_PROFILE_P7B`（.p7b 的 base64）。第三方客户端上架商店审核风险很高，当前目标是内测分发。

## 验证边界

CI 证明的只是 Rust 交叉编译 + ArkTS 类型检查 + hap 打包通过。凭据恢复、AVSession、后台播放、文件导出与二维码保存在鸿蒙模拟器或真机上尚未实测；模拟器验证前不要把鸿蒙包描述为可用版本。首次真机验收清单：冷启动恢复双账号、控制中心显示封面与上下曲、锁屏后继续播放、「查看下载」导出一首歌、扫码页保存二维码。
