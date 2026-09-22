use super::*;

/// AVSession lives in ArkTS; this mirrors the Android backend contract.
pub struct Backend {
    artwork: String,
}
impl Backend {
    pub const NAME: &'static str = "harmony";
    pub fn new(_: &tauri::AppHandle) -> Result<Self, String> {
        crate::ohos_bridge::call("media.init", serde_json::json!({}))?;
        Ok(Self {
            artwork: String::new(),
        })
    }
    pub fn update(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let artwork = snapshot
            .track
            .as_ref()
            .map(|t| t.artwork.as_str())
            .unwrap_or("");
        let changed = artwork != self.artwork;
        let mut value = serde_json::to_value(snapshot).map_err(|_| "系统媒体数据无效")?;
        if !changed {
            if let Some(track) = value["track"].as_object_mut() {
                track.remove("artwork");
            }
        }
        crate::ohos_bridge::call(
            "media.update",
            serde_json::json!({"snapshot":value,"artworkChanged":changed}),
        )?;
        self.artwork = artwork.to_owned();
        Ok(())
    }
}
