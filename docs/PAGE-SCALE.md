# 页面缩放策略

Ting 的窗口布局固定按 1 倍页面比例计算，系统显示缩放与无障碍功能由操作系统管理。

- HTML viewport 限定页面比例，根节点与弹窗只允许平移；保留列表、歌词和系统触控板滚动。
- 共享事件处理拦截 WebKit 放大手势、Ctrl+滚轮和页面缩放快捷键，不拦截普通滚轮、文字输入或复制/全选。
- 手机输入框、选择框和文本域固定至少 16px，覆盖搜索与歌单输入框的 ID 规则，避免聚焦时触发 iOS 页面自动放大。键盘避让继续使用原有 visualViewport 逻辑。
- iOS 关闭 WKWebView 滚动视图的 pinchGestureRecognizer，macOS 关闭 allowsMagnification；不替换 WebKit 滚动代理。Android 在 WebView 创建时关闭缩放支持和缩放控件。Windows 明确关闭 Tauri zoomHotkeysEnabled，其 Wry 后端同时关闭 WebView2 的缩放控件和 PinchZoom。
- Linux 使用同一 viewport/CSS/事件策略，Tauri 缩放快捷键保持关闭。

参考：[WebKit 手势与 viewport](https://webkit.org/blog/7367/new-interaction-behaviors-in-ios-10/)、[WKWebView allowsMagnification](https://developer.apple.com/documentation/webkit/wkwebview/allowsmagnification)、[touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action)。Windows 行为核对锁定依赖 Wry 0.55.1 的 `src/webview2/mod.rs`。

回归覆盖手机搜索/歌单/登录字段的实际计算字号、浏览器触摸 pinch 前后比例不变、桌面手势拦截且普通滚轮/编辑快捷键保留，以及既有键盘避让/歌词/扫码/布局测试。浏览器模拟不替代每种操作系统的原生手势验收。
