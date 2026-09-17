//! Local durable outbox acknowledgement plus an explicitly granted iCloud Drive folder.
use crate::sync_model::{Batch, Document, Playlist};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path, sync::Mutex};
use tauri::Manager;
#[derive(Default)]
pub struct SyncState(pub Mutex<()>);
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Local {
    device: String,
    document: Document,
    applied: BTreeSet<String>,
    bookmark: Option<String>,
    folder: Option<String>,
    #[serde(default)]
    icloud: bool,
    last_exchange: Option<u64>,
}
impl Default for Local {
    fn default() -> Self {
        Self {
            device: uuid::Uuid::new_v4().to_string(),
            document: Document::default(),
            applied: BTreeSet::new(),
            bookmark: None,
            folder: None,
            icloud: false,
            last_exchange: None,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    device: String,
    playlists: Vec<Playlist>,
    ack: Vec<String>,
    connected: bool,
    folder: Option<String>,
    icloud: bool,
    last_exchange: Option<u64>,
    pending: bool,
    warning: Option<String>,
}
fn disk_lock(path: &Path) -> Result<std::fs::File, String> {
    let parent = path.parent().ok_or("同步目录不可用")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建同步目录")?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(|_| "无法锁定同步状态")?;
    file.lock().map_err(|_| "同步状态正被其他窗口使用")?;
    Ok(file)
}
fn read(path: &Path) -> Result<Local, String> {
    if !path.exists() {
        return Ok(Local::default());
    }
    if std::fs::metadata(path)
        .map_err(|_| "无法读取本机同步状态")?
        .len()
        > 32 * 1024 * 1024
    {
        return Err("本机同步状态过大".into());
    }
    let state: Local =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "无法读取本机同步状态")?)
            .map_err(|_| "本机同步状态损坏，未覆盖数据")?;
    state.document.validate()?;
    if uuid::Uuid::parse_str(&state.device).is_err() {
        return Err("同步设备标识无效".into());
    }
    Ok(state)
}
fn save(path: &Path, local: &Local) -> Result<(), String> {
    let bytes = serde_json::to_vec(local).map_err(|_| "无法保存本机同步状态")?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("同步数据过大，本机修改尚未确认".into());
    }
    let parent = path.parent().ok_or("同步目录不可用")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法创建本机同步目录")?;
    let temp = parent.join(format!(".sync-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| "无法保存本机同步状态")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存本机同步状态")?;
        std::fs::rename(&temp, path).map_err(|_| "无法提交本机同步状态")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod native {
    use std::ffi::{c_char, c_void, CStr, CString};
    unsafe extern "C" {
        pub fn ting_sync_choose(
            controller: *mut c_void,
            callback: extern "C" fn(*const c_char, *mut c_void),
            context: *mut c_void,
        );
        fn ting_sync_exchange(
            bookmark: *const c_char,
            filename: *const c_char,
            payload: *const c_char,
        ) -> *mut c_char;
        fn ting_sync_free(value: *mut c_char);
    }
    pub fn exchange(
        bookmark: &str,
        device: &str,
        payload: &str,
    ) -> Result<serde_json::Value, String> {
        let b = CString::new(bookmark).map_err(|_| "文件夹授权无效")?;
        let f = CString::new(format!("device-{device}.json")).map_err(|_| "设备标识无效")?;
        let p = CString::new(payload).map_err(|_| "同步数据无效")?;
        unsafe {
            let ptr = ting_sync_exchange(b.as_ptr(), f.as_ptr(), p.as_ptr());
            if ptr.is_null() {
                return Err("系统文件同步不可用".into());
            }
            let result = serde_json::from_slice(CStr::from_ptr(ptr).to_bytes());
            ting_sync_free(ptr);
            let value: serde_json::Value = result.map_err(|_| "系统文件同步响应无效")?;
            if let Some(e) = value["error"].as_str() {
                return Err(e.into());
            }
            Ok(value)
        }
    }
    type Sender = tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>;
    pub extern "C" fn selected(ptr: *const c_char, context: *mut c_void) {
        // The native picker invokes this exactly once, including cancellation.
        let sender = unsafe { Box::from_raw(context as *mut Sender) };
        let result = if ptr.is_null() {
            Err("文件夹选择不可用".into())
        } else {
            serde_json::from_slice(unsafe { CStr::from_ptr(ptr).to_bytes() })
                .map_err(|_| "文件夹选择响应无效".into())
        };
        let _ = sender.send(result);
    }
    pub async fn choose(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
        let (send, receive) = tokio::sync::oneshot::channel();
        let context = Box::into_raw(Box::new(send)) as usize;
        #[cfg(target_os = "ios")]
        let dispatch = window.with_webview(move |webview| unsafe {
            ting_sync_choose(webview.view_controller(), selected, context as *mut c_void);
        });
        #[cfg(target_os = "macos")]
        let dispatch = window.run_on_main_thread(move || unsafe {
            ting_sync_choose(std::ptr::null_mut(), selected, context as *mut c_void);
        });
        if dispatch.is_err() {
            unsafe {
                drop(Box::from_raw(context as *mut Sender));
            }
            return Err("无法打开系统文件夹选择器".into());
        }
        receive.await.map_err(|_| "系统文件夹选择已中断")?
    }
}
fn path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| "应用数据目录不可用")?
        .join("playlist-sync-v1.json"))
}
#[tauri::command]
pub async fn sync_choose_folder(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let value = native::choose(window.clone()).await?;
        if value["cancelled"].as_bool() == Some(true) {
            return Ok(false);
        }
        if let Some(e) = value["error"].as_str() {
            return Err(e.into());
        }
        let bookmark = value["bookmark"]
            .as_str()
            .ok_or("文件夹授权无效")?
            .to_owned();
        if bookmark.len() > 65536 {
            return Err("文件夹授权过大".into());
        }
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<SyncState>();
            let _guard = state.0.lock().map_err(|_| "同步状态不可用")?;
            let file = path(&app)?;
            let _disk = disk_lock(&file)?;
            let mut local = read(&file)?;
            local.bookmark = Some(bookmark);
            local.folder = value["folder"].as_str().map(str::to_owned);
            local.icloud = value["icloud"].as_bool().unwrap_or(false);
            local.last_exchange = None;
            save(&file, &local)?;
            Ok(true)
        })
        .await
        .map_err(|_| "无法连接同步文件夹")?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = window;
        Err("此版本的 iCloud 同步仅支持 Mac 和 iPhone".into())
    }
}
#[tauri::command]
pub async fn sync_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SyncState>();
        let _guard = state.0.lock().map_err(|_| "同步状态不可用")?;
        let file = path(&app)?;
        let _disk = disk_lock(&file)?;
        let mut local = read(&file)?;
        local.bookmark = None;
        local.folder = None;
        local.icloud = false;
        local.last_exchange = None;
        save(&file, &local)
    })
    .await
    .map_err(|_| "无法停用同步")?
}
fn update(
    path: &Path,
    batches: Vec<Batch>,
    exchange: bool,
    expected_device: Option<String>,
) -> Result<Response, String> {
    if batches.len() > 2000 {
        return Err("待同步修改过多，请重启后重试".into());
    }
    let mut local = read(path)?;
    if expected_device.is_some_and(|d| d != local.device) {
        return Err("本机同步数据库已变化，暂停同步以保护歌单，请恢复应用数据备份".into());
    }
    let mut ack = Vec::new();
    for batch in batches {
        if !local.applied.contains(&batch.id) {
            local.document.apply(&batch, &local.device)?;
            local.applied.insert(batch.id.clone());
        }
        ack.push(batch.id);
    }
    // Acknowledge only after local durability; cloud failures must not lose edits.
    save(path, &local)?;
    let mut warning = None;
    let mut pending = false;
    if exchange {
        if let Some(bookmark) = local.bookmark.clone() {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            {
                let result = (|| {
                    let response = native::exchange(&bookmark, &local.device, "")?;
                    let mut merged = local.document.clone();
                    for text in response["documents"].as_array().ok_or("同步文件列表无效")?
                    {
                        let doc: Document =
                            serde_json::from_str(text.as_str().ok_or("同步文件无效")?)
                                .map_err(|_| "同步文件损坏或版本过新，未覆盖云端文件")?;
                        merged.merge(&doc)?;
                    }
                    let payload = serde_json::to_string(&merged).map_err(|_| "无法生成同步文件")?;
                    if payload.len() > 16 * 1024 * 1024 {
                        return Err("歌单同步数据超过 16 MB 上限".to_string());
                    }
                    // Persist received edits before publishing our merged device snapshot.
                    local.document = merged;
                    if let Some(grant) = response["bookmark"].as_str() {
                        local.bookmark = Some(grant.into());
                    }
                    save(path, &local)?;
                    let written = native::exchange(
                        local.bookmark.as_deref().unwrap(),
                        &local.device,
                        &payload,
                    )?;
                    pending = response["pending"].as_bool().unwrap_or(false)
                        || written["pending"].as_bool().unwrap_or(false);
                    local.last_exchange = Some(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    );
                    save(path, &local)?;
                    Ok(())
                })();
                if let Err(e) = result {
                    warning = Some(e);
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            {
                let _ = bookmark;
                warning = Some("此平台不支持 iCloud 文件夹同步".into());
            }
        }
    }
    Ok(Response {
        device: local.device,
        playlists: local.document.playlists(),
        ack,
        connected: local.bookmark.is_some(),
        folder: local.folder,
        icloud: local.icloud,
        last_exchange: local.last_exchange,
        pending,
        warning,
    })
}
#[tauri::command]
pub async fn sync_library(
    app: tauri::AppHandle,
    batches: Vec<Batch>,
    exchange: bool,
    expected_device: Option<String>,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SyncState>();
        let _guard = state.0.lock().map_err(|_| "同步状态不可用")?;
        let file = path(&app)?;
        let _disk = disk_lock(&file)?;
        update(&file, batches, exchange, expected_device)
    })
    .await
    .map_err(|_| "同步任务中断，本机歌单仍保留")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_recovery_acknowledges_batches_once_and_preserves_corruption() {
        let root = std::env::temp_dir().join(format!("ting-sync-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("state.json");
        let batch:Batch=serde_json::from_value(serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),"changes":[{"id":9,"create":true,"name":"离线歌单","add":[],"order":[]}]})).unwrap();
        let first = update(&path, vec![batch.clone()], false, None).unwrap();
        assert_eq!(first.playlists.len(), 1);
        assert_eq!(first.ack, vec![batch.id.clone()]);
        let before = std::fs::read(&path).unwrap();
        let second = update(&path, vec![batch], false, None).unwrap();
        assert_eq!(first.playlists, second.playlists);
        assert_eq!(before, std::fs::read(&path).unwrap());
        std::fs::remove_file(&path).unwrap();
        assert!(update(&path, vec![], false, Some(first.device)).is_err());
        assert!(
            !path.exists(),
            "missing backend state must not erase a restored frontend library"
        );
        std::fs::write(&path, b"broken").unwrap();
        assert!(update(&path, vec![], false, None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
        std::fs::remove_dir_all(root).unwrap();
    }
}
