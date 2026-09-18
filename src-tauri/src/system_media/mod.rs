//! One native system media owner. Commands return to the existing playback queue;
//! this layer never fetches a song, a remote artwork URL, or account credentials.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "linux")]
use linux::Backend;
#[cfg(target_os = "windows")]
use windows::Backend;
#[cfg(target_os = "android")]
struct Backend;

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    #[serde(default)]
    pub artwork: String,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub duration: f64,
    pub position: f64,
    pub playback_rate: f64,
}
#[derive(Clone, Deserialize, Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Playback {
    #[default]
    None,
    Paused,
    Playing,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub track: Option<Track>,
    pub playback_state: Playback,
    pub position: Option<Position>,
    pub volume: f64,
}
#[derive(Default)]
struct Inner {
    backend: Option<Backend>,
    snapshot: Snapshot,
    sequence: u64,
}
#[derive(Default)]
pub struct State(Mutex<Inner>);

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn emit(app: &tauri::AppHandle, action: &str, value: Option<(&str, f64)>) {
    let mut event = serde_json::json!({"action":action});
    if let Some((key, value)) = value {
        if !value.is_finite() {
            return;
        }
        event[key] = serde_json::json!(value);
    }
    let _ = app.emit_to("main", "system-media-action", event);
}

fn artwork_bytes(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    if value.is_empty() {
        return Ok(Vec::new());
    }
    if value.len() > 2_000_000 {
        return Err("系统封面过大".into());
    }
    let encoded = value
        .strip_prefix("data:image/png;base64,")
        .ok_or("系统封面格式无效")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "系统封面无效")?;
    if bytes.len() < 33 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return Err("系统封面无效".into());
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if !(1..=512).contains(&w) || !(1..=512).contains(&h) {
        return Err("系统封面尺寸无效".into());
    }
    Ok(bytes)
}
fn merge(previous: &Snapshot, value: &serde_json::Value) -> Result<Snapshot, String> {
    let mut next = previous.clone();
    if let Some(metadata) = value.get("metadata") {
        next.track = if metadata.is_null() {
            None
        } else {
            let mut metadata = metadata.clone();
            let artwork = metadata
                .get("artwork")
                .and_then(|a| a.get(0))
                .and_then(|a| a.get("src"))
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_owned();
            artwork_bytes(&artwork)?;
            metadata["artwork"] = artwork.into();
            let track: Track = serde_json::from_value(metadata).map_err(|_| "系统歌曲信息无效")?;
            if track.track_id.len() > 128
                || [&track.title, &track.artist, &track.album]
                    .iter()
                    .any(|s| s.len() > 8192)
            {
                return Err("系统歌曲信息过长".into());
            }
            Some(track)
        };
    }
    next.playback_state =
        serde_json::from_value(value["playbackState"].clone()).map_err(|_| "播放状态无效")?;
    next.position =
        serde_json::from_value(value["position"].clone()).map_err(|_| "进度信息无效")?;
    if let Some(p) = &mut next.position {
        if !p.duration.is_finite()
            || p.duration <= 0.0
            || p.duration > 604800.0
            || !p.position.is_finite()
            || !p.playback_rate.is_finite()
            || p.playback_rate <= 0.0
            || p.playback_rate > 16.0
        {
            return Err("进度信息无效".into());
        }
        p.position = p.position.clamp(0.0, p.duration);
    }
    next.volume = value["volume"]
        .as_f64()
        .filter(|v| v.is_finite())
        .unwrap_or(0.7)
        .clamp(0.0, 1.0);
    if next.track.is_none() {
        next.playback_state = Playback::None;
        next.position = None;
    }
    Ok(next)
}

#[tauri::command]
pub async fn system_media_init(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        Err("此平台使用 Web 媒体会话".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let state = handle.state::<State>();
            let result = (|| {
                let mut inner = state.0.lock().map_err(|_| "系统媒体状态不可用")?;
                if inner.backend.is_none() {
                    inner.backend = Some(Backend::new(&handle)?);
                }
                // A reloaded WebView starts a new sequence; discard stale metadata.
                inner.sequence = 0;
                inner.snapshot = Snapshot::default();
                inner
                    .backend
                    .as_mut()
                    .unwrap()
                    .update(&Snapshot::default())?;
                Ok(Backend::NAME.to_owned())
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| "系统媒体初始化失败")?;
        rx.await.map_err(|_| "系统媒体初始化已取消")?
    }
}
#[tauri::command]
pub async fn system_media_update(
    app: tauri::AppHandle,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, snapshot);
        Err("此平台使用 Web 媒体会话".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = (|| {
                let state = handle.state::<State>();
                let mut inner = state.0.lock().map_err(|_| "系统媒体状态不可用")?;
                let sequence = snapshot["sequence"].as_u64().ok_or("媒体序号无效")?;
                if sequence <= inner.sequence {
                    return Ok(());
                }
                let next = merge(&inner.snapshot, &snapshot)?;
                inner
                    .backend
                    .as_mut()
                    .ok_or("系统媒体尚未初始化")?
                    .update(&next)?;
                inner.snapshot = next;
                inner.sequence = sequence;
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|_| "系统媒体更新失败")?;
        rx.await.map_err(|_| "系统媒体更新已取消")?
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn save_cover(
    app: &tauri::AppHandle,
    track: &Track,
) -> Result<Option<std::path::PathBuf>, String> {
    use md5::{Digest, Md5};
    let bytes = artwork_bytes(&track.artwork)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "封面缓存不可用")?
        .join("system-artwork");
    std::fs::create_dir_all(&dir).map_err(|_| "封面缓存不可用")?;
    // Content-addressed names prevent OS image caching from showing the last song.
    let path = dir.join(format!("{:x}.png", Md5::digest(&bytes)));
    if !path.exists() {
        std::fs::write(&path, bytes).map_err(|_| "封面写入失败")?;
    }
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path() != path
                && e.path().extension().is_some_and(|x| x == "png")
                && e.metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age.as_secs() > 86400)
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deltas_preserve_track_and_clear_resets_all_transport() {
        let value = serde_json::json!({"metadata":{"trackId":"3","title":"song","artist":"artist","album":"album","artwork":[]},"playbackState":"playing","position":{"duration":100,"position":200,"playbackRate":1},"volume":2});
        let first = merge(&Snapshot::default(), &value).unwrap();
        assert_eq!(first.position.as_ref().unwrap().position, 100.0);
        assert_eq!(first.volume, 1.0);
        let delta = serde_json::json!({"playbackState":"paused","position":null,"volume":0.5});
        let second = merge(&first, &delta).unwrap();
        assert_eq!(second.track, first.track);
        let mut clear = delta;
        clear["metadata"] = serde_json::Value::Null;
        let cleared = merge(&second, &clear).unwrap();
        assert!(cleared.track.is_none());
        assert_eq!(cleared.playback_state, Playback::None);
        assert!(cleared.position.is_none());
    }
    #[test]
    fn reject_untrusted_artwork_urls_and_bad_timeline() {
        assert!(artwork_bytes("https://example.com/cover.png").is_err());
        assert!(artwork_bytes("file:///private/secret").is_err());
        assert!(artwork_bytes(&"a".repeat(2_000_001)).is_err());
        let value = serde_json::json!({"playbackState":"playing","position":{"duration":-1,"position":0,"playbackRate":1}});
        assert!(merge(&Snapshot::default(), &value).is_err());
    }
}
