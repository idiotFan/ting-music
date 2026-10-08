//! WebDAV transport for per-device playlist snapshots. Nutstore (坚果云) is the
//! reference server: Basic auth with an app password, `Depth: 1` listings and
//! 503 responses once its request quota is exhausted.
use crate::sync_model::Document;
use quick_xml::{events::Event, Reader, XmlVersion};
use reqwest::{header, Client, Method, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, net::IpAddr, sync::OnceLock, time::Duration};

pub const PASSWORD_ACCOUNT: &str = "webdav-password";
const DIRECTORY: &str = "Ting-Sync-v1";
const NUTSTORE_HOST: &str = "dav.jianguoyun.com";
const SNAPSHOT_LIMIT: usize = 16 * 1024 * 1024;
const TOTAL_LIMIT: usize = 32 * 1024 * 1024;
const LISTING_LIMIT: usize = 4 * 1024 * 1024;
const MAX_SNAPSHOTS: usize = 256;
const PROPFIND: &str = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/></d:prop></d:propfind>"#;

/// Connection settings kept in the local sync state. The password is not here.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Remote {
    pub server: String,
    pub folder: String,
    pub username: String,
    /// ETags of snapshots already merged into the local document.
    #[serde(default)]
    pub etags: BTreeMap<String, String>,
    /// Digest of the snapshot this device last uploaded.
    #[serde(default)]
    pub uploaded: Option<String>,
}

fn clean(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

fn local_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    match host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => host == "localhost" || host.ends_with(".local"),
    }
}

fn server_url(input: &str) -> Result<Url, String> {
    let mut url = Url::parse(input.trim()).map_err(|_| "WebDAV 服务器地址无效")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host().is_none()
    {
        return Err("WebDAV 服务器地址不能包含账号、参数或 #".into());
    }
    match url.scheme() {
        "https" => {}
        "http" if local_host(&url) => {}
        _ => return Err("请使用 https:// 开头的 WebDAV 地址（局域网设备可用 http://）".into()),
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

fn folder_path(input: &str) -> Result<String, String> {
    let parts: Vec<_> = input
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("请填写同步文件夹名称".into());
    }
    if parts
        .iter()
        .any(|p| matches!(*p, "." | "..") || p.contains('\\') || p.len() > 255 || !clean(p))
        || parts.len() > 16
    {
        return Err("同步文件夹名称无效".into());
    }
    Ok(parts.join("/"))
}

/// Nutstore only serves WebDAV under `/dav/`; a folder typed into the server
/// address moves into the folder path so missing parents can be created.
fn nutstore_root(mut url: Url, folder: String) -> Result<(Url, String), String> {
    if url.host_str() != Some(NUTSTORE_HOST) {
        return Ok((url, folder));
    }
    let extra: Vec<String> = url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .skip_while(|s| *s == "dav")
        .map(|s| {
            percent_encoding::percent_decode_str(s)
                .decode_utf8()
                .map(|s| s.into_owned())
                .map_err(|_| "WebDAV 服务器地址无效".to_string())
        })
        .collect::<Result<_, _>>()?;
    url.set_path("/dav/");
    if extra.is_empty() {
        return Ok((url, folder));
    }
    let prefix = folder_path(&extra.join("/"))?;
    let nested = folder == prefix || folder.starts_with(&format!("{prefix}/"));
    let folder = if nested {
        folder
    } else {
        folder_path(&format!("{prefix}/{folder}"))?
    };
    Ok((url, folder))
}

pub fn check_password(password: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > 1024 || !clean(password) {
        return Err("请填写有效的 WebDAV 密码".into());
    }
    Ok(())
}

impl Remote {
    pub fn new(server: &str, folder: &str, username: &str) -> Result<Self, String> {
        let username = username.trim();
        if username.is_empty() || username.len() > 256 || !clean(username) {
            return Err("请填写有效的 WebDAV 账号".into());
        }
        let (server, folder) = nutstore_root(server_url(server)?, folder_path(folder)?)?;
        Ok(Self {
            server: server.to_string(),
            folder,
            username: username.into(),
            etags: BTreeMap::new(),
            uploaded: None,
        })
    }
    /// Collections from the chosen folder down to the snapshot directory.
    fn collections(&self) -> Result<Vec<Url>, String> {
        let mut url = server_url(&self.server)?;
        let mut out = Vec::new();
        for part in self.folder.split('/').chain([DIRECTORY]) {
            {
                let mut segments = url.path_segments_mut().map_err(|_| "WebDAV 地址无效")?;
                segments.pop_if_empty().push(part).push("");
            }
            out.push(url.clone());
        }
        Ok(out)
    }
    fn directory(&self) -> Result<Url, String> {
        self.collections()?
            .pop()
            .ok_or_else(|| "WebDAV 地址无效".into())
    }
    pub fn host(&self) -> String {
        Url::parse(&self.server)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default()
    }
}

fn client() -> Result<Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .user_agent(concat!("Ting/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|_| "无法初始化网络连接".into())
        })
        .clone()
}

