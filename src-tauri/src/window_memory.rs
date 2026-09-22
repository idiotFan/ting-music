//! Remembers where the main window was when the app closed, and brings it
//! back there. The lyrics pane's share of the width is stored too, so the
//! frontend can reopen the pane without growing the window a second time.
#![cfg(desktop)]
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct Memory {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
    /// Logical width the lyrics pane added, when it was open at close.
    pub lyrics: Option<f64>,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("window.json"))
}

pub fn capture(window: &WebviewWindow, lyrics: Option<f64>) -> Option<Memory> {
    // Full screen and minimized windows report sizes nobody wants back.
    if window.is_fullscreen().ok()? || window.is_minimized().ok()? {
        return None;
    }
    let maximized = window.is_maximized().ok()?;
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    if size.width == 0 || size.height == 0 {
        return None;
    }
    Some(Memory {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
        lyrics,
    })
}

pub fn save(app: &AppHandle, lyrics: Option<f64>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(memory) = capture(&window, lyrics) else {
        return;
    };
    let Some(path) = file(app) else { return };
    if let Ok(json) = serde_json::to_vec(&memory) {
        let _ = std::fs::write(path, json);
    }
}

pub fn load(app: &AppHandle) -> Option<Memory> {
    let text = std::fs::read(file(app)?).ok()?;
    serde_json::from_slice(&text).ok()
}

/// Whether the remembered spot still lands on a connected monitor, so a
/// window never comes back on a screen that has since been unplugged.
pub fn visible(memory: &Memory, monitors: &[(PhysicalPosition<i32>, PhysicalSize<u32>)]) -> bool {
    monitors.iter().any(|(origin, size)| {
        let right = origin.x + size.width as i32;
        let bottom = origin.y + size.height as i32;
        // At least a hand's worth of the title bar must stay reachable.
        memory.x + memory.width as i32 - 80 > origin.x
            && memory.x + 80 < right
            && memory.y >= origin.y - 8
            && memory.y + 40 < bottom
    })
}

/// Applies the memory before the window is shown; returns the lyrics width to
/// seed the pane state with.
pub fn restore(window: &WebviewWindow, memory: &Memory) -> Option<f64> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = PhysicalSize::new(memory.width, memory.height).to_logical::<f64>(scale);
    let (min_w, min_h) = (
        if memory.lyrics.is_some() {
            720.0
        } else {
            400.0
        },
        560.0,
    );
    let width = logical.width.max(min_w).min(8192.0);
    let height = logical.height.max(min_h).min(8192.0);
    let monitors: Vec<_> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (*m.position(), *m.size()))
        .collect();
    if memory.lyrics.is_some() {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(min_w, min_h)));
    }
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    if visible(memory, &monitors) {
        let _ = window.set_position(PhysicalPosition::new(memory.x, memory.y));
    } else {
        let _ = window.center();
    }
    if memory.maximized {
        let _ = window.maximize();
    }
    memory.lyrics.filter(|w| *w > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn memory(x: i32, y: i32) -> Memory {
        Memory {
            x,
            y,
            width: 480,
            height: 720,
            maximized: false,
            lyrics: None,
        }
    }
    #[test]
    fn spots_on_a_connected_monitor_are_kept() {
        let screens = [(PhysicalPosition::new(0, 0), PhysicalSize::new(2560, 1440))];
        assert!(visible(&memory(100, 50), &screens));
        assert!(visible(&memory(2400, 50), &screens)); // partly off the right edge
        assert!(!visible(&memory(2600, 50), &screens)); // fully past the edge
        assert!(!visible(&memory(100, 1500), &screens)); // title bar below the screen
        assert!(!visible(&memory(-3000, 50), &screens)); // an unplugged left monitor
    }
    #[test]
    fn memory_survives_a_round_trip() {
        let saved = Memory {
            lyrics: Some(320.0),
            maximized: true,
            ..memory(10, 20)
        };
        let json = serde_json::to_vec(&saved).unwrap();
        assert_eq!(serde_json::from_slice::<Memory>(&json).unwrap(), saved);
    }
}
