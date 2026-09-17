use std::path::PathBuf;
use tauri::{path::BaseDirectory, AppHandle, Manager};

/// Release builds only use the bundled interpreter and native Python extensions.
/// Never select an arbitrary Python binary from the process working directory/PATH.
pub fn python(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resolve("python/bin/python3.12", BaseDirectory::Resource)
        .map_err(|_| "内置 Python 运行环境路径不可用")?;
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    for candidate in ["/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12"] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("内置运行环境缺失，请重新安装完整版本的 Ting".into())
}
