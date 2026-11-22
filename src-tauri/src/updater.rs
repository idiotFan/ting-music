//! Desktop self-update: a signed package is staged silently at launch and is
//! only installed after the user asks to restart. Manual check & download
//! commands in Settings -> About share the exact same staged state and report
//! actionable status/progress instead of failing silently.
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub status: &'static str,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub message: Option<String>,
}

#[cfg(desktop)]
mod desktop {
    use super::UpdateCheckResult;
    use crate::download::Downloads;
    use serde::Serialize;
    use std::{sync::Mutex, time::Duration};
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};
    use tokio::sync::watch;

    const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
    /// The plugin buffers the whole response before the signature can reject it,
    /// so a staged package that grows past this is abandoned rather than allowed
    /// to grow the process without bound.
    const MAX_PACKAGE_BYTES: u64 = 300 * 1024 * 1024;
    const PROGRESS_STEP_BYTES: u64 = 64 * 1024;

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UpdateProgress {
        downloaded: u64,
        total: Option<u64>,
    }

    #[derive(Clone, PartialEq)]
    enum Phase {
        Checking,
        Idle,
        Ready(String),
    }
    pub struct Updates {
        phase: watch::Sender<Phase>,
        pending: Mutex<Option<Update>>,
        staged: Mutex<Option<(Update, Vec<u8>)>>,
    }
    impl Default for Updates {
        fn default() -> Self {
            Self {
                phase: watch::channel(Phase::Checking).0,
                pending: Mutex::new(None),
                staged: Mutex::new(None),
            }
        }
    }
    /// Development builds never replace themselves, a translocated macOS app is
    /// read-only, and on Linux only AppImage and deb installs can be updated.
    fn unsupported_reason() -> Option<&'static str> {
        if cfg!(debug_assertions) {
            return Some("开发构建不支持应用内自动更新");
        }
        let exe = std::env::current_exe().unwrap_or_default();
        if cfg!(target_os = "macos")
            && exe
                .components()
                .any(|c| c.as_os_str() == "AppTranslocation")
        {
            return Some("应用正运行在系统临时只读目录，请先拖入「应用程序」文件夹后再检查更新");
        }
        if cfg!(target_os = "linux")
            && std::env::var_os("APPIMAGE").is_none()
            && !exe.starts_with("/usr")
        {
            return Some("当前运行方式不支持应用内更新，请前往 GitHub Releases 下载安装包");
        }
        None
    }
    fn supported() -> bool {
        unsupported_reason().is_none()
    }
    fn friendly_error(err: &tauri_plugin_updater::Error) -> String {
        let raw = err.to_string();
        let lower = raw.to_ascii_lowercase();
        if lower.contains("timed out") || lower.contains("timeout") {
            return "连接更新服务器超时，请检查网络或代理设置后重试".into();
        }
        if lower.contains("signature") || lower.contains("pubkey") {
            return "更新包签名校验失败，已中止安装".into();
        }
        if lower.contains("dns")
            || lower.contains("connect")
            || lower.contains("network")
            || lower.contains("sendrequest")
            || lower.contains("error sending request")
        {
            return "无法连接到 GitHub 更新服务器，请检查网络或代理设置".into();
        }
        format!("更新操作失败：{raw}")
    }
    /// Resolves once the running total passes the cap, and never when the
    /// download finishes first and drops the sender.
    async fn oversize(mut received: watch::Receiver<u64>) {
        if received
            .wait_for(|bytes| *bytes > MAX_PACKAGE_BYTES)
            .await
            .is_err()
        {
            std::future::pending::<()>().await;
        }
    }
    async fn download_and_stage(
        app: &AppHandle,
        mut update: Update,
        emit_progress: bool,
    ) -> Result<Option<String>, String> {
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        // download() verifies the package against the bundled public key, but only
        // after the whole body is in memory; dropping the future stops the read.
        let (progress, watcher) = watch::channel(0u64);
        let mut total_bytes = 0u64;
        let mut last_emitted = 0u64;
        let app_for_emit = app.clone();
        let bytes = tokio::select! {
            bytes = update.download(
                move |chunk, content_length| {
                    total_bytes = total_bytes.saturating_add(chunk as u64);
                    let _ = progress.send(total_bytes);
                    if emit_progress
                        && (total_bytes.saturating_sub(last_emitted) >= PROGRESS_STEP_BYTES
                            || content_length.is_some_and(|len| total_bytes >= len))
                    {
                        last_emitted = total_bytes;
                        let _ = app_for_emit.emit(
                            "ting://update-progress",
                            UpdateProgress {
                                downloaded: total_bytes,
                                total: content_length,
                            },
                        );
                    }
                },
                || {},
            ) => bytes.map_err(|e| friendly_error(&e))?,
            () = oversize(watcher) => return Err("更新包体积异常，已取消下载".into()),
        };
        let version = update.version.clone();
        let state = app.state::<Updates>();
        if let Ok(mut staged) = state.staged.lock() {
            *staged = Some((update, bytes));
            state.phase.send_replace(Phase::Ready(version.clone()));
            return Ok(Some(version));
        }
        Ok(None)
    }
    async fn stage(app: &AppHandle) -> Result<Option<String>, String> {
        let updater = app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|e| friendly_error(&e))?;
        let Some(update) = updater.check().await.map_err(|e| friendly_error(&e))? else {
            return Ok(None);
        };
        download_and_stage(app, update, false).await
    }
    pub fn start(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Failures stay silent: being offline must never disturb playback.
            let phase = match supported() {
                true => stage(&app).await.ok().flatten(),
                false => None,
            }
            .map_or(Phase::Idle, Phase::Ready);
            app.state::<Updates>().phase.send_replace(phase);
        });
    }
    /// Resolves once the launch check settles: the staged version, or nothing.
    #[tauri::command]
    pub async fn update_ready(state: tauri::State<'_, Updates>) -> Result<Option<String>, String> {
        let mut phase = state.phase.subscribe();
        let settled = phase
            .wait_for(|phase| *phase != Phase::Checking)
            .await
            .map_err(|_| "更新状态不可用")?;
        Ok(match &*settled {
            Phase::Ready(version) => Some(version.clone()),
            _ => None,
        })
    }
    /// Explicit manual check triggered from Settings -> About. Reports exact
    /// status or error reason instead of swallowing failures silently.
    #[tauri::command]
    pub async fn update_check(
        app: AppHandle,
        state: tauri::State<'_, Updates>,
    ) -> Result<UpdateCheckResult, String> {
        if let Ok(staged) = state.staged.lock() {
            if let Some((update, _)) = staged.as_ref() {
                return Ok(UpdateCheckResult {
                    status: "ready",
                    version: Some(update.version.clone()),
                    notes: update.body.clone(),
                    message: Some("新版本已下载完成，点击重启即可安装".into()),
                });
            }
        }
        if let Some(reason) = unsupported_reason() {
            return Ok(UpdateCheckResult {
                status: "unsupported",
                version: None,
                notes: None,
                message: Some(reason.into()),
            });
        }
        let updater = match app.updater_builder().timeout(CHECK_TIMEOUT).build() {
            Ok(u) => u,
            Err(e) => {
                return Ok(UpdateCheckResult {
                    status: "error",
                    version: None,
                    notes: None,
                    message: Some(friendly_error(&e)),
                });
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let notes = update.body.clone();
                if let Ok(mut pending) = state.pending.lock() {
                    *pending = Some(update);
                }
                Ok(UpdateCheckResult {
                    status: "available",
                    version: Some(version),
                    notes,
                    message: None,
                })
            }
            Ok(None) => {
                if let Ok(mut pending) = state.pending.lock() {
                    *pending = None;
                }
                Ok(UpdateCheckResult {
                    status: "up_to_date",
                    version: None,
                    notes: None,
                    message: Some("当前已是最新版本".into()),
                })
            }
            Err(e) => Ok(UpdateCheckResult {
                status: "error",
                version: None,
                notes: None,
                message: Some(friendly_error(&e)),
            }),
        }
    }
    /// Downloads and verifies a checked update, emitting `ting://update-progress`
    /// events while streaming, then stages it for `update_install`.
    #[tauri::command]
    pub async fn update_download(
        app: AppHandle,
        state: tauri::State<'_, Updates>,
    ) -> Result<String, String> {
        if let Ok(staged) = state.staged.lock() {
            if let Some((update, _)) = staged.as_ref() {
                return Ok(update.version.clone());
            }
        }
        if let Some(reason) = unsupported_reason() {
            return Err(reason.into());
        }
        let cached = state.pending.lock().map_err(|_| "更新状态不可用")?.take();
        let update = match cached {
            Some(u) => u,
            None => {
                let updater = app
                    .updater_builder()
                    .timeout(CHECK_TIMEOUT)
                    .build()
                    .map_err(|e| friendly_error(&e))?;
                updater
                    .check()
                    .await
                    .map_err(|e| friendly_error(&e))?
                    .ok_or_else(|| "当前已是最新版本".to_string())?
            }
        };
        download_and_stage(&app, update, true)
            .await?
            .ok_or_else(|| "更新状态不可用".to_string())
    }
    #[tauri::command]
    pub async fn update_install(
        app: AppHandle,
        state: tauri::State<'_, Updates>,
        downloads: tauri::State<'_, Downloads>,
    ) -> Result<(), String> {
        // The claim is held for the whole install, not just checked once: install()
        // can end the process without unwinding, so a download started in that
        // window would be killed mid-write.
        downloads.begin_install()?;
        match install(state.inner()).await {
            Ok(()) => app.restart(),
            Err(message) => {
                downloads.end_install();
                Err(message)
            }
        }
    }
    /// Consumes the staged package; a failed install puts it back for a retry.
    async fn install(state: &Updates) -> Result<(), String> {
        let (update, bytes) = state
            .staged
            .lock()
            .map_err(|_| "更新状态不可用")?
            .take()
            .ok_or("没有已下载的更新")?;
        // Windows exits inside install() once the installer has been launched.
        let installed = tauri::async_runtime::spawn_blocking(move || {
            update
                .install(&bytes)
                .map_err(|_| Box::new((update, bytes)))
        })
        .await
        .map_err(|_| "更新安装失败，请稍后重试")?;
        if let Err(staged) = installed {
            if let Ok(mut slot) = state.staged.lock() {
                *slot = Some(*staged);
            }
            return Err("更新安装失败，请确认应用所在位置可写，或手动下载新版本".into());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn oversize_fires_past_the_cap_and_never_on_a_finished_download() {
            let (progress, watcher) = watch::channel(0u64);
            progress.send(MAX_PACKAGE_BYTES).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(50), oversize(watcher))
                    .await
                    .is_err(),
                "a package exactly at the cap is still accepted"
            );
            let (progress, watcher) = watch::channel(0u64);
            progress.send(MAX_PACKAGE_BYTES + 1).unwrap();
            tokio::time::timeout(Duration::from_millis(50), oversize(watcher))
                .await
                .expect("a package past the cap aborts the download");
            // A finished download drops the sender; the abort must never win then.
            let (progress, watcher) = watch::channel(0u64);
            drop(progress);
            assert!(
                tokio::time::timeout(Duration::from_millis(50), oversize(watcher))
                    .await
                    .is_err()
            );
        }
    }
}
#[cfg(desktop)]
pub use desktop::*;

#[cfg(mobile)]
#[tauri::command]
pub async fn update_ready() -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(mobile)]
#[tauri::command]
pub async fn update_check() -> Result<UpdateCheckResult, String> {
    Ok(UpdateCheckResult {
        status: "unsupported",
        version: None,
        notes: None,
        message: Some("移动端请通过安装包更新".into()),
    })
}
#[cfg(mobile)]
#[tauri::command]
pub async fn update_download() -> Result<String, String> {
    Err("移动端请通过安装包更新".into())
}
#[cfg(mobile)]
#[tauri::command]
pub async fn update_install() -> Result<(), String> {
    Err("此平台通过安装包更新".into())
}
