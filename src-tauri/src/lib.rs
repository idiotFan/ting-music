#[cfg(target_os = "android")]
mod android_credentials;
#[cfg(target_os = "android")]
mod android_platform;
mod catalog;
#[cfg_attr(mobile, path = "desktop_mobile.rs")]
mod desktop;
mod download;
mod download_engine;
mod http;
mod local;
mod mobile;
pub mod netease;
mod qq;
mod sync;
mod sync_model;
#[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
mod system_media;
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
#[path = "system_media_web.rs"]
mod system_media;
mod updater;
mod window_memory;
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
    width: Option<f64>,
) -> Result<(), String> {
    // The pane width is a per-machine preference; keep the window growth sane.
    let pane = width.unwrap_or(320.0).clamp(260.0, 640.0);
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
            .unwrap_or(size.width + pane);
        let width = (size.width + pane).min(available).max(720.0);
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
        let width = (size.width - added.unwrap_or(pane)).max(400.0);
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
fn set_lyrics_panel(open: bool, width: Option<f64>) -> Result<(), String> {
    let _ = (open, width);
    Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder
        .plugin(android_credentials::init())
        .plugin(android_platform::init());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    desktop::shortcut_pressed(app, shortcut, event.state())
                })
                .build(),
        )
        .manage(desktop::Desktop::default())
        .manage(updater::Updates::default());
    builder
        .manage(LyricsWindow::default())
        .manage(system_media::State::default())
        .manage(sync::SyncState::default())
        .manage(download::Downloads::default())
        // Mobile plugins initialize before setup; restore sessions only after the
        // Android Keystore bridge is ready, before any frontend commands run.
        .setup(|app| {
            use tauri::Manager;
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    unsafe extern "C" {
                        fn ting_disable_page_zoom(webview: *mut std::ffi::c_void);
                    }
                    // with_webview supplies a live WKWebView on the UI thread.
                    unsafe { ting_disable_page_zoom(webview.inner()) };
                })?;
            }
            app.manage(qq::Qq::new());
            app.manage(Api::persistent().map_err(std::io::Error::other)?);
            #[cfg(desktop)]
            {
                updater::start(app.handle());
                desktop::setup(app.handle())?;
                if let Some(window) = app.get_webview_window("main") {
                    if let Some(memory) = window_memory::load(app.handle()) {
                        let lyrics = window_memory::restore(&window, &memory);
                        if let Ok(mut added) = app.state::<LyricsWindow>().added.lock() {
                            *added = lyrics;
                        }
                    }
                    // The window is created hidden so the restore never flashes.
                    let _ = window.show();
                }
            }
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
            catalog::catalog_search,
            catalog::artist_detail,
            catalog::artist_albums,
            catalog::album_detail,
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
            download::open_download_folder,
            updater::update_ready,
            updater::update_install,
            local::local_import,
            local::local_import_folder,
            local::local_scan,
            local::local_forget_folder,
            local::local_restore,
            local::local_lyric,
            local::local_store,
            desktop::desktop_prefs,
            desktop::tray_update,
            desktop::mini_player,
            desktop::float_lyrics,
            desktop::float_lyrics_lock,
            desktop::download_dir,
            desktop::backup_save,
            desktop::backup_open,
            desktop::diagnostics
        ])
        .build(tauri::generate_context!())
        .expect("Ting could not start")
        .run(|app, event| {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                let remember = || {
                    let lyrics = app
                        .state::<LyricsWindow>()
                        .added
                        .lock()
                        .ok()
                        .and_then(|added| *added);
                    window_memory::save(app, lyrics);
                };
                match &event {
                    // Saved on the close button and on Quit alike; one write,
                    // no timers. macOS quits through Exit alone (Cmd+Q,
                    // AppleScript); other platforms close the window first.
                    tauri::RunEvent::WindowEvent {
                        label,
                        event: tauri::WindowEvent::CloseRequested { api, .. },
                        ..
                    } if label == "main" => {
                        remember();
                        if desktop::closes_to_tray(app) {
                            // Playback carries on; the tray brings it back.
                            api.prevent_close();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        } else {
                            // Helper windows must not keep a closed app alive.
                            for label in ["mini", "lyrics"] {
                                if let Some(w) = app.get_webview_window(label) {
                                    let _ = w.close();
                                }
                            }
                        }
                    }
                    tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => remember(),
                    #[cfg(target_os = "macos")]
                    tauri::RunEvent::Reopen { .. } => desktop::show_main(app),
                    _ => {}
                }
            }
            #[cfg(mobile)]
            let _ = (app, event);
        });
}
