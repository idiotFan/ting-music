//! Local durable outbox acknowledgement plus an explicitly granted iCloud Drive
//! folder or WebDAV account.
use crate::{
    secret_store,
    sync_model::{Batch, Document, Playlist},
    webdav,
};
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
    #[serde(default)]
    webdav: Option<webdav::Remote>,
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
            webdav: None,
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
    provider: Option<&'static str>,
    server: Option<String>,
    account: Option<String>,
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
            local.webdav = None;
            let _ = secret_store::remove(webdav::PASSWORD_ACCOUNT);
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
        let had_webdav = local.webdav.take().is_some();
        local.bookmark = None;
        local.folder = None;
        local.icloud = false;
        local.last_exchange = None;
        save(&file, &local)?;
        if had_webdav {
            secret_store::remove(webdav::PASSWORD_ACCOUNT)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| "无法停用同步")?
}
#[tauri::command]
pub async fn sync_webdav_connect(
    app: tauri::AppHandle,
    server: String,
    folder: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let remote = webdav::Remote::new(&server, &folder, &username)?;
    webdav::check_password(&password)?;
    webdav::connect(&remote, &password).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<SyncState>();
        let _guard = state.0.lock().map_err(|_| "同步状态不可用")?;
        let file = path(&app)?;
        let _disk = disk_lock(&file)?;
        let mut local = read(&file)?;
        secret_store::save(webdav::PASSWORD_ACCOUNT, &password)?;
        local.webdav = Some(remote);
        local.bookmark = None;
        local.folder = None;
        local.icloud = false;
        local.last_exchange = None;
        save(&file, &local)
    })
    .await
    .map_err(|_| "无法连接 WebDAV")?
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn exchange_webdav(
    path: &Path,
    local: &mut Local,
    mut remote: webdav::Remote,
    password: &dyn Fn() -> Option<String>,
) -> Result<(), String> {
    use md5::{Digest, Md5};
    let secret = password().ok_or("无法读取已保存的 WebDAV 密码，请重新连接")?;
    let fetched = tauri::async_runtime::block_on(webdav::fetch(&remote, &secret, &local.device))?;
    let mut merged = local.document.clone();
    for document in &fetched.documents {
        merged.merge(document)?;
    }
    let payload = serde_json::to_string(&merged).map_err(|_| "无法生成同步文件")?;
    if payload.len() > 16 * 1024 * 1024 {
        return Err("歌单同步数据超过 16 MB 上限".into());
    }
    let digest = format!("{:x}", Md5::digest(payload.as_bytes()));
    // Received edits and the ETags they came from are committed together,
    // before this device publishes its merged snapshot.
    local.document = merged;
    remote.etags = fetched.etags;
    local.webdav = Some(remote.clone());
    save(path, local)?;
    if !fetched.own || remote.uploaded.as_deref() != Some(digest.as_str()) {
        let etag = tauri::async_runtime::block_on(webdav::publish(
            &remote,
            &secret,
            &local.device,
            payload,
        ))?;
        let own = format!("device-{}.json", local.device);
        match etag {
            Some(tag) => remote.etags.insert(own, tag),
            None => remote.etags.remove(&own),
        };
        remote.uploaded = Some(digest);
    }
    local.webdav = Some(remote);
    local.last_exchange = Some(now());
    save(path, local)
}
fn update(
    path: &Path,
    batches: Vec<Batch>,
    exchange: bool,
    expected_device: Option<String>,
    password: &dyn Fn() -> Option<String>,
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
    #[cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(unused_mut))]
    let mut pending = false;
    if exchange {
        if let Some(remote) = local.webdav.clone() {
            if let Err(e) = exchange_webdav(path, &mut local, remote, password) {
                warning = Some(e);
            }
        } else if let Some(bookmark) = local.bookmark.clone() {
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
                    local.last_exchange = Some(now());
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
    let provider = if local.webdav.is_some() {
        Some("webdav")
    } else {
        local.bookmark.as_ref().map(|_| "icloud")
    };
    let remote = local.webdav.as_ref();
    Ok(Response {
        device: local.device.clone(),
        playlists: local.document.playlists(),
        ack,
        connected: provider.is_some(),
        folder: remote.map(|r| r.folder.clone()).or(local.folder),
        icloud: local.icloud,
        last_exchange: local.last_exchange,
        pending,
        warning,
        provider,
        server: remote.map(webdav::Remote::host),
        account: remote.map(|r| r.username.clone()),
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
        update(&file, batches, exchange, expected_device, &|| {
            secret_store::load(webdav::PASSWORD_ACCOUNT)
        })
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
        let batch: Batch = serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "changes": [{"id":9,"create":true,"name":"离线歌单","add":[],"order":[]}],
        }))
        .unwrap();
        let first = update(&path, vec![batch.clone()], false, None, &|| None).unwrap();
        assert_eq!(first.playlists.len(), 1);
        assert_eq!(first.ack, vec![batch.id.clone()]);
        let before = std::fs::read(&path).unwrap();
        let second = update(&path, vec![batch], false, None, &|| None).unwrap();
        assert_eq!(first.playlists, second.playlists);
        assert_eq!(before, std::fs::read(&path).unwrap());
        std::fs::remove_file(&path).unwrap();
        assert!(update(&path, vec![], false, Some(first.device), &|| None).is_err());
        assert!(
            !path.exists(),
            "missing backend state must not erase a restored frontend library"
        );
        std::fs::write(&path, b"broken").unwrap();
        assert!(update(&path, vec![], false, None, &|| None).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
        std::fs::remove_dir_all(root).unwrap();
    }

    mod dav {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use std::{
            collections::{BTreeMap, BTreeSet},
            io::{BufRead, BufReader, Read, Write},
            net::TcpListener,
            sync::{Arc, Mutex},
        };
        #[derive(Default)]
        pub struct Store {
            pub files: BTreeMap<String, (Vec<u8>, u64)>,
            pub dirs: BTreeSet<String>,
            pub log: Vec<String>,
            pub fail_put: bool,
            next: u64,
        }
        fn parent(path: &str) -> String {
            let trimmed = path.trim_end_matches('/');
            format!("{}/", trimmed.rsplit_once('/').map_or("", |(p, _)| p))
        }
        /// Minimal single-threaded WebDAV server with Nutstore's status codes.
        pub fn serve(user: &str, password: &str) -> (String, Arc<Mutex<Store>>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!("http://{}/dav", listener.local_addr().unwrap());
            let auth = format!("Basic {}", STANDARD.encode(format!("{user}:{password}")));
            let store = Arc::new(Mutex::new(Store::default()));
            store.lock().unwrap().dirs.insert("/dav/".into());
            let shared = store.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let mut stream = stream.unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    let mut parts = line.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_owned();
                    let path = parts.next().unwrap_or_default().to_owned();
                    let (mut length, mut authorized) = (0usize, false);
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        let header = header.trim_end();
                        if header.is_empty() {
                            break;
                        }
                        let (name, value) = header.split_once(':').unwrap();
                        match name.to_ascii_lowercase().as_str() {
                            "content-length" => length = value.trim().parse().unwrap(),
                            "authorization" => authorized = value.trim() == auth,
                            _ => {}
                        }
                    }
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    let mut s = shared.lock().unwrap();
                    s.log.push(format!("{method} {path}"));
                    let (code, extra, out): (u16, String, Vec<u8>) = if !authorized {
                        (401, String::new(), Vec::new())
                    } else {
                        match method.as_str() {
                            "PROPFIND" if s.dirs.contains(&path) => {
                                let mut xml = format!(
                                    r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>{path}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>"#
                                );
                                for d in s.dirs.iter().filter(|d| parent(d) == path && **d != path)
                                {
                                    xml += &format!("<d:response><d:href>{d}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>");
                                }
                                for (f, (bytes, tag)) in
                                    s.files.iter().filter(|(f, _)| parent(f) == path)
                                {
                                    xml += &format!("<d:response><d:href>{f}</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>&quot;{tag}&quot;</d:getetag><d:getcontentlength>{}</d:getcontentlength></d:prop></d:propstat></d:response>", bytes.len());
                                }
                                xml += "</d:multistatus>";
                                (207, String::new(), xml.into_bytes())
                            }
                            "PROPFIND" => (404, String::new(), Vec::new()),
                            "MKCOL" if s.dirs.contains(&path) => (405, String::new(), Vec::new()),
                            "MKCOL" if !s.dirs.contains(&parent(&path)) => {
                                (409, String::new(), Vec::new())
                            }
                            "MKCOL" => {
                                s.dirs.insert(path);
                                (201, String::new(), Vec::new())
                            }
                            "GET" => match s.files.get(&path) {
                                Some((bytes, tag)) => {
                                    (200, format!("ETag: \"{tag}\"\r\n"), bytes.clone())
                                }
                                None => (404, String::new(), Vec::new()),
                            },
                            "PUT" if s.fail_put => (503, String::new(), Vec::new()),
                            "PUT" if !s.dirs.contains(&parent(&path)) => {
                                (409, String::new(), Vec::new())
                            }
                            "PUT" => {
                                s.next += 1;
                                let tag = s.next;
                                s.files.insert(path, (body, tag));
                                (201, format!("ETag: \"{tag}\"\r\n"), Vec::new())
                            }
                            _ => (405, String::new(), Vec::new()),
                        }
                    };
                    drop(s);
                    let head = format!(
                        "HTTP/1.1 {code} X\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
                        out.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&out);
                }
            });
            (base, store)
        }
    }
    fn batch(change: serde_json::Value) -> Batch {
        serde_json::from_value(serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "changes": [change],
        }))
        .unwrap()
    }
    fn create(id: u64, name: &str) -> Batch {
        batch(serde_json::json!({"id":id,"create":true,"name":name,"add":[],"order":[]}))
    }
    fn names(r: &Response) -> Vec<String> {
        let mut out: Vec<_> = r.playlists.iter().map(|p| p.name.clone()).collect();
        out.sort();
        out
    }
    #[test]
    fn webdav_devices_merge_without_losing_local_edits() {
        const SECRET: &str = "app-secret-4f9a";
        let (base, store) = dav::serve("me@example.com", SECRET);
        let remote = webdav::Remote::new(&base, "Ting", "me@example.com").unwrap();
        let block = tauri::async_runtime::block_on;
        assert!(block(webdav::connect(&remote, "wrong"))
            .unwrap_err()
            .contains("第三方应用密码"));
        block(webdav::connect(&remote, SECRET)).unwrap();
        assert!(store
            .lock()
            .unwrap()
            .dirs
            .contains("/dav/Ting/Ting-Sync-v1/"));

        let root = std::env::temp_dir().join(format!("ting-webdav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let (a, b) = (root.join("a.json"), root.join("b.json"));
        let password = || Some(SECRET.to_owned());
        for (path, id, name) in [(&a, 1, "A 歌单"), (&b, 2, "B 歌单")] {
            update(path, vec![create(id, name)], false, None, &|| None).unwrap();
            let mut local = read(path).unwrap();
            local.webdav = Some(remote.clone());
            save(path, &local).unwrap();
        }
        let first = update(&a, vec![], true, None, &password).unwrap();
        assert_eq!(first.warning, None);
        assert_eq!(first.provider, Some("webdav"));
        assert_eq!(first.folder.as_deref(), Some("Ting"));
        assert_eq!(first.server.as_deref(), Some("127.0.0.1"));
        assert!(first.connected && first.last_exchange.is_some());
        let second = update(&b, vec![], true, None, &password).unwrap();
        assert_eq!(names(&second), ["A 歌单", "B 歌单"]);
        let first = update(&a, vec![], true, None, &password).unwrap();
        assert_eq!(names(&first), ["A 歌单", "B 歌单"]);

        // Unchanged snapshots are neither downloaded nor re-uploaded.
        store.lock().unwrap().log.clear();
        update(&a, vec![], true, None, &password).unwrap();
        assert_eq!(
            store.lock().unwrap().log,
            ["PROPFIND /dav/Ting/Ting-Sync-v1/"]
        );

        store.lock().unwrap().fail_put = true;
        let edit = create(3, "离线修改");
        let failed = update(&a, vec![edit.clone()], true, None, &password).unwrap();
        assert!(failed.warning.as_deref().unwrap().contains("600"));
        assert_eq!(failed.ack, vec![edit.id]);
        assert_eq!(names(&failed).len(), 3);
        assert_eq!(
            names(&update(&a, vec![], false, None, &|| None).unwrap()).len(),
            3
        );
        store.lock().unwrap().fail_put = false;
        assert_eq!(
            update(&a, vec![], true, None, &password).unwrap().warning,
            None
        );
        assert_eq!(
            names(&update(&b, vec![], true, None, &password).unwrap()).len(),
            3
        );

        let wrong = update(&a, vec![], true, None, &|| Some("old".into())).unwrap();
        assert!(wrong.warning.unwrap().contains("第三方应用密码"));
        assert!(update(&a, vec![], true, None, &|| None)
            .unwrap()
            .warning
            .is_some());

        let own = format!("/dav/Ting/Ting-Sync-v1/device-{}.json", first.device);
        let before = store.lock().unwrap().files[&own].clone();
        store.lock().unwrap().files.insert(
            format!(
                "/dav/Ting/Ting-Sync-v1/device-{}.json",
                uuid::Uuid::new_v4()
            ),
            (b"{broken".to_vec(), 999),
        );
        let corrupt = update(&a, vec![create(4, "损坏时的修改")], true, None, &password).unwrap();
        assert!(corrupt.warning.as_deref().unwrap().contains("损坏"));
        assert_eq!(names(&corrupt).len(), 4);
        assert_eq!(store.lock().unwrap().files[&own], before);

        let state = std::fs::read_to_string(&a).unwrap();
        assert!(!state.contains(SECRET));
        assert!(!serde_json::to_string(&corrupt).unwrap().contains(SECRET));
        assert!(store
            .lock()
            .unwrap()
            .files
            .values()
            .all(|(bytes, _)| !String::from_utf8_lossy(bytes).contains(SECRET)));
        std::fs::remove_dir_all(root).unwrap();
    }
}
