use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::Manager;
mod client;
mod login;

pub struct Qq(pub tokio::sync::Mutex<Session>);
pub struct Session {
    revision: u64,
    credential: Option<Value>,
    pending: Option<(String, Value, Instant)>,
}
impl Session {
    fn restored(credential: Option<Value>) -> Self {
        Self {
            revision: 0,
            // An invalid legacy record must not prevent generating a fresh QR.
            // Keep the stored record untouched until login or explicit logout.
            credential: credential.and_then(|value| client::normalize_credential(value).ok()),
            pending: None,
        }
    }
    fn request_credential(&self, operation: &str) -> Value {
        if matches!(operation, "login_qr_start" | "login_qr_check") {
            // New authorization is independent of the currently signed-in user;
            // canceling it must leave a valid existing session intact.
            Value::Null
        } else {
            self.credential.clone().unwrap_or(Value::Null)
        }
    }
}
impl Qq {
    pub fn new() -> Self {
        Self(tokio::sync::Mutex::new(Session::restored(load())))
    }
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn load() -> Option<Value> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    generic_password(PasswordOptions::new_generic_password(
        "com.ting.music.demo",
        "qq-session",
    ))
    .ok()
    .and_then(|b| serde_json::from_slice(&b).ok())
}
#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
fn load() -> Option<Value> {
    keyring::Entry::new("com.ting.music.demo", "qq-session")
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|s| serde_json::from_str(&s).ok())
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos")),
    target_os = "android"
)))]
fn load() -> Option<Value> {
    None
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn persist(value: Option<&Value>) -> Result<(), String> {
    use security_framework::passwords::*;
    if let Some(v) = value {
        set_generic_password(
            "com.ting.music.demo",
            "qq-session",
            v.to_string().as_bytes(),
        )
        .map_err(|_| "QQ 已登录，但钥匙串保存失败，本次会话可用".into())
    } else {
        match delete_generic_password("com.ting.music.demo", "qq-session") {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()),
            Err(_) => Err("无法清除 QQ 钥匙串记录，请重试".into()),
        }
    }
}
#[cfg(any(
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
fn persist(value: Option<&Value>) -> Result<(), String> {
    let entry = keyring::Entry::new("com.ting.music.demo", "qq-session")
        .map_err(|_| "QQ 已登录，但凭据保存失败，本次会话可用".to_string())?;
    if let Some(v) = value {
        entry
            .set_password(&v.to_string())
            .map_err(|_| "QQ 已登录，但凭据保存失败，本次会话可用".into())
    } else {
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("无法清除 QQ 登录凭据，请重试".into()),
        }
    }
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos")),
    target_os = "android"
)))]
fn persist(value: Option<&Value>) -> Result<(), String> {
    if value.is_none() {
        Ok(())
    } else {
        Err("QQ 登录暂仅保留本次会话".into())
    }
}

#[cfg(target_os = "android")]
fn load() -> Option<Value> {
    crate::android_credentials::load("qq-session")
        .and_then(|value| serde_json::from_str(&value).ok())
}
#[cfg(target_os = "android")]
fn persist(value: Option<&Value>) -> Result<(), String> {
    match value {
        Some(value) => crate::android_credentials::save("qq-session", &value.to_string()),
        None => crate::android_credentials::remove("qq-session"),
    }
}

