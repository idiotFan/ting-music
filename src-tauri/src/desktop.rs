//! Desktop-only surroundings of the player: the tray (menu bar on macOS),
//! closing to the tray, the mini player and floating lyrics windows, global
//! shortcuts, the download folder choice, backup files and diagnostics.
//! Every control here only sends a "player-command" to the main window; the
//! main window owns playback and answers with "player-state".
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Wry,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct Desktop {
    close_to_tray: AtomicBool,
    tray: Mutex<Option<TrayItems>>,
    shortcuts: Mutex<HashMap<u32, String>>,
}
struct TrayItems {
    now: MenuItem<Wry>,
    toggle: MenuItem<Wry>,
}

const ACTIONS: [&str; 7] = [
    "toggle",
    "previous",
    "next",
    "volume-up",
    "volume-down",
    "lyrics",
    "mini",
];

fn command(app: &AppHandle, action: &str) {
    let _ = app.emit_to("main", "player-command", action);
}
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn config(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(name))
}
fn read_config(app: &AppHandle, name: &str) -> Value {
    config(app, name)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn write_config(app: &AppHandle, name: &str, value: &Value) {
    if let Some(p) = config(app, name) {
        let _ = std::fs::write(p, value.to_string());
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Desktop>();
    let prefs = read_config(app, "desktop.json");
    state
        .close_to_tray
        .store(prefs["closeToTray"] == true, Ordering::SeqCst);
    let now = MenuItem::with_id(app, "now", "未在播放", false, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "播放", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, "previous", "上一首", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
    let lyrics = MenuItem::with_id(app, "lyrics", "桌面歌词", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "迷你播放器", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出听", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &now,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &previous,
            &next,
            &PredefinedMenuItem::separator(app)?,
            &lyrics,
            &mini,
            &show,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("ting")
        .tooltip("听 · Ting")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            "mini" => {
                let _ = toggle_mini(app);
            }
            "lyrics" => command(app, "lyrics"),
            action => command(app, action),
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    *state.tray.lock().unwrap() = Some(TrayItems { now, toggle });
    let bindings: HashMap<String, String> =
        serde_json::from_value(prefs["shortcuts"].clone()).unwrap_or_default();
    let _ = register(app, &bindings);
    Ok(())
}

/// Whether closing the main window should only hide it.
pub fn closes_to_tray(app: &AppHandle) -> bool {
    app.state::<Desktop>().close_to_tray.load(Ordering::SeqCst)
}

fn register(app: &AppHandle, bindings: &HashMap<String, String>) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = HashMap::new();
    let mut failed = Vec::new();
    for (action, accelerator) in bindings {
        if !ACTIONS.contains(&action.as_str()) || accelerator.trim().is_empty() {
            continue;
        }
        match accelerator.parse::<Shortcut>() {
            Ok(shortcut) if gs.register(shortcut).is_ok() => {
                map.insert(shortcut.id(), action.clone());
            }
            _ => failed.push(accelerator.clone()),
        }
    }
    *app.state::<Desktop>().shortcuts.lock().unwrap() = map;
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "这些快捷键无法注册（可能已被其他应用占用）：{}",
            failed.join("、")
        ))
    }
}
pub fn shortcut_pressed(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let action = app
        .state::<Desktop>()
        .shortcuts
        .lock()
        .unwrap()
        .get(&shortcut.id())
        .cloned();
    match action.as_deref() {
        Some("mini") => {
            let _ = toggle_mini(app);
        }
        Some(action) => command(app, action),
        None => {}
    }
}

#[derive(Deserialize)]
pub struct DesktopPrefs {
    close_to_tray: bool,
    shortcuts: HashMap<String, String>,
}
/// Saves the desktop preferences and applies them; shortcut errors are
/// reported but the other shortcuts still work.
#[tauri::command]
pub fn desktop_prefs(app: AppHandle, prefs: DesktopPrefs) -> Result<(), String> {
    app.state::<Desktop>()
        .close_to_tray
        .store(prefs.close_to_tray, Ordering::SeqCst);
    write_config(
        &app,
        "desktop.json",
        &json!({"closeToTray": prefs.close_to_tray, "shortcuts": prefs.shortcuts}),
    );
    register(&app, &prefs.shortcuts)
}

/// The tray's "now playing" line and its play / pause label.
#[tauri::command]
pub fn tray_update(app: AppHandle, title: String, playing: bool) {
    if let Some(items) = app.state::<Desktop>().tray.lock().unwrap().as_ref() {
        let title: String = title.chars().take(60).collect();
        let _ = items.now.set_text(if title.is_empty() {
            "未在播放".into()
        } else {
            title.clone()
        });
        let _ = items.toggle.set_text(if playing { "暂停" } else { "播放" });
    }
    if let Some(tray) = app.tray_by_id("ting") {
        let _ = tray.set_tooltip(Some(if title.is_empty() {
            "听 · Ting".into()
        } else {
            format!("听 · {title}")
        }));
    }
}

