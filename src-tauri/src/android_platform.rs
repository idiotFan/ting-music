//! Android integrations are backend-only; the frontend uses the existing commands.
use serde_json::{json, Value};
use std::sync::OnceLock;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Emitter,
};

static PLATFORM: OnceLock<PluginHandle<tauri::Wry>> = OnceLock::new();

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("android-platform")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.ting.music.demo", "PlatformPlugin")?;
            let app = app.clone();
            let events = tauri::ipc::Channel::<Value>::new(move |event| {
                if let Ok(event) = event.deserialize::<Value>() {
                    let _ = app.emit_to("main", "system-media-action", event);
                }
                Ok(())
            });
            handle.run_mobile_plugin::<()>(
                "registerListener",
                json!({"event":"media-action", "handler":events}),
            )?;
            PLATFORM
                .set(handle)
                .map_err(|_| "Android platform already initialized")?;
            Ok(())
        })
        .invoke_handler(|invoke| {
            invoke
                .resolver
                .reject("Android platform bridge is backend-only");
            true
        })
        .build()
}

pub fn call<T: serde::de::DeserializeOwned>(command: &str, value: Value) -> Result<T, String> {
    PLATFORM
        .get()
        .ok_or("Android 系统功能尚未就绪")?
        .run_mobile_plugin(command, value)
        .map_err(|_| "Android 系统操作未完成，请重试".into())
}

pub async fn share_qr(data_url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        call::<()>("shareQr", json!({"dataUrl": data_url}))
    })
    .await
    .map_err(|_| "二维码分享已中断")?
}

pub async fn open_downloads() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| call::<()>("openDownloads", json!({})))
        .await
        .map_err(|_| "下载文件列表已关闭")?
}
