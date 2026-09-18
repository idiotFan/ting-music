// WKWebView must publish metadata/actions through its actual HTML audio session.
// A host MPNowPlayingInfoCenter without a native player is not an audio owner.
#[derive(Default)]
pub struct State;
#[tauri::command]
pub fn system_media_init() -> &'static str {
    "web"
}
#[tauri::command]
pub fn system_media_update(snapshot: serde_json::Value) -> Result<(), String> {
    let _ = snapshot;
    Err("此平台使用实际播放器的 Web Media Session".into())
}
