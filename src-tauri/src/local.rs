//! Local music library. Files are remembered by path and re-admitted to the
//! asset protocol every launch, so playback never holds a copy in memory.
//! Desktop picks files and folders with the system dialog; phones copy what
//! they import into the app's own storage (see `local_store`). Songs this app
//! downloaded carry a `.json` note naming the platform track they came from.
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Origin {
    pub source: String,
    pub id: u64,
}
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
    /// The platform track this file was downloaded from, when known.
    pub origin: Option<Origin>,
    /// ReplayGain track gain in dB, when the file carries one.
    pub gain: Option<f64>,
}

pub const AUDIO: [&str; 9] = [
    "mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "aiff", "aif",
];
const SCAN_LIMIT: usize = 5000;
const SCAN_DEPTH: usize = 8;

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

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
}

fn cover_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("local-covers");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The download note next to a file this app saved: `{origin:{platform,id}}`.
pub fn origin(path: &Path) -> Option<Origin> {
    let note = path.with_extension("json");
    if std::fs::metadata(&note).ok()?.len() > 256 * 1024 {
        return None;
    }
    let v: Value = serde_json::from_slice(&std::fs::read(note).ok()?).ok()?;
    let source = v["origin"]["platform"].as_str()?;
    let id = v["origin"]["id"].as_u64().filter(|id| *id > 0)?;
    ["netease", "qq"].contains(&source).then(|| Origin {
        source: source.into(),
        id,
    })
}

/// Reads the tags without ever failing the import: a file with no usable tag
/// still plays, named after itself.
pub fn describe(path: &Path, covers: Option<&Path>) -> LocalTrack {
    use lofty::{file::TaggedFileExt, prelude::ItemKey, tag::Accessor};
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
        origin: origin(path),
        gain: None,
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
    track.gain = tag
        .get_string(&ItemKey::ReplayGainTrackGain)
        .and_then(parse_gain);
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

/// "-6.52 dB" → -6.52, kept within what a volume scale can honour.
pub fn parse_gain(text: &str) -> Option<f64> {
    let number: String = text
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace())
        .to_owned();
    number
        .parse::<f64>()
        .ok()
        .filter(|g| g.is_finite() && (-30.0..=20.0).contains(g))
}

/// Every audio file under `root`, skipping hidden entries (our own `.ting-*`
/// scratch folders among them), within fixed depth and count limits.
pub fn walk(root: &Path, found: &mut Vec<PathBuf>) {
    walk_new(root, &Default::default(), found)
}
/// Like `walk`, but files already known are skipped before they count
/// toward the limit, so a large library never hides new songs.
pub fn walk_new(root: &Path, known: &std::collections::HashSet<String>, found: &mut Vec<PathBuf>) {
    fn visit(
        dir: &Path,
        depth: usize,
        known: &std::collections::HashSet<String>,
        found: &mut Vec<PathBuf>,
    ) {
        if depth > SCAN_DEPTH || found.len() >= SCAN_LIMIT {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if found.len() >= SCAN_LIMIT {
                return;
            }
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                visit(&path, depth + 1, known, found);
            } else if kind.is_file() && is_audio(&path) && !known.contains(&*path.to_string_lossy())
            {
                found.push(path);
            }
        }
    }
    visit(root, 0, known, found);
}

fn admit(app: &tauri::AppHandle, path: &str) -> bool {
    app.asset_protocol_scope().allow_file(path).is_ok()
}
fn admit_track(app: &tauri::AppHandle, track: &LocalTrack) -> bool {
    if !admit(app, &track.path) {
        return false;
    }
    if !track.cover.is_empty() {
        // The song still plays if only the artwork is refused.
        admit(app, &track.cover);
    }
    true
}

// Folders the user picked, kept on this side so the page can only ever ask
// for places the user chose (plus the download folder).
fn folders_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("local-folders.json"))
}
pub fn saved_folders(app: &tauri::AppHandle) -> Vec<String> {
    folders_file(app)
        .and_then(|f| std::fs::read(f).ok())
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .unwrap_or_default()
}
fn save_folders(app: &tauri::AppHandle, folders: &[String]) {
    if let (Some(file), Ok(json)) = (folders_file(app), serde_json::to_vec(folders)) {
        let _ = std::fs::write(file, json);
    }
}

fn describe_all(app: &tauri::AppHandle, paths: Vec<PathBuf>) -> Vec<LocalTrack> {
    let covers = cover_dir(app);
    paths
        .into_iter()
        .map(|p| describe(&p, covers.as_deref()))
        .filter(|t| admit_track(app, t))
        .collect()
}

