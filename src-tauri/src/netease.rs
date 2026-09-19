//! NetEase WEAPI adapter following go-musicfox/netease-music (see THIRD_PARTY_NOTICES.md).
use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use base64::{engine::general_purpose::STANDARD, Engine};
use num_bigint::BigUint;
use reqwest::cookie::{CookieStore, Jar};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MODULUS: &str = "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
fn encrypt(data: &[u8], key: &[u8]) -> String {
    STANDARD.encode(
        cbc::Encryptor::<aes::Aes128>::new_from_slices(key, b"0102030405060708")
            .unwrap()
            .encrypt_padded_vec_mut::<Pkcs7>(data),
    )
}
fn weapi(data: &Value, secret: &[u8]) -> [(String, String); 2] {
    let first = encrypt(data.to_string().as_bytes(), b"0CoJUm6Qyw8W8jud");
    let params = encrypt(first.as_bytes(), secret);
    let reversed: Vec<u8> = secret.iter().rev().copied().collect();
    let n = BigUint::parse_bytes(MODULUS.as_bytes(), 16).unwrap();
    let rsa = BigUint::from_bytes_be(&reversed).modpow(&BigUint::from(65537u32), &n);
    [
        ("params".into(), params),
        (
            "encSecKey".into(),
            format!("{:0>256}", rsa.to_str_radix(16)),
        ),
    ]
}

#[derive(Clone)]
struct Session {
    client: reqwest::Client,
    jar: Arc<Jar>,
}
impl Session {
    fn new(saved: Option<&str>) -> Result<Self, String> {
        let jar = Arc::new(Jar::default());
        let url = reqwest::Url::parse("https://music.163.com/").unwrap();
        let device = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        for cookie in [
            "os=pc; Path=/".to_string(),
            "appver=2.10.13; Path=/".to_string(),
            format!("sDeviceId={}; Path=/", &device[..52]),
        ] {
            jar.add_cookie_str(&cookie, &url);
        }
        if let Some(saved) = saved {
            for cookie in saved.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                jar.add_cookie_str(&format!("{cookie}; Path=/; Secure"), &url);
            }
        }
        let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).connect_timeout(Duration::from_secs(8))
            .cookie_provider(jar.clone()).user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15")
            .build().map_err(|_| "无法初始化网络客户端".to_string())?;
        Ok(Self { client, jar })
    }
    fn cookies(&self) -> String {
        self.jar
            .cookies(&reqwest::Url::parse("https://music.163.com/").unwrap())
            .and_then(|h| h.to_str().ok().map(str::to_owned))
            .unwrap_or_default()
    }
    fn cookie(&self, name: &str) -> String {
        self.cookies()
            .split(';')
            .filter_map(|s| s.trim().split_once('='))
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.to_owned())
            .unwrap_or_default()
    }
}
struct Pending {
    key: String,
    session: Session,
    created: Instant,
}
struct PendingPhone {
    phone: String,
    country: String,
    session: Session,
    created: Instant,
}
#[derive(Default)]
struct LoginState {
    revision: u64,
    phone: Option<PendingPhone>,
    last_sms_send: Option<Instant>,
}
const SMS_COOLDOWN: Duration = Duration::from_secs(60);
const PHONE_LOGIN_TTL: Duration = Duration::from_secs(600);

