use crate::netease::Api;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Manager;

#[derive(Default)]
pub struct Downloads(Arc<AtomicBool>);
pub(crate) struct Guard(Arc<AtomicBool>);
#[cfg(test)]
impl Guard {
    pub(crate) fn for_test() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
pub(crate) struct Scratch(pub(crate) PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn ensure_writable(folder: &PathBuf) -> std::io::Result<()> {
    std::fs::create_dir_all(folder)?;
    let probe = folder.join(format!(".ting-write-{}", uuid::Uuid::new_v4()));
    std::fs::write(&probe, b"ok")?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    {
        return Ok(app
            .path()
            .document_dir()
            .map_err(|_| "找不到下载目录")?
            .join("Ting"));
    }
    #[cfg(target_os = "android")]
    {
        let path = app
            .path()
            .download_dir()
            .map_err(|_| "下载目录不可用")?
            .join("Ting");
        ensure_writable(&path).map_err(|_| "无法写入下载目录")?;
        Ok(path)
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        // Prefer the user's Downloads/Ting folder on every desktop platform.
        // Fall back to app data only when the preferred folder is not writable.
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = app.path().download_dir() {
            candidates.push(dir.join("Ting"));
        }
        if let Ok(dir) = app.path().app_local_data_dir() {
            candidates.push(dir.join("downloads"));
        }
        if let Ok(dir) = app.path().app_data_dir() {
            candidates.push(dir.join("downloads"));
        }
        let mut last_failure: Option<(PathBuf, std::io::Error)> = None;
        for folder in candidates {
            match ensure_writable(&folder) {
                Ok(()) => return Ok(folder),
                Err(err) => last_failure = Some((folder, err)),
            }
        }
        if let Some((path, err)) = last_failure {
            let detail = match err.raw_os_error() {
                Some(code) => format!("{:?}/os={code}", err.kind()),
                None => format!("{:?}: {err}", err.kind()),
            };
            return Err(format!(
                "下载文件无法写入，请检查磁盘空间和目录权限（{}: {detail}）",
                path.display()
            ));
        }
        Err("下载文件无法写入，请检查磁盘空间和目录权限".into())
    }
}
fn account_cookie(cookie: &str) -> Option<&str> {
    cookie
        .split(';')
        .filter_map(|value| value.trim().split_once('='))
        .find_map(|(key, value)| (key == "MUSIC_U").then_some(value))
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
    let guard = Guard(state.0.clone());
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
        let info = tokio::time::timeout(
            Duration::from_secs(240),
            crate::download_engine::prepare(id, &cookie),
        )
        .await
        .map_err(|_| "音源解析超时")??;
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
    // On Windows, keep scratch under TEMP so antivirus/CFA/indexing on the final
    // downloads folder cannot block mid-write of the partial audio file.
    #[cfg(target_os = "windows")]
    let scratch =
        Scratch(std::env::temp_dir().join(format!("ting-scratch-{}", uuid::Uuid::new_v4())));
    #[cfg(not(target_os = "windows"))]
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
    crate::download_engine::run(id, source.into(), info, fallback, folder, scratch, guard).await
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

    #[tokio::test]
    #[ignore = "live current-account NetEase download into disposable test directory; never prints credentials or URLs"]
    async fn live_netease_native_download() {
        let api = Api::persistent().unwrap();
        let songs = api.search("ChiliChill", 0).await.unwrap();
        let song = songs.songs.first().expect("search result required");
        let info = crate::download_engine::prepare(song.id, &api.download_cookie())
            .await
            .unwrap();
        assert!(
            !info["playback"].is_null(),
            "full-length account source required"
        );
        let folder =
            Scratch(std::env::temp_dir().join(format!("ting-live-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir(&folder.0).unwrap();
        let scratch = Scratch(folder.0.join("scratch"));
        std::fs::create_dir(&scratch.0).unwrap();
        let busy = Arc::new(AtomicBool::new(true));
        let result = crate::download_engine::run(
            song.id,
            "netease".into(),
            info,
            Value::Null,
            folder.0.clone(),
            scratch,
            Guard(busy.clone()),
        )
        .await
        .unwrap();
        assert!(!busy.load(Ordering::Acquire));
        let path = PathBuf::from(result["path"].as_str().unwrap());
        assert!(path.is_file());
        assert!(result["bytes"].as_u64().unwrap() > 100_000);
        let metadata = std::fs::read_to_string(path.with_extension("json")).unwrap();
        let metadata: Value = serde_json::from_str(&metadata).unwrap();
        assert_eq!(metadata["origin"]["id"], song.id);
        assert_eq!(metadata["audio"]["platform"], "netease");
        assert!(metadata.get("url").is_none());
        assert!(!folder.0.join("scratch").exists());
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
    #[cfg(target_os = "android")]
    {
        let _ = dir;
        crate::android_platform::open_downloads().await
    }
    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        let _ = dir;
        Err("此平台暂不支持打开目录".into())
    }
}
