#[cfg(target_os = "android")]
mod android_credentials;
mod download;
mod download_engine;
mod http;
mod mobile;
pub mod netease;
mod qq;
mod sync;
mod sync_model;
#[cfg(any(target_os = "windows", target_os = "linux"))]
mod system_media;
#[cfg(not(any(target_os = "windows", target_os = "linux")))]
#[path = "system_media_web.rs"]
mod system_media;
use netease::{
    Api, Playback, PlaylistPage, PlaylistTracks, Profile, QrLogin, QrStatus, SearchResult,
};
#[tauri::command]
async fn search_songs(
    api: tauri::State<'_, Api>,
    query: String,
    offset: u32,
) -> Result<SearchResult, String> {
    api.search(&query, offset).await
}
#[tauri::command]
async fn song_url(
    api: tauri::State<'_, Api>,
    id: u64,
    level: Option<String>,
) -> Result<Playback, String> {
    api.playback(id, level.as_deref().unwrap_or("standard"))
        .await
}
#[tauri::command]
async fn song_lyric(api: tauri::State<'_, Api>, id: u64) -> Result<String, String> {
    api.lyric(id).await
}
#[tauri::command]
async fn account_status(api: tauri::State<'_, Api>) -> Result<Option<Profile>, String> {
    api.account().await
}
#[tauri::command]
async fn login_qr_start(api: tauri::State<'_, Api>) -> Result<QrLogin, String> {
    api.start_login().await
}
#[tauri::command]
async fn login_qr_check(api: tauri::State<'_, Api>, key: String) -> Result<QrStatus, String> {
    api.check_login(&key).await
}
#[tauri::command]
async fn login_qr_cancel(api: tauri::State<'_, Api>) -> Result<(), String> {
    api.cancel_login().await
}
#[tauri::command]
async fn send_login_code(
    api: tauri::State<'_, Api>,
    phone: String,
    country: String,
) -> Result<(), String> {
    api.send_login_code(&phone, &country).await
}
#[tauri::command]
async fn login_phone(
    api: tauri::State<'_, Api>,
    phone: String,
    country: String,
    code: String,
) -> Result<QrStatus, String> {
    api.login_phone(&phone, &country, &code).await
}
#[tauri::command]
async fn logout(api: tauri::State<'_, Api>) -> Result<(), String> {
    api.logout().await
}
#[tauri::command]
async fn my_playlists(api: tauri::State<'_, Api>, offset: u32) -> Result<PlaylistPage, String> {
    api.my_playlists(offset).await
}
#[tauri::command]
async fn playlist_tracks(
    api: tauri::State<'_, Api>,
    id: u64,
    offset: usize,
) -> Result<PlaylistTracks, String> {
    api.playlist_tracks(id, offset).await
}
#[tauri::command]
async fn playlist_edit(
    api: tauri::State<'_, Api>,
    id: u64,
    track_id: u64,
    action: String,
) -> Result<(), String> {
    api.playlist_edit(id, track_id, &action).await
}
#[derive(Default)]
struct LyricsWindow {
    #[cfg(desktop)]
    added: std::sync::Mutex<Option<f64>>,
}
#[cfg(desktop)]
#[tauri::command]
fn set_lyrics_panel(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LyricsWindow>,
    open: bool,
) -> Result<(), String> {
    let mut added = state.added.lock().map_err(|_| "窗口状态不可用")?;
    if open == added.is_some() {
        return Ok(());
    }
    let scale = window.scale_factor().map_err(|_| "无法读取窗口尺寸")?;
    let size = window
        .inner_size()
        .map_err(|_| "无法读取窗口尺寸")?
        .to_logical::<f64>(scale);
    if open {
        let available = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| m.size().width as f64 / m.scale_factor())
            .unwrap_or(size.width + 320.0);
        let width = (size.width + 320.0).min(available).max(720.0);
        window
            .set_size(tauri::LogicalSize::new(width, size.height))
            .map_err(|_| "无法展开歌词窗口")?;
        if window
            .set_min_size(Some(tauri::LogicalSize::new(720.0, 560.0)))
            .is_err()
        {
            let _ = window.set_size(tauri::LogicalSize::new(size.width, size.height));
            return Err("无法设置歌词窗口尺寸".into());
        }
        *added = Some((width - size.width).max(0.0));
    } else {
        let width = (size.width - added.unwrap_or(320.0)).max(400.0);
        window
            .set_min_size(Some(tauri::LogicalSize::new(400.0, 560.0)))
            .map_err(|_| "无法收起歌词窗口")?;
        window
            .set_size(tauri::LogicalSize::new(width, size.height))
            .map_err(|_| "无法收起歌词窗口")?;
        *added = None;
    }
    Ok(())
}
#[cfg(mobile)]
#[tauri::command]
fn set_lyrics_panel(open: bool) -> Result<(), String> {
    let _ = open;
    Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_credentials::init());
    builder
        .manage(LyricsWindow::default())
        .manage(system_media::State::default())
        .manage(sync::SyncState::default())
        .manage(download::Downloads::default())
        // Mobile plugins initialize before setup; restore sessions only after the
        // Android Keystore bridge is ready, before any frontend commands run.
        .setup(|app| {
            use tauri::Manager;
            app.manage(qq::Qq::new());
            app.manage(Api::persistent().map_err(std::io::Error::other)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_lyrics_panel,
            system_media::system_media_init,
            system_media::system_media_update,
            sync::sync_choose_folder,
            sync::sync_disconnect,
            sync::sync_library,
            qq::qq_request,
            search_songs,
            song_url,
            song_lyric,
            account_status,
            login_qr_start,
            login_qr_check,
            login_qr_cancel,
            send_login_code,
            login_phone,
            mobile::share_login_qr,
            download_engine::media_artwork,
            logout,
            my_playlists,
            playlist_tracks,
            playlist_edit,
            download::download_song,
            download::open_download_folder
        ])
        .run(tauri::generate_context!())
        .expect("Ting could not start");
}
