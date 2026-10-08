//! Backend-only secrets in the platform credential store (Keychain, Credential
//! Manager, Secret Service, Android Keystore). Values never reach the WebView.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
const SERVICE: &str = "com.ting.music.demo";

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn load(account: &str) -> Option<String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    generic_password(PasswordOptions::new_generic_password(SERVICE, account))
        .ok()
        .and_then(|v| String::from_utf8(v).ok())
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn save(account: &str, value: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, account, value.as_bytes())
        .map_err(|_| "无法把密码保存到系统钥匙串".into())
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn remove(account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, account) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == -25300 => Ok(()),
        Err(_) => Err("无法从系统钥匙串清除密码".into()),
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn load(account: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, account)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn save(account: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, account)
        .and_then(|entry| entry.set_password(value))
        .map_err(|_| "无法把密码保存到系统凭据管理器".into())
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub fn remove(account: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, account).map_err(|_| "无法清除已保存的密码")?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法清除已保存的密码".into()),
    }
}

#[cfg(target_os = "android")]
pub fn load(account: &str) -> Option<String> {
    crate::android_credentials::load(account)
}
#[cfg(target_os = "android")]
pub fn save(account: &str, value: &str) -> Result<(), String> {
    crate::android_credentials::save(account, value).map_err(|_| "无法把密码保存到安全存储".into())
}
#[cfg(target_os = "android")]
pub fn remove(account: &str) -> Result<(), String> {
    crate::android_credentials::remove(account)
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
pub fn load(_: &str) -> Option<String> {
    None
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
pub fn save(_: &str, _: &str) -> Result<(), String> {
    Err("此平台没有可用的安全凭据存储".into())
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
pub fn remove(_: &str) -> Result<(), String> {
    Ok(())
}
