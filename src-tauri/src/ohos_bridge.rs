//! HarmonyOS bridge. ArkTS seeds sandbox paths and stored sessions before Tauri
//! starts, then serves typed requests through one synchronous dispatcher; Rust
//! never touches ArkTS APIs directly and the frontend never reaches this module.
use napi_derive_ohos::napi;
use napi_ohos::{
    bindgen_prelude::*,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::Emitter;

/// `(action, payload JSON) -> result JSON`, answered on the ArkTS main thread.
type Dispatcher = ThreadsafeFunction<(String, String), String>;

struct Boot {
    files_dir: PathBuf,
    cache_dir: PathBuf,
}
static BOOT: OnceLock<Boot> = OnceLock::new();
static CREDENTIALS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static DISPATCHER: Mutex<Option<Arc<Dispatcher>>> = Mutex::new(None);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Called once from EntryAbility.onCreate, before the native module initializes.
/// `info` carries sandbox paths and the Asset Store sessions keyed by account.
#[napi]
pub fn bootstrap(info: String) -> Result<()> {
    let value: Value = serde_json::from_str(&info)
        .map_err(|_| Error::new(Status::InvalidArg, "bootstrap payload is not JSON"))?;
    let dir = |key: &str| {
        value[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
    };
    let (Some(files_dir), Some(cache_dir)) = (dir("filesDir"), dir("cacheDir")) else {
        return Err(Error::new(
            Status::InvalidArg,
            "bootstrap needs filesDir and cacheDir",
        ));
    };
    let _ = BOOT.set(Boot {
        files_dir,
        cache_dir,
    });
    let credentials = value["credentials"]
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    if let Ok(mut slot) = CREDENTIALS.lock() {
        *slot = Some(credentials);
    }
    Ok(())
}

#[napi]
pub fn register_dispatcher(callback: Arc<Dispatcher>) {
    if let Ok(mut slot) = DISPATCHER.lock() {
        *slot = Some(callback);
    }
}

/// AVSession commands arrive here and rejoin the single playback queue.
#[napi]
pub fn media_command(action: String, seek_time: Option<f64>) {
    let Some(app) = APP.get() else { return };
    let mut event = json!({ "action": action });
    if let Some(time) = seek_time.filter(|t| t.is_finite()) {
        event["seekTime"] = json!(time);
    }
    let _ = app.emit_to("main", "system-media-action", event);
}

pub fn attach(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

pub fn files_dir() -> Result<PathBuf, String> {
    BOOT.get()
        .map(|b| b.files_dir.clone())
        .ok_or_else(|| "应用目录尚未就绪".into())
}

pub fn cache_dir() -> Result<PathBuf, String> {
    BOOT.get()
        .map(|b| b.cache_dir.clone())
        .ok_or_else(|| "缓存目录尚未就绪".into())
}

fn dispatcher() -> Result<Arc<Dispatcher>, String> {
    DISPATCHER
        .lock()
        .ok()
        .and_then(|d| d.clone())
        .ok_or_else(|| "鸿蒙系统桥尚未就绪".into())
}

/// Blocking round trip; never call on the ArkTS main thread (use spawn_blocking).
pub fn call(action: &str, payload: Value) -> Result<Value, String> {
    let dispatcher = dispatcher()?;
    let (tx, rx) = mpsc::channel::<std::result::Result<String, String>>();
    let status = dispatcher.call_with_return_value(
        Ok((action.to_owned(), payload.to_string())),
        ThreadsafeFunctionCallMode::NonBlocking,
        move |result, _env| {
            // Native errors are summarized here; ArkTS never forwards credentials.
            let _ = tx.send(result.map_err(|_| "鸿蒙系统调用失败".to_owned()));
            Ok(())
        },
    );
    if status != Status::Ok {
        return Err("鸿蒙系统桥不可用".into());
    }
    let reply = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "鸿蒙系统调用超时".to_owned())??;
    let value: Value = serde_json::from_str(&reply).map_err(|_| "鸿蒙系统返回无效")?;
    if let Some(error) = value["error"].as_str() {
        return Err(error.to_owned());
    }
    Ok(value)
}

/// One-way request for work whose failure the caller cannot act on.
fn notify(action: &str, payload: Value) -> Result<(), String> {
    let dispatcher = dispatcher()?;
    let status = dispatcher.call(
        Ok((action.to_owned(), payload.to_string())),
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    if status == Status::Ok {
        Ok(())
    } else {
        Err("鸿蒙系统桥不可用".into())
    }
}

pub fn credential_load(account: &str) -> Option<String> {
    CREDENTIALS
        .lock()
        .ok()
        .and_then(|map| map.as_ref()?.get(account).cloned())
}

pub fn credential_save(account: &str, value: &str) -> Result<(), String> {
    if let Ok(mut slot) = CREDENTIALS.lock() {
        slot.get_or_insert_with(HashMap::new)
            .insert(account.to_owned(), value.to_owned());
    }
    notify(
        "credential.save",
        json!({ "account": account, "value": value }),
    )
    .map_err(|_| "已登录，但安全凭据保存失败；本次会话仍可使用".into())
}

pub fn credential_remove(account: &str) -> Result<(), String> {
    if let Ok(mut slot) = CREDENTIALS.lock() {
        if let Some(map) = slot.as_mut() {
            map.remove(account);
        }
    }
    notify("credential.remove", json!({ "account": account }))
        .map_err(|_| "无法清除安全登录凭据，请重试退出".into())
}

pub async fn share_qr(data_url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        call("qr.save", json!({ "dataUrl": data_url })).map(|_| ())
    })
    .await
    .map_err(|_| "二维码分享已中断")?
}

pub async fn open_downloads() -> Result<(), String> {
    let dir = files_dir()?.join("Ting");
    tauri::async_runtime::spawn_blocking(move || {
        call("downloads.open", json!({ "dir": dir })).map(|_| ())
    })
    .await
    .map_err(|_| "下载文件列表已关闭")?
}
