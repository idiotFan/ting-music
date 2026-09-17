use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{path::BaseDirectory, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct Qq(pub tokio::sync::Mutex<Session>);
pub struct Session {
    revision: u64,
    credential: Option<Value>,
    pending: Option<(String, Value, Instant)>,
}
impl Qq {
    pub fn new() -> Self {
        Self(tokio::sync::Mutex::new(Session {
            revision: 0,
            credential: load(),
            pending: None,
        }))
    }
}
#[cfg(target_os = "macos")]
fn load() -> Option<Value> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    generic_password(PasswordOptions::new_generic_password(
        "com.ting.music.demo",
        "qq-session",
    ))
    .ok()
    .and_then(|b| serde_json::from_slice(&b).ok())
}
#[cfg(not(target_os = "macos"))]
fn load() -> Option<Value> {
    None
}
#[cfg(target_os = "macos")]
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
#[cfg(not(target_os = "macos"))]
fn persist(value: Option<&Value>) -> Result<(), String> {
    if value.is_none() {
        Ok(())
    } else {
        Err("QQ 登录暂仅保留本次会话".into())
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
    let script = app
        .path()
        .resolve("qq/bridge.py", BaseDirectory::Resource)
        .map_err(|_| "QQ 工具路径不可用")?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "QQ 数据目录不可用")?
        .join("qq");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "QQ 数据目录创建失败")?;
    let input = json!({"operation":operation,"args":args,"credential":session.credential,"pending":session.pending.as_ref().map(|(_,v,_)|v),"devicePath":dir.join("device.json")});
    let revision = session.revision;
    drop(session); // Network requests must not block other QQ operations.
                   // Bundled extension modules target CPython 3.12 on Apple Silicon.
    let python = crate::runtime::python(&app)?;
    let mut child = tokio::process::Command::new(python)
        .args(["-I", "-B"])
        .arg(script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "QQ 音乐助手未能启动")?;
    let input = input.to_string();
    let work = async {
        let mut stdin = child.stdin.take().ok_or("QQ 音乐助手未就绪")?;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|_| "QQ 音乐助手输入失败")?;
        drop(stdin);
        let stdout = child.stdout.take().ok_or("QQ 音乐助手未就绪")?;
        let mut bytes = Vec::new();
        stdout
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "QQ 音乐助手输出失败")?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("QQ 音乐响应过大");
        }
        let status = child.wait().await.map_err(|_| "QQ 音乐助手执行失败")?;
        Ok((status, bytes))
    };
    let (status, output) = match tokio::time::timeout(Duration::from_secs(55), work).await {
        Ok(Ok(output)) => output,
        error => {
            let _ = child.kill().await;
            return Err(match error {
                Ok(Err(message)) => message,
                _ => "QQ 请求超时",
            }
            .into());
        }
    };
    let mut response: Value =
        serde_json::from_slice(&output).map_err(|_| "QQ 音乐助手无法加载，请重新安装 Ting")?;
    if !status.success() && !response["error"].is_string() {
        return Err("QQ 音乐助手执行失败".into());
    }
    if let Some(e) = response["error"].as_str() {
        return Err(e.into());
    }
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
