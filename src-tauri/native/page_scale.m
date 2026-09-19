#import <TargetConditionals.h>
#import <WebKit/WebKit.h>

// Called by Tauri's with_webview on the UI thread. Do not replace the scroll
// delegate: WebKit needs it for keyboard avoidance and normal content scrolling.
void ting_disable_page_zoom(void *pointer) {
    WKWebView *webView = (__bridge WKWebView *)pointer;
    webView.pageZoom = 1.0;
#if TARGET_OS_IPHONE
    webView.scrollView.pinchGestureRecognizer.enabled = NO;
    webView.scrollView.bouncesZoom = NO;
#else
    webView.allowsMagnification = NO;
    webView.magnification = 1.0;
#endif
}
