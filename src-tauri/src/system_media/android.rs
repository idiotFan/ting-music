use super::*;

pub struct Backend {
    artwork: String,
}
impl Backend {
    pub const NAME: &'static str = "android";
    pub fn new(_: &tauri::AppHandle) -> Result<Self, String> {
        crate::android_platform::call::<()>("initMedia", serde_json::json!({}))?;
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
        crate::android_platform::call::<()>(
            "updateMedia",
            serde_json::json!({"snapshot":value,"artworkChanged":changed}),
        )?;
        self.artwork = artwork.to_owned();
        Ok(())
    }
}