/// Opens the system file picker and returns the chosen tracks.
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
    let paths: Vec<PathBuf> = picked
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .filter(|p| p.is_file() && is_audio(p))
        .collect();
    tauri::async_runtime::spawn_blocking(move || describe_all(&app, paths))
        .await
        .map_err(|_| "导入未完成".into())
}

#[derive(Serialize)]
pub struct FolderImport {
    folder: Option<String>,
    tracks: Vec<LocalTrack>,
}
/// Picks a folder, remembers it, and returns every audio file inside.
#[cfg(desktop)]
#[tauri::command]
pub async fn local_import_folder(app: tauri::AppHandle) -> Result<FolderImport, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(folder) = app
        .dialog()
        .file()
        .set_title("导入文件夹")
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
    else {
        return Ok(FolderImport {
            folder: None,
            tracks: vec![],
        });
    };
    let text = folder.to_string_lossy().into_owned();
    let mut folders = saved_folders(&app);
    if !folders.contains(&text) {
        folders.push(text.clone());
        save_folders(&app, &folders);
    }
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        let mut found = Vec::new();
        walk(&folder, &mut found);
        describe_all(&app, found)
    })
    .await
    .map_err(|_| "导入未完成")?;
    Ok(FolderImport {
        folder: Some(text),
        tracks,
    })
}

#[derive(Serialize)]
pub struct Scan {
    folders: Vec<String>,
    download_folder: Option<String>,
    tracks: Vec<LocalTrack>,
}
/// Finds files added since the last look in the remembered folders and, when
/// asked, the download folder. Files the page already knows are skipped
/// without reading their tags.
#[tauri::command]
pub async fn local_scan(
    app: tauri::AppHandle,
    known: Vec<String>,
    downloads: bool,
) -> Result<Scan, String> {
    let folders = saved_folders(&app);
    let download_folder = if downloads {
        crate::download::directory(&app)
            .ok()
            .map(|d| d.to_string_lossy().into_owned())
    } else {
        None
    };
    let roots: Vec<String> = folders
        .iter()
        .cloned()
        .chain(download_folder.clone())
        .collect();
    let tracks = tauri::async_runtime::spawn_blocking(move || {
        let known: std::collections::HashSet<String> = known.into_iter().collect();
        let mut found = Vec::new();
        // Each root gets its own allowance, so the download folder is never
        // crowded out by a large remembered folder.
        for root in roots {
            let mut here = Vec::new();
            walk_new(Path::new(&root), &known, &mut here);
            found.extend(here);
        }
        found.sort();
        found.dedup();
        describe_all(&app, found)
    })
    .await
    .map_err(|_| "扫描未完成")?;
    Ok(Scan {
        folders,
        download_folder,
        tracks,
    })
}

#[cfg(mobile)]
#[tauri::command]
pub async fn local_import() -> Result<Vec<LocalTrack>, String> {
    Err("此平台请使用「导入」按钮选择文件".into())
}
#[cfg(mobile)]
#[tauri::command]
pub async fn local_import_folder() -> Result<FolderImport, String> {
    Err("此平台暂不支持导入文件夹".into())
}

#[tauri::command]
pub fn local_forget_folder(app: tauri::AppHandle, folder: String) -> Vec<String> {
    let mut folders = saved_folders(&app);
    folders.retain(|f| f != &folder);
    save_folders(&app, &folders);
    folders
}

