//! Backend-only Android credential bridge. Never expose cookies through WebView IPC.
use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};

static STORE: OnceLock<PluginHandle<tauri::Wry>> = OnceLock::new();

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("credentials")
        .setup(|_, api| {
            let handle = api.register_android_plugin("com.ting.music.demo", "CredentialPlugin")?;
            STORE
                .set(handle)
                .map_err(|_| "Credential store already initialized")?;
            Ok(())
        })
        // Native commands are reachable only through the Rust PluginHandle.
        // Returning true also prevents Tauri's mobile command fallback.
        .invoke_handler(|invoke| {
            invoke.resolver.reject("Credential storage is backend-only");
            true
        })
        .build()
}

fn handle() -> Result<&'static PluginHandle<tauri::Wry>, String> {
    STORE.get().ok_or_else(|| "安全凭据存储尚未就绪".into())
}

#[derive(Deserialize)]
struct Record {
    value: Option<String>,
}

pub fn load(account: &str) -> Option<String> {
    let result = handle().and_then(|store| {
        store
            .run_mobile_plugin::<Record>("read", json!({ "account": account }))
            .map_err(|_| "无法读取安全凭据".to_string())
    });
    match result {
        Ok(record) => record.value,
        Err(_) => {
            // Preserve unreadable records. Never log native errors or credential values.
            eprintln!("Android credential restore failed; saved record retained");
            None
        }
    }
}

pub fn save(account: &str, value: &str) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<()>("write", json!({ "account": account, "value": value }))
        .map_err(|_| "已登录，但安全凭据保存失败；本次会话仍可使用".into())
}

pub fn remove(account: &str) -> Result<(), String> {
    handle()?
        .run_mobile_plugin::<()>("remove", json!({ "account": account }))
        .map_err(|_| "无法清除安全登录凭据，请重试退出".into())
}
