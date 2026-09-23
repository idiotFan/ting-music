fn main() {
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target == "macos" || target == "ios" {
        cc::Build::new()
            .file("native/folder_sync.m")
            .file("native/page_scale.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("ting_folder_sync");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!(
            "cargo:rustc-link-lib=framework={}",
            if target == "ios" { "UIKit" } else { "AppKit" }
        );
        if target == "ios" {
            println!("cargo:rustc-link-lib=framework=UniformTypeIdentifiers");
        }
        println!("cargo:rerun-if-changed=native/folder_sync.m");
        println!("cargo:rerun-if-changed=native/page_scale.m");
    }
    // Every command is declared, so each window gets only the ones its
    // capability lists: the mini player and floating lyrics can control
    // playback windows, never accounts, files or backups.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "set_lyrics_panel",
            "system_media_init",
            "system_media_update",
            "sync_choose_folder",
            "sync_disconnect",
            "sync_library",
            "qq_request",
            "search_songs",
            "catalog_search",
            "artist_detail",
            "artist_albums",
            "album_detail",
            "song_url",
            "song_lyric",
            "account_status",
            "login_qr_start",
            "login_qr_check",
            "login_qr_cancel",
            "send_login_code",
            "login_phone",
            "share_login_qr",
            "media_artwork",
            "logout",
            "my_playlists",
            "playlist_tracks",
            "playlist_edit",
            "download_song",
            "open_download_folder",
            "update_ready",
            "update_install",
            "local_import",
            "local_import_folder",
            "local_scan",
            "local_forget_folder",
            "local_restore",
            "local_lyric",
            "local_store",
            "desktop_prefs",
            "tray_update",
            "mini_player",
            "float_lyrics",
            "float_lyrics_lock",
            "download_dir",
            "backup_save",
            "backup_open",
            "diagnostics",
        ]),
    ))
    .expect("failed to run tauri-build");
}