fn phone_identity(phone: &str, country: &str) -> Result<(String, String), String> {
    let phone = phone.trim();
    let country = country.trim();
    let country = if country.is_empty() { "86" } else { country };
    let country = country.strip_prefix('+').unwrap_or(country);
    if !(1..=3).contains(&country.len())
        || country.starts_with('0')
        || !country.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("请输入有效的国家或地区区号".into());
    }
    if !(6..=14).contains(&phone.len())
        || phone.len() + country.len() > 15
        || !phone.bytes().all(|b| b.is_ascii_digit())
        || (country == "86" && (phone.len() != 11 || !phone.starts_with('1')))
    {
        return Err("请输入有效的手机号码，号码中不要包含区号、空格或符号".into());
    }
    Ok((phone.to_owned(), country.to_owned()))
}
fn validate_login_code(code: &str) -> Result<&str, String> {
    let code = code.trim();
    if !(4..=6).contains(&code.len()) || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err("请输入短信中的 4–6 位数字验证码".into());
    }
    Ok(code)
}
fn phone_login_response(body: Value) -> Result<Value, String> {
    let code = body["code"].as_u64().unwrap_or(0);
    if code == 200 {
        return Ok(body);
    }
    let message = match code {
        400 | 501 => "手机号码无效或账号不存在，请检查后重试",
        502 | 503 => "验证码无效或已过期，请检查后重试",
        405 | 429 | 8810 => "请求过于频繁，请稍后重试",
        415 | 460 | 509 => "需要在网易云音乐官方 App 完成安全验证；也可以使用扫码登录",
        _ => "验证码登录暂不可用，请稍后重试或使用扫码登录",
    };
    // Do not expose upstream diagnostic fields: they may contain the phone or code.
    Err(format!("网易云登录未成功（{code}）：{message}"))
}
pub struct Api {
    active: Mutex<Session>,
    pending: Mutex<Option<Pending>>,
    auth_gate: tokio::sync::Mutex<()>,
    login_state: Mutex<LoginState>,
    persist: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: u64,
    pub name: String,
    pub artist: String,
    pub album: String,
    pub cover: String,
    pub duration: u64,
    pub fee: u64,
}
#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub songs: Vec<Song>,
    pub total: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    pub url: String,
    pub trial: bool,
    pub trial_start: f64,
    pub bitrate: u64,
    pub level: String,
    pub requested_level: String,
    pub format: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub user_id: u64,
    pub nickname: String,
    pub avatar: String,
}
#[derive(Debug, Serialize)]
pub struct QrLogin {
    pub key: String,
    pub url: String,
}
#[derive(Debug, Serialize)]
pub struct QrStatus {
    pub code: u64,
    pub profile: Option<Profile>,
    pub warning: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: u64,
    pub name: String,
    pub cover: String,
    pub track_count: u64,
    pub creator: String,
    pub owned: bool,
}
#[derive(Debug, Serialize)]
pub struct PlaylistPage {
    pub playlists: Vec<Playlist>,
    pub more: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistTracks {
    pub songs: Vec<Song>,
    pub total: usize,
    pub next_offset: usize,
    pub name: String,
}
fn string(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}
fn https_url(s: &str) -> String {
    s.replacen("http://", "https://", 1)
}
fn songs_from(values: &Value) -> Vec<Song> {
    values
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|s| {
                    Some(Song {
                        id: s["id"].as_u64()?,
                        name: string(&s["name"]),
                        artist: s["ar"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x["name"].as_str())
                                    .collect::<Vec<_>>()
                                    .join(" / ")
                            })
                            .unwrap_or_default(),
                        album: string(&s["al"]["name"]),
                        cover: https_url(&string(&s["al"]["picUrl"])),
                        duration: s["dt"].as_u64().unwrap_or(0),
                        fee: s["fee"].as_u64().unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
fn check(body: Value) -> Result<Value, String> {
    let code = body["code"].as_u64().unwrap_or(0);
    if code == 200 {
        Ok(body)
    } else {
        // Upstream message/debug fields can echo request credentials. Only expose a
        // numeric code and our own text across IPC.
        let message = match code {
            301 | 401 => "登录已失效，请重新登录",
            405 | 429 | 8810 => "请求过于频繁，请稍后重试",
            _ => "请稍后重试",
        };
        Err(format!("网易云请求未成功（{code}）：{message}"))
    }
}
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux"
))]
const KEYCHAIN_SERVICE: &str = "com.ting.music.demo";
const KEYCHAIN_ACCOUNT: &str = "netease-session";
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn stored_session() -> Option<String> {
    use security_framework::passwords::{generic_password, PasswordOptions};
    generic_password(PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT,
    ))
    .ok()
    .and_then(|v| String::from_utf8(v).ok())
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn stored_session() -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
fn stored_session() -> Option<String> {
    None
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn store_session(cookie: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT,
        cookie.as_bytes(),
    )
    .map_err(|_| "已登录，但钥匙串保存失败；本次会话仍可使用".into())
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn store_session(cookie: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|_| "已登录，但凭据保存失败；本次会话仍可使用".to_string())?;
    entry
        .set_password(cookie)
        .map_err(|_| "已登录，但凭据保存失败；本次会话仍可使用".into())
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
fn store_session(_: &str) -> Result<(), String> {
    Err("此平台暂仅保留本次登录会话".into())
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn delete_session() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    {
        Ok(()) => Ok(()),
        Err(e) if e.code() == -25300 => Ok(()),
        Err(_) => Err("无法清除钥匙串登录记录，请重试退出".into()),
    }
}
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn delete_session() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|_| "无法清除登录凭据，请重试退出".to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法清除登录凭据，请重试退出".into()),
    }
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "windows",
    target_os = "linux",
    target_os = "android"
)))]
fn delete_session() -> Result<(), String> {
    Ok(())
}
#[cfg(target_os = "android")]
fn stored_session() -> Option<String> {
    crate::android_credentials::load(KEYCHAIN_ACCOUNT)
}
#[cfg(target_os = "android")]
fn store_session(cookie: &str) -> Result<(), String> {
    crate::android_credentials::save(KEYCHAIN_ACCOUNT, cookie)
}
#[cfg(target_os = "android")]
fn delete_session() -> Result<(), String> {
    crate::android_credentials::remove(KEYCHAIN_ACCOUNT)
}

