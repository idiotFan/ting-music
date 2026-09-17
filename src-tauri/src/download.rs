use crate::netease::Api;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{path::BaseDirectory, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
pub struct Downloads(AtomicBool);
struct Guard<'a>(&'a AtomicBool);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .download_dir()
        .map_err(|_| "找不到下载目录")?
        .join("Ting"))
}
fn account_cookie(cookie: &str) -> Option<&str> {
    cookie
        .split(';')
        .filter_map(|value| value.trim().split_once('='))
        .find_map(|(key, value)| (key == "MUSIC_U").then_some(value))
}

async fn helper(app: &tauri::AppHandle, input: Value, timeout: Duration) -> Result<Value, String> {
    let script = app
        .path()
        .resolve("downloader/download_one.py", BaseDirectory::Resource)
        .map_err(|_| "下载工具路径不可用")?;
    let python = crate::runtime::python(app)?;
    let input = serde_json::to_vec(&input).map_err(|_| "无法初始化下载")?;
    let mut child = tokio::process::Command::new(python)
        .args(["-I", "-B"])
        .arg(script)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "下载助手未能启动，请重新安装 Ting")?;
    // Include stdin IO in the deadline and cap child output before decoding JSON.
    let work = async {
        let mut stdin = child.stdin.take().ok_or("下载助手未就绪")?;
        stdin
            .write_all(&input)
            .await
            .map_err(|_| "下载助手输入失败")?;
        drop(stdin);
        let stdout = child.stdout.take().ok_or("下载助手未就绪")?;
        let mut bytes = Vec::new();
        stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "下载助手输出失败")?;
        if bytes.len() > 1024 * 1024 {
            return Err("下载助手响应过大");
        }
        let status = child.wait().await.map_err(|_| "下载助手执行失败")?;
        Ok((status, bytes))
    };
    let (status, output) = match tokio::time::timeout(timeout, work).await {
        Ok(Ok(output)) => output,
        error => {
            let _ = child.kill().await;
            return Err(match error {
                Ok(Err(message)) => message,
                _ => "下载超时，请重试",
            }
            .into());
        }
    };
    let result: Value =
        serde_json::from_slice(&output).map_err(|_| "下载助手无法加载，请重新安装 Ting")?;
    if status.success() && result["ok"] == true {
        Ok(result["result"].clone())
    } else {
        Err(result["error"]
            .as_str()
            .unwrap_or("下载失败，请检查 Ting 当前登录状态")
            .into())
    }
}

#[tauri::command]
pub async fn download_song(
    app: tauri::AppHandle,
    api: tauri::State<'_, Api>,
    state: tauri::State<'_, Downloads>,
    qq: tauri::State<'_, crate::qq::Qq>,
    id: u64,
    source: Option<String>,
) -> Result<Value, String> {
    if id == 0 {
        return Err("请选择在线歌曲".into());
    }
    let source = source.as_deref().unwrap_or("netease");
    if !["netease", "qq"].contains(&source) {
        return Err("不支持的下载平台".into());
    }
    if state
        .0
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return Err("已有歌曲正在下载".into());
    }
    let _guard = Guard(&state.0);
    let (info, fallback) = if source == "qq" {
        (
            crate::qq::qq_request(
                app.clone(),
                qq,
                "download_info".into(),
                Some(json!({"id":id})),
            )
            .await?,
            Value::Null,
        )
    } else {
        let cookie = api.download_cookie();
        let info = helper(
            &app,
            json!({"operation":"prepare","id":id,"cookie":cookie}),
            Duration::from_secs(240),
        )
        .await?;
        if account_cookie(&cookie) != account_cookie(&api.download_cookie()) {
            return Err("网易云账号已切换，请重新下载".into());
        }
        let fallback = if info["playback"].is_null() {
            let mut song = info["song"].clone();
            song["artists"] = info["artists"].clone();
            crate::qq::qq_request(
                app.clone(),
                qq,
                "download_match".into(),
                Some(json!({"song":song})),
            )
            .await?
        } else {
            Value::Null
        };
        if account_cookie(&cookie) != account_cookie(&api.download_cookie()) {
            return Err("网易云账号已切换，请重新下载".into());
        }
        (info, fallback)
    };
    let folder = directory(&app)?;
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|_| "无法创建下载目录")?;
    let scratch = Scratch(folder.join(format!(".ting-{}", uuid::Uuid::new_v4())));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&scratch.0)
        .map_err(|_| "无法创建下载临时目录")?;
    helper(&app, json!({"id":id,"source":source,"info":info,"fallback":fallback,"out":folder,"scratch":scratch.0}), Duration::from_secs(660)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_comparison_ignores_non_authentication_cookie_changes() {
        assert_eq!(
            account_cookie("os=pc; MUSIC_U=test; csrf=old"),
            account_cookie("csrf=new; MUSIC_U=test")
        );
        assert_ne!(account_cookie("MUSIC_U=test"), account_cookie("os=pc"));
        assert_ne!(
            account_cookie("MUSIC_U=test"),
            account_cookie("MUSIC_U=other")
        );
    }

    #[test]
    fn scratch_cleanup_removes_partial_downloads() {
        let path = std::env::temp_dir().join(format!("ting-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("partial.flac"), b"partial").unwrap();
        drop(Scratch(path.clone()));
        assert!(!path.exists());
    }
}

#[tauri::command]
pub async fn open_download_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = directory(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "无法创建下载目录")?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        command.arg(dir).spawn().map_err(|_| "无法打开下载目录")?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = dir;
        Err("此平台暂不支持打开目录".into())
    }
}
