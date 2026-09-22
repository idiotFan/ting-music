//! Desktop self-update: a signed package is staged silently at launch and is
//! only installed after the user asks to restart.
#[cfg(desktop)]
mod desktop {
    use crate::download::Downloads;
    use std::{sync::Mutex, time::Duration};
    use tauri::{AppHandle, Manager};
    use tauri_plugin_updater::{Update, UpdaterExt};
    use tokio::sync::watch;

    const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
    const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);
    /// The plugin buffers the whole response before the signature can reject it,
    /// so a staged package that grows past this is abandoned rather than allowed
    /// to grow the process without bound.
    const MAX_PACKAGE_BYTES: u64 = 300 * 1024 * 1024;

    #[derive(Clone, PartialEq)]
    enum Phase {
        Checking,
        Idle,
        Ready(String),
    }
    pub struct Updates {
        phase: watch::Sender<Phase>,
        staged: Mutex<Option<(Update, Vec<u8>)>>,
    }
    impl Default for Updates {
        fn default() -> Self {
            Self {
                phase: watch::channel(Phase::Checking).0,
                staged: Mutex::new(None),
            }
        }
    }
    /// Development builds never replace themselves, a translocated macOS app is
    /// read-only, and on Linux only AppImage and deb installs can be updated.
    fn supported() -> bool {
        if cfg!(debug_assertions) {
            return false;
        }
        let exe = std::env::current_exe().unwrap_or_default();
        if cfg!(target_os = "macos") {
            return !exe
                .components()
                .any(|c| c.as_os_str() == "AppTranslocation");
        }
        if cfg!(target_os = "linux") {
            return std::env::var_os("APPIMAGE").is_some() || exe.starts_with("/usr");
        }
        true
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
    async fn stage(app: &AppHandle) -> Result<Option<String>, tauri_plugin_updater::Error> {
        let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build()?;
        let Some(mut update) = updater.check().await? else {
            return Ok(None);
        };
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        // download() verifies the package against the bundled public key, but only
        // after the whole body is in memory; dropping the future stops the read.
        let (progress, watcher) = watch::channel(0u64);
        let mut total = 0u64;
        let bytes = tokio::select! {
            bytes = update.download(
                |chunk, _| {
                    total = total.saturating_add(chunk as u64);
                    let _ = progress.send(total);
                },
                || {},
            ) => bytes?,
            () = oversize(watcher) => return Ok(None),
        };
        let version = update.version.clone();
        if let Ok(mut staged) = app.state::<Updates>().staged.lock() {
            *staged = Some((update, bytes));
            return Ok(Some(version));
        }
        Ok(None)
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
            update.install(&bytes).map_err(|_| (update, bytes))
        })
        .await
        .map_err(|_| "更新安装失败，请稍后重试")?;
        if let Err(staged) = installed {
            if let Ok(mut slot) = state.staged.lock() {
                *slot = Some(staged);
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
pub async fn update_install() -> Result<(), String> {
    Err("此平台通过安装包更新".into())
}