impl Api {
    pub fn download_cookie(&self) -> String {
        self.session().cookies()
    }
    pub fn new() -> Result<Self, String> {
        Self::create(false)
    }
    pub fn persistent() -> Result<Self, String> {
        Self::create(true)
    }
    fn create(persist: bool) -> Result<Self, String> {
        let saved = if persist { stored_session() } else { None };
        Ok(Self {
            active: Mutex::new(Session::new(saved.as_deref())?),
            pending: Mutex::new(None),
            auth_gate: tokio::sync::Mutex::new(()),
            login_state: Mutex::new(LoginState::default()),
            persist,
        })
    }
    fn session(&self) -> Session {
        self.active.lock().unwrap().clone()
    }
    async fn raw(session: &Session, path: &str, mut data: Value) -> Result<Value, String> {
        data["csrf_token"] = json!(session.cookie("__csrf"));
        let random = uuid::Uuid::new_v4().simple().to_string();
        let form = weapi(&data, &random.as_bytes()[..16]);
        let response = session
            .client
            .post(format!("https://music.163.com/weapi/{path}"))
            .header("Referer", "https://music.163.com/")
            .form(&form)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "请求超时，请稍后重试".to_string()
                } else {
                    "无法连接网易云，请检查网络连接".to_string()
                }
            })?;
        if !response.status().is_success() {
            return Err(format!("网易云服务暂不可用（HTTP {}）", response.status()));
        }
        response
            .json()
            .await
            .map_err(|_| "网易云返回了无法识别的数据，请稍后重试".into())
    }
    async fn request(&self, path: &str, data: Value) -> Result<Value, String> {
        check(Self::raw(&self.session(), path, data).await?)
    }
    async fn profile_for(session: &Session) -> Result<Option<Profile>, String> {
        let body = Self::raw(session, "nuser/account/get", json!({})).await?;
        if body["code"] == 301 || body["code"] == 401 {
            return Ok(None);
        }
        let body = check(body)?;
        let p = &body["profile"];
        Ok(p["userId"].as_u64().filter(|id| *id > 0).map(|id| Profile {
            user_id: id,
            nickname: string(&p["nickname"]),
            avatar: https_url(&string(&p["avatarUrl"])),
        }))
    }
    pub async fn account(&self) -> Result<Option<Profile>, String> {
        Self::profile_for(&self.session()).await
    }
    fn cancel_pending(&self) -> u64 {
        let mut state = self.login_state.lock().unwrap();
        state.revision = state.revision.wrapping_add(1);
        state.phone = None;
        *self.pending.lock().unwrap() = None;
        state.revision
    }
    fn ensure_login_revision(&self, revision: u64) -> Result<(), String> {
        if self.login_state.lock().unwrap().revision != revision {
            return Err("登录已取消，请重新开始".into());
        }
        Ok(())
    }
    fn finish_login(
        &self,
        revision: u64,
        session: Session,
        profile: Profile,
    ) -> Result<QrStatus, String> {
        let mut state = self.login_state.lock().unwrap();
        if state.revision != revision {
            return Err("登录已取消，请重新开始".into());
        }
        // The short keychain write and in-memory commit share the cancellation
        // lock. A canceled network request must never resurrect a saved session.
        let warning = if self.persist {
            store_session(&session.cookies()).err()
        } else {
            None
        };
        *self.active.lock().unwrap() = session;
        state.phone = None;
        *self.pending.lock().unwrap() = None;
        Ok(QrStatus {
            code: 803,
            profile: Some(profile),
            warning,
        })
    }
    pub async fn send_login_code(&self, phone: &str, country: &str) -> Result<(), String> {
        let (phone, country) = phone_identity(phone, country)?;
        let revision = self.login_state.lock().unwrap().revision;
        let _gate = self.auth_gate.lock().await;
        self.ensure_login_revision(revision)?;
        let session = Session::new(None)?;
        let revision = {
            let mut state = self.login_state.lock().unwrap();
            if state.revision != revision {
                return Err("登录已取消，请重新开始".into());
            }
            if let Some(last) = state.last_sms_send {
                let elapsed = last.elapsed();
                if elapsed < SMS_COOLDOWN {
                    let remaining = (SMS_COOLDOWN - elapsed).as_secs() + 1;
                    return Err(format!("请等待 {remaining} 秒后再获取验证码"));
                }
            }
            let now = Instant::now();
            state.last_sms_send = Some(now);
            state.revision = state.revision.wrapping_add(1);
            state.phone = Some(PendingPhone {
                phone: phone.clone(),
                country: country.clone(),
                session: session.clone(),
                created: now,
            });
            *self.pending.lock().unwrap() = None;
            state.revision
        };
        // Upstream request definitions (WEAPI rewrites /api/ to /weapi/):
        // https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/captcha_sent.js
        // https://github.com/go-musicfox/netease-music/blob/master/service/captcha_sent_service.go
        let body = Self::raw(
            &session,
            "sms/captcha/sent",
            json!({"cellphone":phone,"ctcode":country,"secrete":"music_middleuser_pclogin"}),
        )
        .await?;
        self.ensure_login_revision(revision)?;
        phone_login_response(body)?;
        Ok(())
    }
    pub async fn login_phone(
        &self,
        phone: &str,
        country: &str,
        code: &str,
    ) -> Result<QrStatus, String> {
        let (phone, country) = phone_identity(phone, country)?;
        let code = validate_login_code(code)?;
        let revision = self.login_state.lock().unwrap().revision;
        let _gate = self.auth_gate.lock().await;
        let session = {
            let state = self.login_state.lock().unwrap();
            if state.revision != revision {
                return Err("登录已取消，请重新开始".into());
            }
            let pending = state.phone.as_ref().ok_or("请先获取短信验证码")?;
            if pending.phone != phone || pending.country != country {
                return Err("手机号码已变更，请为当前号码重新获取验证码".into());
            }
            if pending.created.elapsed() >= PHONE_LOGIN_TTL {
                return Err("验证码登录已过期，请重新获取验证码".into());
            }
            pending.session.clone()
        };
        // https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/login_cellphone.js
        let body = Self::raw(
            &session,
            "w/login/cellphone",
            json!({"type":"1","https":"true","phone":phone,"countrycode":country,
                "captcha":code,"remember":"true","secureCaptcha":""}),
        )
        .await?;
        self.ensure_login_revision(revision)?;
        phone_login_response(body)?;
        let profile = Self::profile_for(&session)
            .await?
            .ok_or("验证码已确认，但未能取得账号信息，请重试")?;
        self.finish_login(revision, session, profile)
    }
    pub async fn start_login(&self) -> Result<QrLogin, String> {
        let revision = self.cancel_pending();
        let _gate = self.auth_gate.lock().await;
        self.ensure_login_revision(revision)?;
        let session = Session::new(None)?;
        let body = check(
            Self::raw(
                &session,
                "login/qrcode/unikey",
                json!({"type":1,"noCheckToken":true}),
            )
            .await?,
        )?;
        let key = body["unikey"]
            .as_str()
            .or_else(|| body["data"]["unikey"].as_str())
            .filter(|s| !s.is_empty())
            .ok_or("网易云没有返回登录二维码，请重试")?
            .to_owned();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let chain = format!("v1_{}_web_login_{stamp}", session.cookie("sDeviceId"));
        let mut url = reqwest::Url::parse("http://music.163.com/login").unwrap();
        url.query_pairs_mut()
            .append_pair("codekey", &key)
            .append_pair("chainId", &chain);
        {
            let state = self.login_state.lock().unwrap();
            if state.revision != revision {
                return Err("登录已取消，请重新开始".into());
            }
            *self.pending.lock().unwrap() = Some(Pending {
                key: key.clone(),
                session,
                created: Instant::now(),
            });
        }
        Ok(QrLogin {
            key,
            url: url.to_string(),
        })
    }
    pub async fn cancel_login(&self) -> Result<(), String> {
        // Invalidate in-flight requests immediately instead of waiting behind them.
        self.cancel_pending();
        Ok(())
    }
    pub async fn check_login(&self, key: &str) -> Result<QrStatus, String> {
        let revision = self.login_state.lock().unwrap().revision;
        let _gate = self.auth_gate.lock().await;
        self.ensure_login_revision(revision)?;
        let session = {
            let pending = self.pending.lock().unwrap();
            let p = pending
                .as_ref()
                .filter(|p| p.key == key)
                .ok_or("二维码已取消，请重新生成")?;
            if p.created.elapsed() > Duration::from_secs(180) {
                return Ok(QrStatus {
                    code: 800,
                    profile: None,
                    warning: None,
                });
            }
            p.session.clone()
        };
        let body = Self::raw(
            &session,
            "login/qrcode/client/login",
            json!({"type":1,"key":key,"noCheckToken":true}),
        )
        .await?;
        self.ensure_login_revision(revision)?;
        let code = body["code"].as_u64().unwrap_or(0);
        if ![800, 801, 802, 803].contains(&code) {
            return Err(format!("登录状态异常（{code}），请刷新二维码"));
        }
        if code == 803 {
            let profile = Self::profile_for(&session)
                .await?
                .ok_or("扫码已确认，但暂未取得账号信息，请重试")?;
            return self.finish_login(revision, session, profile);
        } else if code == 800 {
            let state = self.login_state.lock().unwrap();
            if state.revision == revision {
                *self.pending.lock().unwrap() = None;
            }
        }
        Ok(QrStatus {
            code,
            profile: None,
            warning: None,
        })
    }
    pub async fn logout(&self) -> Result<(), String> {
        self.cancel_pending();
        let _gate = self.auth_gate.lock().await;
        if self.persist {
            tokio::task::spawn_blocking(delete_session)
                .await
                .map_err(|_| "清除登录状态失败")??;
        }
        *self.active.lock().unwrap() = Session::new(None)?;
        *self.pending.lock().unwrap() = None;
        Ok(())
    }
    pub async fn search(&self, query: &str, offset: u32) -> Result<SearchResult, String> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 100 {
            return Err("请输入 1–100 个字符的搜索词".into());
        }
        let body = self
            .request(
                "cloudsearch/pc",
                json!({"s":query,"type":1,"limit":30,"offset":offset.min(10000)}),
            )
            .await?;
        Ok(SearchResult {
            songs: songs_from(&body["result"]["songs"]),
            total: body["result"]["songCount"].as_u64().unwrap_or(0),
        })
    }
    pub async fn playback(&self, id: u64, level: &str) -> Result<Playback, String> {
        if id == 0 {
            return Err("歌曲 ID 无效".into());
        }
        if ![
            "standard", "higher", "exhigh", "lossless", "hires", "jyeffect", "sky", "jymaster",
        ]
        .contains(&level)
        {
            return Err("不支持的音质".into());
        }
        let encode = if ["standard", "higher", "exhigh"].contains(&level) {
            "mp3"
        } else {
            "flac"
        };
        let mut data = json!({"ids":format!("[{id}]"),"level":level,"encodeType":encode});
        if level == "sky" {
            data["immerseType"] = json!("c51")
        }
        let body = self.request("song/enhance/player/url/v1", data).await?;
        let item = &body["data"][0];
        let url = item["url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("当前账号暂不能播放这首歌，请检查版权或会员权限")?;
        let url = https_url(url);
        let parsed = reqwest::Url::parse(&url).map_err(|_| "播放地址无效")?;
        let host = parsed.host_str().unwrap_or("");
        if parsed.scheme() != "https"
            || !(host.ends_with(".music.126.net") || host.ends_with(".music.163.com"))
        {
            return Err("网易云返回了非预期的音频地址".into());
        }
        Ok(Playback {
            url,
            trial: item["freeTrialInfo"].is_object(),
            trial_start: item["freeTrialInfo"]["start"].as_f64().unwrap_or(0.0),
            bitrate: item["br"].as_u64().unwrap_or(0),
            level: item["level"].as_str().unwrap_or("standard").to_owned(),
            requested_level: level.into(),
            format: string(&item["type"]),
        })
    }
    pub async fn lyric(&self, id: u64) -> Result<String, String> {
        let body = self
            .request("song/lyric", json!({"id":id,"lv":-1,"kv":-1,"tv":-1}))
            .await?;
        Ok(string(&body["lrc"]["lyric"]))
    }
    pub async fn my_playlists(&self, offset: u32) -> Result<PlaylistPage, String> {
        let profile = self
            .account()
            .await?
            .ok_or("登录已失效，请先登录网易云账号")?;
        let body = self
            .request(
                "user/playlist",
                json!({"uid":profile.user_id,"limit":100,"offset":offset,"includeVideo":false}),
            )
            .await?;
        let playlists = body["playlist"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|p| {
                        Some(Playlist {
                            id: p["id"].as_u64()?,
                            name: string(&p["name"]),
                            cover: https_url(&string(&p["coverImgUrl"])),
                            track_count: p["trackCount"].as_u64().unwrap_or(0),
                            creator: string(&p["creator"]["nickname"]),
                            owned: p["creator"]["userId"].as_u64() == Some(profile.user_id),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(PlaylistPage {
            playlists,
            more: body["more"].as_bool().unwrap_or(false),
        })
    }
    pub async fn playlist_edit(&self, id: u64, track_id: u64, action: &str) -> Result<(), String> {
        if !["add", "remove", "up", "down", "top", "bottom"].contains(&action)
            || id == 0
            || track_id == 0
        {
            return Err("无效的歌单操作".into());
        }
        // Serialize edits and account switches; never trust a frontend ownership flag.
        let _gate = self.auth_gate.lock().await;
        let profile = self.account().await?.ok_or("请先登录网易云")?;
        let body = self
            .request("v3/playlist/detail", json!({"id":id,"n":100000,"s":0}))
            .await?;
        let playlist = &body["playlist"];
        if playlist["creator"]["userId"].as_u64() != Some(profile.user_id) {
            return Err("只能修改自己创建的歌单".into());
        }
        let values = playlist["trackIds"]
            .as_array()
            .ok_or("无法读取完整歌单，请重试")?;
        let mut ids: Vec<u64> = values
            .iter()
            .map(|v| v["id"].as_u64().ok_or("歌单包含无法识别的歌曲"))
            .collect::<Result<_, _>>()?;
        let op;
        let tracks;
        if action == "add" {
            if ids.contains(&track_id) {
                return Ok(());
            }
            op = "add";
            tracks = vec![track_id, track_id];
        } else if action == "remove" {
            if !ids.contains(&track_id) {
                return Ok(());
            }
            op = "del";
            tracks = vec![track_id, track_id];
        } else {
            // Use all IDs, including unplayable tracks and unloaded pages.
            if playlist["trackCount"].as_u64() != Some(ids.len() as u64) {
                return Err("歌单未完整返回，已取消排序以保护未加载的歌曲".into());
            }
            move_track(&mut ids, track_id, action)?;
            op = "update";
            tracks = ids;
        }
        let result = self.request("playlist/manipulate/tracks", json!({"pid":id,"op":op,"trackIds":serde_json::to_string(&tracks).unwrap(),"imme":true})).await?;
        // Some responses wrap a second status inside the successful HTTP response.
        if let Some(code) = result["body"]["code"].as_u64() {
            if code != 200 {
                return Err(format!("歌单修改未成功（{code}），请刷新后重试"));
            }
        }
        Ok(())
    }
    pub async fn playlist_tracks(&self, id: u64, offset: usize) -> Result<PlaylistTracks, String> {
        let body = self
            .request("v3/playlist/detail", json!({"id":id,"n":100000,"s":0}))
            .await?;
        let ids: Vec<u64> = body["playlist"]["trackIds"]
            .as_array()
            .map(|v| v.iter().filter_map(|x| x["id"].as_u64()).collect())
            .unwrap_or_default();
        let batch: Vec<u64> = ids.iter().skip(offset).take(100).copied().collect();
        let songs = if batch.is_empty() {
            vec![]
        } else {
            let c: Vec<Value> = batch.iter().map(|id| json!({"id":id})).collect();
            let detail=self.request("v3/song/detail",json!({"c":serde_json::to_string(&c).unwrap(),"ids":serde_json::to_string(&batch).unwrap()})).await?;
            let mut songs = songs_from(&detail["songs"]);
            songs.sort_by_key(|s| {
                batch
                    .iter()
                    .position(|id| *id == s.id)
                    .unwrap_or(usize::MAX)
            });
            songs
        };
        Ok(PlaylistTracks {
            songs,
            total: ids.len(),
            next_offset: (offset + batch.len()).min(ids.len()),
            name: string(&body["playlist"]["name"]),
        })
    }
}

fn move_track(ids: &mut Vec<u64>, track_id: u64, action: &str) -> Result<(), String> {
    let from = ids
        .iter()
        .position(|v| *v == track_id)
        .ok_or("歌曲已不在歌单中，请刷新")?;
    let to = match action {
        "up" => from.saturating_sub(1),
        "down" => (from + 1).min(ids.len() - 1),
        "top" => 0,
        "bottom" => ids.len() - 1,
        _ => return Err("无效的排序操作".into()),
    };
    let value = ids.remove(from);
    ids.insert(to, value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockDecryptMut;
    fn pending_phone(created: Instant) -> PendingPhone {
        PendingPhone {
            phone: "13800000000".into(),
            country: "86".into(),
            session: Session::new(None).unwrap(),
            created,
        }
    }
    #[test]
    fn phone_login_validates_numbers_and_codes_without_echoing_them() {
        assert_eq!(
            phone_identity(" 13800000000 ", "+86").unwrap(),
            ("13800000000".into(), "86".into())
        );
        assert!(phone_identity("2025550123", "1").is_ok());
        for (phone, country) in [
            ("13800000000;MUSIC_U=secret", "86"),
            ("1380000000", "86"),
            ("１２３４５６７８９０１", "86"),
            ("+8613800000000", "86"),
            ("13800000000", "++86"),
            ("13800000000", "+"),
            ("13800000000", "086"),
            ("12345678901234", "123"),
        ] {
            let error = phone_identity(phone, country).unwrap_err();
            assert!(!error.contains(phone));
        }
        assert_eq!(validate_login_code(" 1234 ").unwrap(), "1234");
        assert_eq!(validate_login_code("123456").unwrap(), "123456");
        for code in ["123", "1234567", "12 34", "１２３４", "<script>"] {
            assert!(validate_login_code(code).is_err());
        }
        for code in [400, 502, 503, 415, 460, 509, 999] {
            let error = phone_login_response(json!({
                "code":code,"message":"13800000000 otp=123456 MUSIC_U=secret"
            }))
            .unwrap_err();
            assert!(!error.contains("13800000000"));
            assert!(!error.contains("123456"));
            assert!(!error.contains("MUSIC_U"));
        }
    }
    #[tokio::test]
    async fn phone_login_requires_matching_unexpired_pending_session() {
        let api = Api::new().unwrap();
        assert!(api
            .login_phone("13800000000", "86", "1234")
            .await
            .unwrap_err()
            .contains("先获取"));
        api.login_state.lock().unwrap().phone = Some(pending_phone(Instant::now()));
        assert!(api
            .login_phone("13900000000", "86", "1234")
            .await
            .unwrap_err()
            .contains("变更"));
        assert!(api
            .login_phone("13800000000", "1", "1234")
            .await
            .unwrap_err()
            .contains("变更"));
        api.login_state.lock().unwrap().phone =
            Some(pending_phone(Instant::now() - PHONE_LOGIN_TTL));
        assert!(api
            .login_phone("13800000000", "86", "1234")
            .await
            .unwrap_err()
            .contains("过期"));
        assert!(api.session().cookie("MUSIC_U").is_empty());
    }
    #[tokio::test]
    async fn sms_cooldown_survives_cancel_and_number_changes() {
        let api = Api::new().unwrap();
        api.login_state.lock().unwrap().last_sms_send = Some(Instant::now());
        for phone in ["13800000000", "13900000000"] {
            api.cancel_login().await.unwrap();
            let error = api.send_login_code(phone, "86").await.unwrap_err();
            assert!(error.contains("秒后"));
            assert!(!error.contains(phone));
        }
    }
    #[tokio::test]
    async fn canceled_phone_requests_cannot_wait_then_restore_login() {
        let api = Api::new().unwrap();
        api.login_state.lock().unwrap().phone = Some(pending_phone(Instant::now()));
        let gate = api.auth_gate.lock().await;
        let mut request = Box::pin(api.login_phone("13800000000", "86", "1234"));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut request)
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_millis(100), api.cancel_login())
            .await
            .expect("cancel must not wait for the in-flight auth request")
            .unwrap();
        drop(gate);
        assert!(request.await.unwrap_err().contains("取消"));
        assert!(api.login_state.lock().unwrap().phone.is_none());

        let revision = api.login_state.lock().unwrap().revision;
        let authenticated = Session::new(Some("MUSIC_U=synthetic-session")).unwrap();
        api.cancel_login().await.unwrap();
        let result = api.finish_login(
            revision,
            authenticated,
            Profile {
                user_id: 1,
                nickname: "fixture".into(),
                avatar: String::new(),
            },
        );
        assert!(result.unwrap_err().contains("取消"));
        assert!(api.session().cookie("MUSIC_U").is_empty());
    }
    #[tokio::test]
    async fn queued_sms_send_is_discarded_after_cancel() {
        let api = Api::new().unwrap();
        let gate = api.auth_gate.lock().await;
        let mut request = Box::pin(api.send_login_code("13800000000", "86"));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut request)
                .await
                .is_err()
        );
        api.cancel_login().await.unwrap();
        drop(gate);
        assert!(request.await.unwrap_err().contains("取消"));
        assert!(api.login_state.lock().unwrap().last_sms_send.is_none());
    }
    #[test]
    fn upstream_errors_never_forward_request_credentials() {
        let error =
            check(json!({"code":500,"message":"MUSIC_U=synthetic-sensitive-value"})).unwrap_err();
        assert!(error.contains("500"));
        assert!(!error.contains("MUSIC_U"));
        assert!(!error.contains("synthetic-sensitive-value"));
    }
    #[test]
    fn reorder_preserves_entire_playlist() {
        let mut ids: Vec<u64> = (1..=1307).collect();
        move_track(&mut ids, 100, "bottom").unwrap();
        assert_eq!(ids.len(), 1307);
        assert_eq!(ids[99], 101);
        assert_eq!(ids[1306], 100);
        move_track(&mut ids, 1307, "top").unwrap();
        assert_eq!(ids[0], 1307);
        move_track(&mut ids, 1307, "up").unwrap();
        move_track(&mut ids, 1307, "down").unwrap();
        assert_eq!(ids[1], 1307);
        let before = ids.clone();
        assert!(move_track(&mut ids, 9999, "top").is_err());
        assert_eq!(ids, before);
        ids.sort_unstable();
        assert_eq!(ids, (1..=1307).collect::<Vec<_>>());
    }
    #[test]
    fn encryption_roundtrip_and_rsa_size() {
        let value = json!({"s":"旅行的意义","type":1});
        let form = weapi(&value, b"0123456789abcdef");
        let second = STANDARD.decode(&form[0].1).unwrap();
        let first = cbc::Decryptor::<aes::Aes128>::new_from_slices(
            b"0123456789abcdef",
            b"0102030405060708",
        )
        .unwrap()
        .decrypt_padded_vec_mut::<Pkcs7>(&second)
        .unwrap();
        let bytes = STANDARD.decode(first).unwrap();
        let plain = cbc::Decryptor::<aes::Aes128>::new_from_slices(
            b"0CoJUm6Qyw8W8jud",
            b"0102030405060708",
        )
        .unwrap()
        .decrypt_padded_vec_mut::<Pkcs7>(&bytes)
        .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&plain).unwrap(), value);
        assert_eq!(form[1].1.len(), 256);
    }
    #[tokio::test]
    #[ignore = "live public playlist pagination"]
    async fn live_playlist_pagination() {
        let api = Api::new().unwrap();
        let result = api
            .request(
                "cloudsearch/pc",
                json!({"s":"轻音乐","type":1000,"limit":10,"offset":0}),
            )
            .await
            .unwrap();
        let lists = result["result"]["playlists"].as_array().unwrap();
        let list = lists
            .iter()
            .find(|v| v["trackCount"].as_u64().unwrap_or(0) > 100)
            .unwrap_or(&lists[0]);
        let id = list["id"].as_u64().unwrap();
        let first = api.playlist_tracks(id, 0).await.unwrap();
        assert!(!first.songs.is_empty());
        if first.total > first.next_offset {
            let second = api.playlist_tracks(id, first.next_offset).await.unwrap();
            assert!(second.next_offset > first.next_offset);
            assert!(second
                .songs
                .iter()
                .all(|s| !first.songs.iter().any(|a| a.id == s.id)));
        }
        println!(
            "Public playlist tracks and pagination verified: total {}",
            first.total
        );
    }
    #[tokio::test]
    async fn rejects_invalid_quality_and_canceled_login() {
        let api = Api::new().unwrap();
        assert!(api
            .playback(1, "unknown")
            .await
            .unwrap_err()
            .contains("音质"));
        assert!(api
            .check_login("canceled")
            .await
            .unwrap_err()
            .contains("取消"));
        assert!(api.search("", 0).await.is_err());
    }
    #[tokio::test]
    #[ignore = "live QR challenge; does not log in or persist credentials"]
    async fn live_qr_and_quality() {
        let api = Api::new().unwrap();
        assert!(api.account().await.unwrap().is_none());
        let qr = api.start_login().await.unwrap();
        let parsed = reqwest::Url::parse(&qr.url).unwrap();
        assert_eq!(parsed.host_str(), Some("music.163.com"));
        assert!(parsed
            .query_pairs()
            .any(|(k, v)| k == "codekey" && v == qr.key));
        let status = api.check_login(&qr.key).await.unwrap();
        assert_eq!(status.code, 801);
        api.cancel_login().await.unwrap();
        assert!(api.check_login(&qr.key).await.is_err());
        let song = api.search("陈绮贞", 0).await.unwrap().songs.remove(0);
        for level in ["exhigh", "lossless", "hires"] {
            let playback = api.playback(song.id, level).await.unwrap();
            assert_eq!(playback.requested_level, level);
            println!(
                "Requested {} -> actual {}, trial={}",
                level, playback.level, playback.trial
            );
        }
        println!("QR payload and real waiting state verified; no account login performed");
    }
    #[tokio::test]
    #[ignore = "live NetEase API; run explicitly with --ignored --nocapture"]
    async fn live_search_playback_lyrics() {
        let api = Api::new().unwrap();
        let result = api.search("陈绮贞", 0).await.unwrap();
        assert!(!result.songs.is_empty());
        let song = &result.songs[0];
        let playback = api.playback(song.id, "standard").await.unwrap();
        let response = api
            .session()
            .client
            .get(&playback.url)
            .header("Range", "bytes=0-1023")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert!(response.bytes().await.unwrap().len() >= 1024);
        let lyric = api.lyric(song.id).await.unwrap();
        assert!(lyric.contains('['));
        println!(
            "Verified: {} search results, {} / {}, audio reachable, trial={}, lyrics={} bytes",
            result.total,
            song.name,
            song.artist,
            playback.trial,
            lyric.len()
        );
    }
}
