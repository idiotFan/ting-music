use super::*;
use std::{
    ffi::{c_char, CStr, CString},
    sync::OnceLock,
};
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
extern "C" {
    fn ting_media_init(callback: extern "C" fn(*const c_char));
    fn ting_media_update(json: *const c_char) -> i32;
}
extern "C" fn event(json: *const c_char) {
    if json.is_null() {
        return;
    }
    let data = unsafe { CStr::from_ptr(json) }.to_bytes();
    if let (Some(app), Ok(value)) = (APP.get(), serde_json::from_slice::<serde_json::Value>(data)) {
        let _ = app.emit_to("main", "system-media-action", value);
    }
}
pub struct Backend;
impl Backend {
    pub const NAME: &'static str = "apple";
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let _ = APP.set(app.clone());
        unsafe {
            ting_media_init(event);
        }
        Ok(Self)
    }
    pub fn update(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let json = CString::new(serde_json::to_vec(snapshot).map_err(|_| "系统媒体数据无效")?)
            .map_err(|_| "系统媒体数据无效")?;
        if unsafe { ting_media_update(json.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("系统媒体会话更新失败".into())
        }
    }
}
