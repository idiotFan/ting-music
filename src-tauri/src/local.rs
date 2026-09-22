//! Local music library (desktop). Files are chosen through the native dialog,
//! their paths are remembered by the frontend, and each launch re-admits them
//! to the asset protocol so playback never needs a copy in memory.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub artist: String,
    pub album: String,
    pub duration: u64,
    pub cover: String,
}

const AUDIO: [&str; 8] = ["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "aiff"];

/// A stable negative id derived from the path, so the same file keeps its
/// identity across launches and never collides with platform ids.
pub fn local_id(path: &str) -> i64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    // Keep it inside JavaScript's safe-integer range.
    -((hash & ((1u64 << 52) - 1)) as i64 + 1)
}

fn cover_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().ok()?.join("local-covers");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Reads the tags without ever failing the import: a file with no usable tag
/// still plays, named after itself.
pub fn describe(path: &Path, covers: Option<&Path>) -> LocalTrack {
    use lofty::{file::TaggedFileExt, tag::Accessor};
    let text = path.to_string_lossy().into_owned();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "本地音乐".into());
    let mut track = LocalTrack {
        id: local_id(&text),
        path: text.clone(),
        name: stem,
        artist: "本地音乐".into(),
        album: "本地导入".into(),
        duration: 0,
        cover: String::new(),
    };
    let Ok(file) = lofty::read_from_path(path) else {
        return track;
    };
    use lofty::file::AudioFile;
    track.duration = file.properties().duration().as_millis() as u64;
    let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) else {
        return track;
    };
    let clean =
        |s: Option<std::borrow::Cow<str>>| s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    if let Some(title) = clean(tag.title()) {
        track.name = title;
    }
    if let Some(artist) = clean(tag.artist()) {
        track.artist = artist;
    }
    if let Some(album) = clean(tag.album()) {
        track.album = album;
    }
    if let (Some(dir), Some(picture)) = (covers, tag.pictures().first()) {
        let ext = match picture.mime_type() {
            Some(lofty::picture::MimeType::Png) => "png",
            Some(lofty::picture::MimeType::Jpeg) => "jpg",
            _ => return track,
        };
        let target = dir.join(format!("{:x}.{ext}", local_id(&text).unsigned_abs()));
        if target.exists() || std::fs::write(&target, picture.data()).is_ok() {
            track.cover = target.to_string_lossy().into_owned();
        }
    }
    track
}

#[cfg(desktop)]
fn admit(app: &tauri::AppHandle, path: &str) -> bool {
    use tauri::Manager;
    app.asset_protocol_scope().allow_file(path).is_ok()
}

/// Opens the system file picker and returns the chosen tracks, admitted to the
/// asset protocol for this session.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_import(app: tauri::AppHandle) -> Result<Vec<LocalTrack>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app
        .dialog()
        .file()
        .set_title("导入本地音乐")
        .add_filter("音频文件", &AUDIO)
        .blocking_pick_files()
        .unwrap_or_default();
    let covers = cover_dir(&app);
    let mut tracks = Vec::new();
    for file in picked {
        let Ok(path) = file.into_path() else { continue };
        if !path.is_file() {
            continue;
        }
        let track = describe(&path, covers.as_deref());
        if !admit(&app, &track.path) {
            continue;
        }
        if !track.cover.is_empty() && !admit(&app, &track.cover) {
            // The song still plays; only the artwork is unavailable.
        }
        tracks.push(track);
    }
    Ok(tracks)
}

/// Re-admits remembered files at launch; returns the paths that no longer exist.
#[cfg(desktop)]
#[tauri::command]
pub fn local_restore(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut missing = Vec::new();
    for path in paths.iter().take(5000) {
        if Path::new(path).is_file() {
            admit(&app, path);
        } else {
            missing.push(path.clone());
        }
    }
    if let Some(dir) = cover_dir(&app) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                admit(&app, &entry.path().to_string_lossy());
            }
        }
    }
    Ok(missing)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_import() -> Result<Vec<LocalTrack>, String> {
    Err("此平台请使用「导入」按钮选择文件".into())
}
#[cfg(mobile)]
#[tauri::command]
pub fn local_restore(paths: Vec<String>) -> Result<Vec<String>, String> {
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_are_stable_negative_and_safe() {
        let a = local_id("/Music/a.flac");
        assert_eq!(a, local_id("/Music/a.flac"));
        assert_ne!(a, local_id("/Music/b.flac"));
        assert!(a < 0 && a.unsigned_abs() <= (1u64 << 53));
    }
    #[test]
    fn untagged_files_are_named_after_themselves() {
        let dir = std::env::temp_dir().join(format!("ting-local-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("晚风.wav");
        std::fs::write(&path, b"not really audio").unwrap();
        let track = describe(&path, None);
        assert_eq!(track.name, "晚风");
        assert_eq!(track.artist, "本地音乐");
        assert_eq!(track.duration, 0);
        assert!(track.cover.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod sample {
    /// Run with TING_LOCAL_SAMPLE=/path/to/song.flac to see real tags.
    #[test]
    #[ignore]
    fn describes_a_real_file() {
        let Ok(path) = std::env::var("TING_LOCAL_SAMPLE") else {
            return;
        };
        let dir = std::env::temp_dir().join("ting-sample-covers");
        std::fs::create_dir_all(&dir).unwrap();
        let track = super::describe(std::path::Path::new(&path), Some(&dir));
        eprintln!("{track:?}");
        assert!(track.duration > 0);
        assert!(!track.cover.is_empty());
    }
}