fn failure(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "WebDAV 账号或密码错误。坚果云请填写「第三方应用密码」，不是登录密码".into(),
        403 => "WebDAV 服务器拒绝访问这个文件夹".into(),
        429 | 503 => {
            "WebDAV 服务器繁忙或请求过于频繁（坚果云免费版每 30 分钟限 600 次），稍后自动重试"
                .into()
        }
        300..=399 => "WebDAV 地址发生了跳转，请填写服务器提供的完整地址".into(),
        409 => "WebDAV 上级文件夹不存在，请检查服务器地址和文件夹（坚果云地址为 https://dav.jianguoyun.com/dav/）".into(),
        507 => "WebDAV 空间已满".into(),
        code => format!("WebDAV 服务器返回错误（HTTP {code}）"),
    }
}

fn offline(_: reqwest::Error) -> String {
    "无法连接 WebDAV 服务器，请检查网络和服务器地址".into()
}

async fn send(
    method: Method,
    url: Url,
    remote: &Remote,
    password: &str,
    build: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> Result<Response, String> {
    build(
        client()?
            .request(method, url)
            .basic_auth(&remote.username, Some(password)),
    )
    .send()
    .await
    .map_err(offline)
}

async fn body(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    let large = || format!("WebDAV 响应超过 {} MB 上限", limit / 1024 / 1024);
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(large());
    }
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(offline)? {
        if out.len().saturating_add(chunk.len()) > limit {
            return Err(large());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[derive(Debug, Default, PartialEq)]
pub struct Entry {
    pub name: String,
    pub etag: Option<String>,
    pub length: Option<u64>,
    pub collection: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum Field {
    Href,
    Etag,
    Length,
}

/// Reads a `207 Multi-Status` body. Namespace prefixes vary between servers,
/// so elements are matched by local name.
pub fn parse(xml: &[u8]) -> Result<Vec<Entry>, String> {
    let invalid = || "WebDAV 服务器返回了无法识别的目录列表".to_string();
    let text = std::str::from_utf8(xml).map_err(|_| invalid())?;
    let mut reader = Reader::from_str(text);
    let mut entries = Vec::new();
    let mut current: Option<Entry> = None;
    let mut field = None;
    let mut value = String::new();
    loop {
        match reader.read_event().map_err(|_| invalid())? {
            Event::Start(e) => match e.local_name().as_ref() {
                "response" => current = Some(Entry::default()),
                "href" => (field, value) = (Some(Field::Href), String::new()),
                "getetag" => (field, value) = (Some(Field::Etag), String::new()),
                "getcontentlength" => (field, value) = (Some(Field::Length), String::new()),
                "collection" => {
                    if let Some(c) = current.as_mut() {
                        c.collection = true;
                    }
                }
                _ => {}
            },
            Event::Empty(e) if e.local_name().as_ref() == "collection" => {
                if let Some(c) = current.as_mut() {
                    c.collection = true;
                }
            }
            Event::Text(t) if field.is_some() => {
                value.push_str(&t.xml_content(XmlVersion::Implicit1_0));
            }
            Event::GeneralRef(r) if field.is_some() => {
                let raw = format!("&{};", &*r);
                value.push_str(&quick_xml::escape::unescape(&raw).map_err(|_| invalid())?);
            }
            Event::End(e) => match e.local_name().as_ref() {
                "response" => {
                    if let Some(c) = current.take() {
                        if entries.len() >= 10_000 {
                            return Err("WebDAV 目录里的文件过多".into());
                        }
                        entries.push(c);
                    }
                }
                "href" | "getetag" | "getcontentlength" => {
                    if let (Some(f), Some(c)) = (field.take(), current.as_mut()) {
                        let v = value.trim();
                        match f {
                            Field::Href => {
                                c.name = v
                                    .trim_end_matches('/')
                                    .rsplit('/')
                                    .next()
                                    .unwrap_or_default()
                                    .into();
                            }
                            Field::Etag if !v.is_empty() => c.etag = Some(v.into()),
                            Field::Length => c.length = v.parse().ok(),
                            Field::Etag => {}
                        }
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(entries)
}

fn snapshot(name: &str) -> bool {
    name.strip_prefix("device-")
        .and_then(|s| s.strip_suffix(".json"))
        .and_then(|id| uuid::Uuid::parse_str(id).ok().map(|u| (id, u)))
        .is_some_and(|(id, u)| u.hyphenated().to_string() == id)
}

async fn list(remote: &Remote, password: &str) -> Result<Option<Vec<Entry>>, String> {
    let response = send(
        Method::from_bytes(b"PROPFIND").map_err(|_| "WebDAV 请求无效")?,
        remote.directory()?,
        remote,
        password,
        |r| {
            r.header("Depth", "1")
                .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
                .body(PROPFIND)
        },
    )
    .await?;
    match response.status() {
        StatusCode::MULTI_STATUS => Ok(Some(parse(&body(response, LISTING_LIMIT).await?)?)),
        // Nutstore answers 409 when a parent folder is missing too.
        StatusCode::NOT_FOUND | StatusCode::CONFLICT => Ok(None),
        status => Err(failure(status)),
    }
}

async fn create(remote: &Remote, password: &str) -> Result<(), String> {
    for url in remote.collections()? {
        let response = send(
            Method::from_bytes(b"MKCOL").map_err(|_| "WebDAV 请求无效")?,
            url,
            remote,
            password,
            |r| r,
        )
        .await?;
        match response.status().as_u16() {
            // 405: the collection already exists.
            200..=299 | 405 => {}
            403 => return Err("WebDAV 服务器不允许新建这个文件夹，请先在网盘里创建它".into()),
            _ => return Err(failure(response.status())),
        }
    }
    Ok(())
}

/// Confirms credentials and creates the snapshot directory when missing.
pub async fn connect(remote: &Remote, password: &str) -> Result<(), String> {
    if list(remote, password).await?.is_none() {
        create(remote, password).await?;
        list(remote, password)
            .await?
            .ok_or("WebDAV 同步文件夹创建后仍无法访问")?;
    }
    Ok(())
}

pub struct Fetched {
    pub documents: Vec<Document>,
    pub etags: BTreeMap<String, String>,
    pub own: bool,
}

/// Downloads snapshots whose ETag changed since they were last merged.
pub async fn fetch(remote: &Remote, password: &str, device: &str) -> Result<Fetched, String> {
    let entries = match list(remote, password).await? {
        Some(entries) => entries,
        None => {
            create(remote, password).await?;
            Vec::new()
        }
    };
    let own_name = format!("device-{device}.json");
    let snapshots: Vec<_> = entries
        .into_iter()
        .filter(|e| !e.collection && snapshot(&e.name))
        .collect();
    if snapshots.len() > MAX_SNAPSHOTS {
        return Err("WebDAV 同步文件夹里的设备快照过多".into());
    }
    let directory = remote.directory()?;
    let mut fetched = Fetched {
        documents: Vec::new(),
        etags: BTreeMap::new(),
        own: false,
    };
    let mut total = 0usize;
    for entry in snapshots {
        fetched.own |= entry.name == own_name;
        if entry.length.is_some_and(|n| n > SNAPSHOT_LIMIT as u64) {
            return Err("WebDAV 上的同步文件超过 16 MB，未覆盖云端文件".into());
        }
        let etag = entry.etag.filter(|t| t.len() <= 256);
        // This device's own upload is already in the local state; its ETag is
        // only learned from the listing when the PUT response omitted it.
        if entry.name == own_name && remote.uploaded.is_some() {
            if let Some(tag) = etag {
                fetched.etags.insert(entry.name, tag);
            }
            continue;
        }
        if let Some(tag) = &etag {
            if remote.etags.get(&entry.name) == Some(tag) {
                fetched.etags.insert(entry.name, tag.clone());
                continue;
            }
        }
        let url = directory.join(&entry.name).map_err(|_| "WebDAV 地址无效")?;
        let response = send(Method::GET, url, remote, password, |r| r).await?;
        match response.status() {
            StatusCode::OK => {}
            // Removed between the listing and this request.
            StatusCode::NOT_FOUND => continue,
            status => return Err(failure(status)),
        }
        let remaining = TOTAL_LIMIT.saturating_sub(total).min(SNAPSHOT_LIMIT);
        let bytes = body(response, remaining)
            .await
            .map_err(|_| "WebDAV 同步数据超过上限，未覆盖云端文件".to_string())?;
        total += bytes.len();
        let document: Document =
            serde_json::from_slice(&bytes).map_err(|_| "同步文件损坏或版本过新，未覆盖云端文件")?;
        fetched.documents.push(document);
        if let Some(tag) = etag {
            fetched.etags.insert(entry.name, tag);
        }
    }
    Ok(fetched)
}

/// Replaces this device's snapshot; returns its new ETag when the server sends one.
pub async fn publish(
    remote: &Remote,
    password: &str,
    device: &str,
    payload: String,
) -> Result<Option<String>, String> {
    let url = remote
        .directory()?
        .join(&format!("device-{device}.json"))
        .map_err(|_| "WebDAV 地址无效")?;
    let response = send(Method::PUT, url, remote, password, |r| {
        r.header(header::CONTENT_TYPE, "application/json")
            .body(payload)
    })
    .await?;
    match response.status().as_u16() {
        200..=299 => Ok(response
            .headers()
            .get(header::ETAG)
            .and_then(|v| v.to_str().ok())
            .filter(|t| !t.is_empty() && t.len() <= 256)
            .map(str::to_owned)),
        409 => Err("WebDAV 同步文件夹不存在，下次同步时会重新创建".into()),
        _ => Err(failure(response.status())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_normalize_and_reject_unsafe_forms() {
        let r = Remote::new(
            "https://dav.jianguoyun.com/dav",
            " /音乐/Ting/ ",
            " me@example.com ",
        )
        .unwrap();
        assert_eq!(r.server, "https://dav.jianguoyun.com/dav/");
        assert_eq!(r.folder, "音乐/Ting");
        assert_eq!(r.username, "me@example.com");
        assert_eq!(
            r.directory().unwrap().as_str(),
            "https://dav.jianguoyun.com/dav/%E9%9F%B3%E4%B9%90/Ting/Ting-Sync-v1/"
        );
        let names: Vec<_> = r
            .collections()
            .unwrap()
            .iter()
            .map(|u| u.path().to_owned())
            .collect();
        assert_eq!(
            names,
            [
                "/dav/%E9%9F%B3%E4%B9%90/",
                "/dav/%E9%9F%B3%E4%B9%90/Ting/",
                "/dav/%E9%9F%B3%E4%B9%90/Ting/Ting-Sync-v1/"
            ]
        );
        assert_eq!(r.host(), "dav.jianguoyun.com");
        for (server, folder, want) in [
            ("https://dav.jianguoyun.com/dav/听Ting", "听Ting", "听Ting"),
            (
                "https://dav.jianguoyun.com/dav/听Ting/",
                "Ting",
                "听Ting/Ting",
            ),
            ("https://dav.jianguoyun.com/", "Ting", "Ting"),
            ("https://dav.jianguoyun.com/dav/a%20b/", "a b/c", "a b/c"),
        ] {
            let r = Remote::new(server, folder, "u").unwrap();
            assert_eq!(r.server, "https://dav.jianguoyun.com/dav/", "{server}");
            assert_eq!(r.folder, want, "{server}");
        }
        assert_eq!(
            Remote::new("https://x.example/dav/听Ting/", "Ting", "u")
                .unwrap()
                .folder,
            "Ting"
        );
        for ok in [
            "http://127.0.0.1:8080/",
            "http://192.168.1.2/dav",
            "http://nas.local/",
            "http://[::1]/",
        ] {
            assert!(Remote::new(ok, "Ting", "u").is_ok(), "{ok}");
        }
        for bad in [
            "http://dav.jianguoyun.com/dav/",
            "http://8.8.8.8/",
            "https://u:p@dav.jianguoyun.com/dav/",
            "https://dav.jianguoyun.com/dav/?a=1",
            "ftp://example.com/",
            "dav.jianguoyun.com",
        ] {
            assert!(Remote::new(bad, "Ting", "u").is_err(), "{bad}");
        }
        for bad in ["", "/", "../x", "a/./b", "a\\b", "a\nb"] {
            assert!(
                Remote::new("https://x.example/", bad, "u").is_err(),
                "{bad:?}"
            );
        }
        assert!(Remote::new("https://x.example/", "Ting", " ").is_err());
        assert!(check_password("").is_err());
        assert!(check_password("abc\n").is_err());
        assert!(check_password("a2b3c4d5e6").is_ok());
    }
    #[test]
    fn multistatus_from_nutstore_and_other_servers() {
        let nutstore = br#"<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com">
<d:response><d:href>/dav/Ting/Ting-Sync-v1/</d:href><d:propstat><d:prop>
<d:resourcetype><d:collection/></d:resourcetype><d:getetag/></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>/dav/Ting/Ting-Sync-v1/device-00000000-0000-4000-8000-000000000001.json</d:href>
<d:propstat><d:prop><d:resourcetype/><d:getetag>&quot;e1&amp;2&quot;</d:getetag>
<d:getcontentlength>120</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"#;
        let entries = parse(nutstore).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].collection);
        assert_eq!(entries[0].name, "Ting-Sync-v1");
        assert_eq!(entries[0].etag, None);
        assert_eq!(
            entries[1],
            Entry {
                name: "device-00000000-0000-4000-8000-000000000001.json".into(),
                etag: Some("\"e1&2\"".into()),
                length: Some(120),
                collection: false,
            }
        );
        let plain = br#"<multistatus xmlns="DAV:"><response><href>https://h.example/remote.php/dav/files/u/Ting/Ting-Sync-v1/device-00000000-0000-4000-8000-000000000002.json</href><propstat><prop><getetag>W/"abc"</getetag></prop></propstat></response></multistatus>"#;
        let entries = parse(plain).unwrap();
        assert_eq!(
            entries[0].name,
            "device-00000000-0000-4000-8000-000000000002.json"
        );
        assert_eq!(entries[0].etag.as_deref(), Some("W/\"abc\""));
        assert!(parse(b"<d:multistatus><d:response>").is_ok());
        assert!(parse(b"<a></b>").is_err());
        assert!(parse(&[0xff, 0xfe]).is_err());
    }
    #[test]
    fn only_canonical_device_snapshots_are_read() {
        assert!(snapshot("device-00000000-0000-4000-8000-000000000001.json"));
        for name in [
            "device-00000000000040008000000000000001.json",
            "device-00000000-0000-4000-8000-00000000000A.json",
            "device-x.json",
            "device-00000000-0000-4000-8000-000000000001.json.tmp",
            "other.json",
        ] {
            assert!(!snapshot(name), "{name}");
        }
    }
}
