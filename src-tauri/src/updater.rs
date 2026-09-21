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
    async fn stage(app: &AppHandle) -> Result<Option<String>, tauri_plugin_updater::Error> {
        let updater = app.updater_builder().timeout(CHECK_TIMEOUT).build()?;
        let Some(mut update) = updater.check().await? else {
            return Ok(None);
        };
        update.timeout = Some(DOWNLOAD_TIMEOUT);
        // download() verifies the package against the bundled public key.
        let bytes = update.download(|_, _| {}, || {}).await?;
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
        if downloads.busy() {
            return Err("歌曲下载完成后再重启更新".into());
        }
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
        app.restart()
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