fn toggle_mini(app: &AppHandle) -> tauri::Result<bool> {
    if let Some(w) = app.get_webview_window("mini") {
        w.close()?;
        return Ok(false);
    }
    let window = WebviewWindowBuilder::new(app, "mini", WebviewUrl::App("mini.html".into()))
        .title("听 · 迷你播放器")
        .inner_size(360.0, 92.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()?;
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let origin = monitor.position().to_logical::<f64>(scale);
        let _ = window.set_position(tauri::LogicalPosition::new(
            origin.x + size.width - 380.0,
            origin.y + 60.0,
        ));
    }
    Ok(true)
}
#[tauri::command]
pub fn mini_player(app: AppHandle) -> Result<bool, String> {
    toggle_mini(&app).map_err(|_| "无法打开迷你播放器".into())
}

/// Floating lyrics: a transparent strip above everything. When locked, clicks
/// pass straight through it to whatever is underneath.
#[tauri::command]
pub fn float_lyrics(app: AppHandle, show: bool) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("lyrics") {
        if !show {
            w.close().map_err(|_| "无法关闭桌面歌词")?;
        }
        return Ok(show);
    }
    if !show {
        return Ok(false);
    }
    let window =
        WebviewWindowBuilder::new(&app, "lyrics", WebviewUrl::App("float-lyrics.html".into()))
            .title("听 · 桌面歌词")
            .inner_size(760.0, 118.0)
            .min_inner_size(360.0, 90.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .build()
            .map_err(|_| "无法打开桌面歌词")?;
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let origin = monitor.position().to_logical::<f64>(scale);
        let _ = window.set_position(tauri::LogicalPosition::new(
            origin.x + (size.width - 760.0) / 2.0,
            origin.y + size.height - 200.0,
        ));
    }
    Ok(true)
}
#[tauri::command]
pub fn float_lyrics_lock(app: AppHandle, locked: bool) -> Result<(), String> {
    let w = app.get_webview_window("lyrics").ok_or("桌面歌词未打开")?;
    w.set_ignore_cursor_events(locked)
        .map_err(|_| "无法锁定桌面歌词".into())
}

/// The folder downloads go to, or the default when none was chosen.
pub fn chosen_download_dir(app: &AppHandle) -> Option<PathBuf> {
    read_config(app, "download-dir.json")["path"]
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}
#[tauri::command]
pub async fn download_dir(app: AppHandle, pick: bool, reset: bool) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    if reset {
        write_config(&app, "download-dir.json", &json!({}));
    } else if pick {
        let Some(folder) = app
            .dialog()
            .file()
            .set_title("选择下载文件夹")
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok())
        else {
            return crate::download::directory(&app).map(|p| p.to_string_lossy().into_owned());
        };
        write_config(
            &app,
            "download-dir.json",
            &json!({"path": folder.to_string_lossy()}),
        );
    }
    crate::download::directory(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Writes a backup where the user chooses; returns the path, or "" if cancelled.
#[tauri::command]
pub async fn backup_save(app: AppHandle, name: String, content: String) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app
        .dialog()
        .file()
        .set_title("导出备份")
        .set_file_name(&name)
        .add_filter("听 · Ting 备份", &["json"])
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
    else {
        return Ok(String::new());
    };
    std::fs::write(&path, content).map_err(|_| "备份写入失败，请换个位置")?;
    Ok(path.to_string_lossy().into_owned())
}
/// Reads a backup the user picks; "" if cancelled.
#[tauri::command]
pub async fn backup_open(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app
        .dialog()
        .file()
        .set_title("导入备份")
        .add_filter("听 · Ting 备份", &["json"])
        .blocking_pick_file()
        .and_then(|f| f.into_path().ok())
    else {
        return Ok(String::new());
    };
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 32 * 1024 * 1024 {
        return Err("文件过大，不是听 · Ting 的备份".into());
    }
    std::fs::read_to_string(&path).map_err(|_| "无法读取这个文件".into())
}

#[derive(Serialize)]
pub struct Diagnostics {
    version: String,
    os: String,
    arch: String,
    family: String,
}
/// Facts about this installation for a bug report; no paths, no accounts.
#[tauri::command]
pub fn diagnostics(app: AppHandle) -> Diagnostics {
    Diagnostics {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        family: std::env::consts::FAMILY.into(),
    }
}