/// Re-admits remembered files at launch; returns the paths that no longer exist.
#[tauri::command]
pub fn local_restore(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut missing = Vec::new();
    for path in &paths {
        let file = Path::new(path);
        // Only audio files are ever re-admitted: the page's list cannot open
        // anything else on disk to the web view.
        if !is_audio(file) || !file.is_absolute() {
            continue;
        }
        if file.is_file() {
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

/// Lyrics for a library file: the `.lrc` beside it, else the embedded tag.
/// Only files already admitted to the asset protocol can be asked about.
#[tauri::command]
pub fn local_lyric(app: tauri::AppHandle, path: String) -> Option<String> {
    let file = Path::new(&path);
    if !is_audio(file) || !app.asset_protocol_scope().is_allowed(file) {
        return None;
    }
    let lrc = file.with_extension("lrc");
    if let Ok(meta) = std::fs::metadata(&lrc) {
        if meta.len() <= 1024 * 1024 {
            if let Ok(text) = std::fs::read(&lrc) {
                let text = String::from_utf8_lossy(&text).into_owned();
                if !text.trim().is_empty() {
                    return Some(text);
                }
            }
        }
    }
    use lofty::{file::TaggedFileExt, prelude::ItemKey};
    let tagged = lofty::read_from_path(file).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    tag.get_string(&ItemKey::Lyrics)
        .map(str::to_owned)
        .filter(|s| !s.trim().is_empty())
}

/// Keeps a copy of a file picked on a phone inside the app's own storage, so
/// it plays after a restart without any lasting permission to the original.
#[tauri::command]
pub async fn local_store(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<LocalTrack, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("导入数据无效".into());
    };
    if bytes.is_empty() || bytes.len() > 1024 * 1024 * 1024 {
        return Err("文件过大或为空".into());
    }
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode(v))
        .unwrap_or_default();
    let name = safe_name(&name).ok_or("不支持的音频文件")?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "应用存储不可用")?
        .join("imported");
    std::fs::create_dir_all(&dir).map_err(|_| "无法写入应用存储")?;
    let target = unique(&dir, &name);
    std::fs::write(&target, bytes).map_err(|_| "无法写入应用存储")?;
    let covers = cover_dir(&app);
    let track = describe(&target, covers.as_deref());
    admit_track(&app, &track);
    Ok(track)
}
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
/// A plain file name with an audio extension; no separators, no hidden files.
pub fn safe_name(name: &str) -> Option<String> {
    let name: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(160)
        .collect();
    (!name.is_empty() && is_audio(Path::new(&name))).then_some(name)
}
fn unique(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().unwrap_or_default().to_string_lossy();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}).{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ting-local-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn ids_are_stable_negative_and_safe() {
        let a = local_id("/Music/a.flac");
        assert_eq!(a, local_id("/Music/a.flac"));
        assert_ne!(a, local_id("/Music/b.flac"));
        assert!(a < 0 && a.unsigned_abs() <= (1u64 << 53));
    }
    #[test]
    fn untagged_files_are_named_after_themselves() {
        let dir = temp("untagged");
        let path = dir.join("晚风.wav");
        std::fs::write(&path, b"not really audio").unwrap();
        let track = describe(&path, None);
        assert_eq!(track.name, "晚风");
        assert_eq!(track.artist, "本地音乐");
        assert_eq!(track.duration, 0);
        assert!(track.cover.is_empty() && track.origin.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn download_notes_name_the_platform_track() {
        let dir = temp("origin");
        let path = dir.join("晴天 - 周杰伦 [186016].flac");
        std::fs::write(&path, b"x").unwrap();
        std::fs::write(
            path.with_extension("json"),
            br#"{"origin":{"platform":"netease","id":186016},"audio":{"platform":"qq","id":1}}"#,
        )
        .unwrap();
        assert_eq!(
            origin(&path),
            Some(Origin {
                source: "netease".into(),
                id: 186016
            })
        );
        std::fs::write(
            path.with_extension("json"),
            br#"{"origin":{"platform":"x","id":1}}"#,
        )
        .unwrap();
        assert_eq!(origin(&path), None);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn walking_skips_hidden_scratch_and_non_audio() {
        let dir = temp("walk");
        std::fs::create_dir_all(dir.join("专辑/CD1")).unwrap();
        std::fs::create_dir_all(dir.join(".ting-scratch")).unwrap();
        for f in [
            "a.flac",
            "专辑/CD1/b.MP3",
            "专辑/cover.jpg",
            ".ting-scratch/c.flac",
            ".hidden.flac",
            "a.lrc",
        ] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let mut found = Vec::new();
        walk(&dir, &mut found);
        let names: Vec<_> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["a.flac", "b.MP3"]);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn gains_and_names_are_validated() {
        assert_eq!(parse_gain("-6.52 dB"), Some(-6.52));
        assert_eq!(parse_gain("+2.0 dB"), Some(2.0));
        assert_eq!(parse_gain("loud"), None);
        assert_eq!(parse_gain("-99 dB"), None);
        assert_eq!(safe_name("../../晴天.flac").as_deref(), Some("晴天.flac"));
        assert_eq!(safe_name("a/b\\c.mp3").as_deref(), Some("abc.mp3"));
        assert_eq!(safe_name("x.exe"), None);
        assert_eq!(percent_decode("%E6%99%B4%E5%A4%A9.flac"), "晴天.flac");
        let dir = temp("unique");
        std::fs::write(dir.join("a.mp3"), b"x").unwrap();
        assert_eq!(unique(&dir, "a.mp3").file_name().unwrap(), "a (2).mp3");
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
