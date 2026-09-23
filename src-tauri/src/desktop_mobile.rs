//! Phones have no tray, extra windows or global shortcuts; these answer the
//! same commands so the page can call them without platform checks. Backups
//! land in the app's download folder, where the Files app can reach them.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;

#[derive(Deserialize)]
pub struct DesktopPrefs {
    #[allow(dead_code)]
    close_to_tray: bool,
    #[allow(dead_code)]
    shortcuts: HashMap<String, String>,
}
#[tauri::command]
pub fn desktop_prefs(prefs: DesktopPrefs) -> Result<(), String> {
    let _ = prefs;
    Ok(())
}
#[tauri::command]
pub fn tray_update(title: String, playing: bool) {
    let _ = (title, playing);
}
#[tauri::command]
pub fn mini_player() -> Result<bool, String> {
    Err("手机上没有迷你播放器".into())
}
#[tauri::command]
pub fn float_lyrics(show: bool) -> Result<bool, String> {
    let _ = show;
    Err("手机上没有桌面歌词".into())
}
#[tauri::command]
pub fn float_lyrics_lock(locked: bool) -> Result<(), String> {
    let _ = locked;
    Ok(())
}
#[tauri::command]
pub async fn download_dir(app: AppHandle, pick: bool, reset: bool) -> Result<String, String> {
    let _ = (pick, reset);
    crate::download::directory(&app).map(|p| p.to_string_lossy().into_owned())
}
#[tauri::command]
pub async fn backup_save(app: AppHandle, name: String, content: String) -> Result<String, String> {
    let dir = crate::download::directory(&app)?;
    std::fs::create_dir_all(&dir).map_err(|_| "无法写入下载目录")?;
    let name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    let path = dir.join(if name.ends_with(".json") {
        name
    } else {
        "ting-backup.json".into()
    });
    std::fs::write(&path, content).map_err(|_| "备份写入失败")?;
    Ok(path.to_string_lossy().into_owned())
}
#[tauri::command]
pub async fn backup_open() -> Result<String, String> {
    Err("请在页面中选择备份文件".into())
}
#[derive(Serialize)]
pub struct Diagnostics {
    version: String,
    os: String,
    arch: String,
    family: String,
}
#[tauri::command]
pub fn diagnostics(app: AppHandle) -> Diagnostics {
    Diagnostics {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        family: std::env::consts::FAMILY.into(),
    }
}
