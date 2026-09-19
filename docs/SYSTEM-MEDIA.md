# 系统媒体控制

同一个播放队列处理播放、暂停、上一曲、下一曲、停止与进度跳转；原生系统回调通过 `system-media-action` 回到前端，不另建队列、不重新请求其他音源。

| 平台 | 原生接口 | 说明 |
| --- | --- | --- |
| macOS / iOS | WKWebView Web Media Session | 在音频就绪、开始播放和返回前台后重申切歌动作；保持真实音频会话的元信息 |
| Windows | SystemMediaTransportControls (SMTC) | 绑定主窗口，发布音乐元数据和时间轴，禁用 WebView2 自带媒体会话以避免重复控制 |
| Linux | MPRIS 2 / D-Bus session bus | 独立实例名，支持桌面媒体面板和 playerctl；需要有桌面会话和支持 MPRIS 的环境 |
| Android | Android MediaSession + mediaPlayback 前台服务 | 发布封面、标题、时间轴和上一首／下一首；系统回调驱动同一播放队列 |
| 浏览器预览 | Web Media Session | 按浏览器能力回退；不承诺系统面板具有与原生相同布局 |

原生界面外观由操作系统决定。注册成功、自动化验证通过不代表已经逐个操作系统完成真实控制中心验收。

## 数据和生命周期

- 使用一条串行 IPC，合并等待期间的更新。递增序号拦截旧状态；封面只在变化时从前端传入，进度最多约每 750 ms 上报一次。
- 封面使用现有有大小限制、无账号凭据的 CDN 加载器，转为最多 512×512 PNG。系统层不接收网络封面地址，不接收 Cookie、音乐 URL 或访问令牌。
- Android 的原生播放通知与 MediaSession 使用同一 token；播放期间启用 mediaPlayback 前台服务，暂停后解除前台状态，拔耳机时暂停。原生端只在封面变化时解码新图，分享接口不会暴露凭据目录。
- Apple 通过 Web Media Session 使用 PNG；Windows / Linux 使用内容散列命名的私有缓存文件，避免系统缓存上一首封面，并清理过期文件。
- 注销、播放失败或清空会话时同时清理元数据和播放状态。初始化幂等，单个进程不会重复注册按钮；Windows 移除按钮和进度订阅，Linux 服务随进程结束。
- Linux 的 SetPosition 校验 track id，防止上一首歌延迟到达的进度指令改变当前歌曲。
- 音频仍由应用现有播放器输出，原生桥负责系统会话。iOS 后台连续切歌等场景必须真机验证，不能用浏览器测试替代。

## 验证

`npm test` 覆盖 IPC 合并、失败恢复、过期封面、单次事件分发；Playwright 覆盖原生回调驱动真实音频及队列。Rust 测试校验状态合并和有界封面输入。WebKit 回归模拟监听器在播放后才建立的生命周期，验证此时上／下一曲动作会重新注册。

CI 在 macOS、Windows、Ubuntu 分别运行 Rust 测试和原生构建。Linux 可用 `playerctl -l` 找到 `ting.instance...`，再用 `playerctl -p <名称> next`、`previous`、`play-pause`、`metadata` 验证。

## 版本策略

本轮保持 0.9.5，Apple 构建号为 90504。Android versionCode 为 9005。普通修复优先以提交号区分产物，不自动递增公开版本或内部构建号；只有分发平台要求时才调整构建号。

## 90502 回归与 90503 修复依据

90502 将 Apple 元信息移到宿主进程的 MPNowPlayingInfoCenter，但音频仍由 WKWebView 输出。清空 Web Media Session 后，真机确认封面和标题丢失。这个独立桥及只验证进程内字典的测试已移除，避免误当成控制中心实测。

WebKit 的 NowPlayingManager 只在远程监听器存在时接收 supported commands；监听器随活跃音频会话创建，空 Audio 初始化时注册一次可能落空。90503 在 loadedmetadata、playing 和返回前台时按「元信息 → 播放状态 → 动作」顺序重申，上／下一曲与 seekto 保留，跳秒关闭。相同动作替换原回调，不增加多次触发。

官方源码依据：[NowPlayingManager](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/NowPlayingManager.cpp)、[MediaSession](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediasession/MediaSession.cpp)、[Cocoa 系统媒体信息发布](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm)。这些代码解释实现策略；最终系统按钮显示仍需用户真机验收。

## 90504 封面过渡

90503 已由用户真机确认：歌曲信息恢复、上／下一曲可正常切歌。随后反馈切歌时闪现 App Logo，定位为每次切歌先清空会话、再把封面重置为占位图。正常切歌现在保留已显示封面，新封面完整解码后才替换；确认无封面或请求失败时才回退占位图。旧请求失败与成功均校验曲目世代，避免快速切歌时显示过期图片。

同一元数据去重；Web MediaMetadata 就地更新文本，封面不变时不重新设置 artwork 或整个 metadata 对象，保留 WebKit 已解码的图。音频就绪和前台恢复仍重申动作。依据：[MediaSession::setMetadata](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediasession/MediaSession.cpp)、[MediaMetadata 图片生命周期](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/mediasession/MediaMetadata.cpp)。这些实现细节支持消除重复加载的修复策略，不替代真机视觉验收。