#[tauri::command]
pub async fn qq_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, Qq>,
    operation: String,
    args: Option<Value>,
) -> Result<Value, String> {
    if ![
        "account_status",
        "login_qr_start",
        "login_qr_check",
        "login_qr_cancel",
        "logout",
        "search_songs",
        "my_playlists",
        "playlist_tracks",
        "playlist_edit",
        "download_info",
        "download_match",
        "song_url",
        "song_lyric",
    ]
    .contains(&operation.as_str())
    {
        return Err("不支持的 QQ 操作".into());
    }
    let mut session = state.0.lock().await;
    let args = args.unwrap_or(json!({}));
    if operation == "logout" {
        persist(None)?;
        session.revision += 1;
        session.credential = None;
        session.pending = None;
        return Ok(Value::Null);
    }
    if operation == "login_qr_cancel" {
        session.revision += 1;
        session.pending = None;
        return Ok(Value::Null);
    }
    if operation == "account_status" && session.credential.is_none() {
        return Ok(Value::Null);
    }
    if operation == "login_qr_check" {
        let valid = session.pending.as_ref().is_some_and(|(key, _, time)| {
            args["key"].as_str() == Some(key.as_str()) && time.elapsed() < Duration::from_secs(180)
        });
        if !valid {
            // A delayed poll for an older key must not erase the current QR.
            return Ok(json!({"code":800}));
        }
    }
    if operation == "login_qr_start" {
        session.revision += 1;
        session.pending = None;
    }
    let credential = session.request_credential(&operation);
    let pending = session
        .pending
        .as_ref()
        .map(|(_, v, _)| v.clone())
        .unwrap_or(Value::Null);
    let revision = session.revision;
    drop(session);
    // Read only the existing desktop GUID; never rewrite legacy device caches.
    let guid = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|p| {
            let p = p.join("qq/device.json");
            if std::fs::metadata(&p).ok()?.len() > 65536 {
                return None;
            }
            let v: Value = serde_json::from_slice(&std::fs::read(p).ok()?).ok()?;
            v["open_udid"]
                .as_str()
                .filter(|s| s.len() <= 128)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let mut client = client::Client::new(credential, guid)?;
    let mut response = tokio::time::timeout(
        Duration::from_secs(55),
        client.execute(&operation, &args, &pending),
    )
    .await
    .map_err(|_| "QQ 请求超时")??;
    let mut session = state.0.lock().await;
    if session.revision != revision
        && [
            "login_qr_start",
            "login_qr_check",
            "account_status",
            "download_info",
            "download_match",
        ]
        .contains(&operation.as_str())
    {
        return Err("登录操作已取消或被新的操作替代".into());
    }
    let mut result = response["result"].take();
    if operation == "login_qr_start" {
        let key = uuid::Uuid::new_v4().to_string();
        session.pending = Some((key.clone(), response["pending"].take(), Instant::now()));
        result["key"] = json!(key);
    }
    if response["expired"] == true {
        session.credential = None;
        let _ = persist(None);
    }
    if response["credential"].is_object() {
        session.credential = Some(response["credential"].take());
        if let Err(e) = persist(session.credential.as_ref()) {
            if result.is_object() {
                result["warning"] = json!(e);
            }
        }
        if operation == "login_qr_check" {
            session.revision += 1;
            session.pending = None;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_saved_credentials_restore_as_signed_out_without_blocking_new_login() {
        for value in [
            json!({}),
            json!({"musicid": 0, "musickey": "fixture-only"}),
            json!({"musicid": 123, "musickey": ""}),
            json!({"legacy": "fixture-only"}),
            Value::Null,
        ] {
            let session = Session::restored(Some(value));
            assert!(session.credential.is_none());
            for operation in ["login_qr_start", "login_qr_check", "search_songs"] {
                assert!(client::Client::new(
                    session.request_credential(operation),
                    "fixture-guid".into()
                )
                .is_ok());
            }
        }
    }

    #[test]
    fn new_qr_clients_ignore_old_credentials_and_preserve_valid_sessions() {
        let mut session = Session::restored(Some(json!({
            "musicid": 123, "musickey": "fixture-only", "loginType": 2,
            "refreshKey": "fixture-refresh"
        })));
        let existing = session.credential.clone().unwrap();
        assert_eq!(existing["login_type"], 2);
        assert_eq!(existing["refresh_key"], "fixture-refresh");
        for operation in ["login_qr_start", "login_qr_check"] {
            assert!(session.request_credential(operation).is_null());
            assert_eq!(session.credential.as_ref(), Some(&existing));
        }
        assert_eq!(session.request_credential("song_url"), existing);

        // Even if a future adapter supplies malformed in-memory state, a fresh
        // authorization can still construct its client without that old state.
        session.credential = Some(json!({"musicid": 0}));
        for operation in ["login_qr_start", "login_qr_check"] {
            assert!(client::Client::new(
                session.request_credential(operation),
                "fixture-guid".into()
            )
            .is_ok());
        }
    }
}
