//! Native download pipeline: isolated CDN requests, full decode, tags, no-clobber publish.
use crate::http;
use lofty::{
    config::WriteOptions,
    file::FileType,
    picture::{MimeType, Picture, PictureInformation, PictureType},
    prelude::*,
    tag::{ItemValue, Tag, TagItem, TagType},
};
use md5::{Digest, Md5};
use serde_json::{json, Value};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use symphonia::core::{
    codecs::{DecoderOptions, CODEC_TYPE_FLAC, CODEC_TYPE_MP3},
    errors::Error,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};
use tokio::io::AsyncWriteExt;
const IO_ERROR: &str = "下载文件无法写入，请检查磁盘空间和目录权限";

fn format_io_error(path: &Path, err: &std::io::Error) -> String {
    let detail = match err.raw_os_error() {
        Some(code) => format!("{:?}/os={code}", err.kind()),
        None => format!("{:?}: {err}", err.kind()),
    };
    format!("{IO_ERROR}（{}: {detail}）", path.display())
}

#[cfg(target_os = "windows")]
fn windows_io_retryable(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::TimedOut
    ) || matches!(err.raw_os_error(), Some(5) | Some(32) | Some(33))
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}
fn rank(level: &str) -> u8 {
    match level {
        "jymaster" | "master" => 6,
        "hires" => 5,
        "lossless" => 4,
        "exhigh" => 3,
        "higher" => 2,
        "standard" => 1,
        _ => 0,
    }
}
async fn ncm(cookie: &str, path: &str, mut form: Vec<(&str, String)>) -> Result<Value, String> {
    let csrf = cookie
        .split(';')
        .filter_map(|v| v.trim().split_once('='))
        .find_map(|(k, v)| (k == "__csrf").then_some(v))
        .unwrap_or("");
    form.push(("csrf_token", csrf.into()));
    let response = http::client()?
        .post(format!("https://music.163.com/api/{path}"))
        .header("Referer", "https://music.163.com/")
        .header("Cookie", cookie)
        .form(&form)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "网易云音源请求失败，请检查网络")?;
    let data = http::json(response).await?;
    if [405, -460, 8810].contains(&data["code"].as_i64().unwrap_or(0)) {
        return Err("网易云请求过于频繁，请稍后重试".into());
    }
    Ok(data)
}
pub async fn prepare(id: u64, cookie: &str) -> Result<Value, String> {
    let data = ncm(
        cookie,
        "v3/song/detail",
        vec![("c", json!([{"id":id}]).to_string())],
    )
    .await?;
    let song = data["songs"]
        .as_array()
        .and_then(|v| v.iter().find(|v| n(&v["id"]) == id))
        .ok_or("无法读取歌曲信息，请检查网易云登录状态")?;
    let artists: Vec<_> = song["ar"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a["name"].as_str())
        .filter(|s| !s.is_empty())
        .collect();
    if artists.is_empty() || n(&song["dt"]) == 0 {
        return Err("歌曲信息不完整，无法安全匹配音源".into());
    }
    let mut best = Value::Null;
    for level in [
        "jymaster", "hires", "lossless", "exhigh", "higher", "standard",
    ] {
        let data = ncm(
            cookie,
            "song/enhance/player/url/v1",
            vec![
                ("ids", json!([id]).to_string()),
                ("level", level.into()),
                (
                    "encodeType",
                    if rank(level) >= 4 { "flac" } else { "mp3" }.into(),
                ),
            ],
        )
        .await?;
        let audio = &data["data"][0];
        if s(&audio["url"]).is_empty() || !audio["freeTrialInfo"].is_null() {
            continue;
        }
        if best.is_null()
            || (rank(s(&audio["level"])), n(&audio["br"]))
                > (rank(s(&best["level"])), n(&best["br"]))
        {
            best = audio.clone();
        }
        if rank(s(&audio["level"])) >= rank(level) {
            break;
        }
    }
    let lyrics = ncm(
        cookie,
        "song/lyric",
        vec![
            ("id", id.to_string()),
            ("lv", "-1".into()),
            ("tv", "-1".into()),
            ("rv", "-1".into()),
            ("kv", "-1".into()),
        ],
    )
    .await
    .unwrap_or(Value::Null);
    let lyric = s(&lyrics["lrc"]["lyric"]);
    let lyric = if regex::Regex::new(r"\[\d+:\d+").unwrap().is_match(lyric) {
        lyric
    } else {
        ""
    };
    let year = song["publishTime"]
        .as_i64()
        .filter(|v| *v > 0)
        .and_then(|v| time::OffsetDateTime::from_unix_timestamp(v / 1000).ok())
        .map(|d| d.year().to_string())
        .unwrap_or_default();
    let playback = if best.is_null() {
        Value::Null
    } else {
        json!({"url":best["url"],"format":best["type"],"level":best["level"],"size":best["size"],"md5":best["md5"],"trial":false})
    };
    Ok(
        json!({"song":{"id":id,"source":"netease","name":song["name"],"duration":song["dt"],"artist":artists.join(" / "),"album":song["al"]["name"],"cover":song["al"]["picUrl"]},"artists":artists,"year":year,"lyric":lyric,"playback":playback}),
    )
}
fn trusted_url(value: &str, artwork: bool) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "音源地址无效")?;
    let allowed = url.host_str().is_some_and(|host| {
        [".music.126.net", ".music.163.com", ".qq.com"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
            || (artwork && host.ends_with(".gtimg.cn"))
    });
    if url.scheme() != "https"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("音源返回了非预期下载地址".into());
    }
    Ok(url)
}
async fn open_cdn(value: &str, artwork: bool) -> Result<reqwest::Response, String> {
    let initial = value
        .strip_prefix("http://")
        .map(|rest| format!("https://{rest}"));
    let mut url = trusted_url(initial.as_deref().unwrap_or(value), artwork)?;
    for _ in 0..6 {
        // This client has no cookie jar, no proxy credentials, and no automatic redirects.
        let response = http::client()?
            .get(url.clone())
            .timeout(Duration::from_secs(480))
            .send()
            .await
            .map_err(|_| "音源下载请求失败，请检查网络")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("音源重定向无效")?;
            let next = url.join(location).map_err(|_| "音源重定向无效")?;
            url = trusted_url(next.as_str(), artwork)?;
        } else if response.status().is_success() {
            return Ok(response);
        } else {
            return Err("音源服务暂不可用".into());
        }
    }
    Err("音源重定向过多".into())
}
async fn fetch_audio(audio: &Value, path: &Path) -> Result<(), String> {
    let response = open_cdn(s(&audio["url"]), false).await?;
    write_audio_response(audio, path, response).await
}
async fn open_scratch_audio(path: &Path) -> Result<tokio::fs::File, String> {
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
    {
        Ok(file) => Ok(file),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            tokio::fs::remove_file(path)
                .await
                .map_err(|e| format_io_error(path, &e))?;
            tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .await
                .map_err(|e| format_io_error(path, &e))
        }
        Err(_) => tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .await
            .map_err(|e| format_io_error(path, &e)),
    }
}

async fn write_audio_response(
    audio: &Value,
    path: &Path,
    mut response: reqwest::Response,
) -> Result<(), String> {
    let limit = 512 * 1024 * 1024;
    let length = response.content_length().unwrap_or(0);
    if length > limit || n(&audio["size"]) > limit {
        return Err("单曲超过 512 MB".into());
    }
    let mut file = open_scratch_audio(path).await?;
    let mut count = 0u64;
    let mut digest = Md5::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "音频下载中断，请重试")? {
        count += chunk.len() as u64;
        if count > limit {
            return Err("单曲超过 512 MB".into());
        }
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format_io_error(path, &e))?;
    }
    file.sync_all()
        .await
        .map_err(|e| format_io_error(path, &e))?;
    if count < 1000
        || (length > 0 && count != length)
        || (n(&audio["size"]) > 0 && count != n(&audio["size"]))
    {
        return Err("下载文件不完整".into());
    }
    let expected = s(&audio["md5"]);
    if !expected.is_empty() && format!("{:x}", digest.finalize()) != expected.to_lowercase() {
        return Err("下载文件校验和不符".into());
    }
    Ok(())
}
async fn cover(url: &str) -> Option<Vec<u8>> {
    if url.is_empty() {
        return None;
    }
    let work = async {
        let response = open_cdn(url, true).await.ok()?;
        let data = http::bytes(response, 8 * 1024 * 1024).await.ok()?;
        let info = PictureInformation::from_jpeg(&data).ok()?;
        (info.width > 0 && info.height > 0).then_some(data)
    };
    tokio::time::timeout(Duration::from_secs(30), work)
        .await
        .ok()
        .flatten()
}
// Use the same bounded CDN policy as download covers, without account cookies.
#[tauri::command]
pub async fn media_artwork(url: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = tokio::time::timeout(Duration::from_secs(10), cover(&url))
        .await
        .map_err(|_| "封面加载超时")?
        .ok_or("封面暂不可用")?;
    let info = PictureInformation::from_jpeg(&bytes).map_err(|_| "封面格式无效")?;
    if info.width > 8192 || info.height > 8192 {
        return Err("封面尺寸过大".into());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
fn validate_info(info: &Value, id: Option<u64>) -> Result<(), String> {
    let song = &info["song"];
    let audio = &info["playback"];
    if n(&song["id"]) == 0
        || id.is_some_and(|id| n(&song["id"]) != id)
        || audio["trial"] != false
        || s(&audio["url"]).is_empty()
        || !["mp3", "flac"].contains(&s(&audio["format"]))
        || rank(s(&audio["level"])) == 0
    {
        return Err("音乐平台没有返回完整可下载音源".into());
    }
    if n(&song["duration"]) == 0
        || s(&song["name"]).is_empty()
        || !info["artists"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(|v| !s(v).is_empty()))
    {
        return Err("歌曲信息不完整，无法安全下载".into());
    }
    Ok(())
}
// Decode libraries may resynchronize past invalid bytes or swallow a partial final
// packet. Walk MP3 frame boundaries first so those cases cannot pass as complete.
fn validate_mp3_frames(path: &Path) -> Result<(), String> {
    let err = "MP3 音频帧不完整，未保存";
    let mut file = std::fs::File::open(path).map_err(|_| err)?;
    let length = file.metadata().map_err(|_| err)?.len();
    let mut pos = 0u64;
    let mut header = [0u8; 10];
    file.read_exact(&mut header).map_err(|_| err)?;
    if &header[..3] == b"ID3" {
        if header[6..10].iter().any(|n| n & 128 != 0) {
            return Err(err.into());
        }
        let size = header[6..10].iter().fold(0u64, |v, b| (v << 7) | *b as u64);
        pos = 10
            + size
            + if header[3] == 4 && header[5] & 16 != 0 {
                10
            } else {
                0
            };
    }
    let mut count = 0;
    while pos < length {
        file.seek(SeekFrom::Start(pos)).map_err(|_| err)?;
        let mut h = [0; 4];
        file.read_exact(&mut h).map_err(|_| err)?;
        if length - pos == 128 && &h[..3] == b"TAG" {
            break;
        }
        let version = (h[1] >> 3) & 3;
        let layer = (h[1] >> 1) & 3;
        let index = (h[2] >> 4) as usize;
        let rate_index = ((h[2] >> 2) & 3) as usize;
        if h[0] != 255
            || h[1] & 224 != 224
            || version == 1
            || layer != 1
            || index == 0
            || index == 15
            || rate_index == 3
        {
            return Err(err.into());
        }
        let rates = [44100u64, 48000, 32000];
        let rate = rates[rate_index]
            / match version {
                3 => 1,
                2 => 2,
                _ => 4,
            };
        let v1 = [
            0u64, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ];
        let v2 = [
            0u64, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
        ];
        let bitrate = if version == 3 { v1[index] } else { v2[index] };
        let frame =
            if version == 3 { 144000 } else { 72000 } * bitrate / rate + ((h[2] >> 1) & 1) as u64;
        pos = pos.checked_add(frame).ok_or(err)?;
        if pos > length {
            return Err(err.into());
        }
        count += 1;
    }
    if count == 0 {
        return Err(err.into());
    }
    Ok(())
}

fn validate_audio(
    path: &Path,
    duration_ms: u64,
    content_hash_verified: bool,
) -> Result<(), String> {
    let error = "音频完整解码失败，未保存";
    if path.extension().is_some_and(|s| s == "mp3") {
        validate_mp3_frames(path)?;
    }
    let tagged = lofty::read_from_path(path).map_err(|_| error)?;
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if !matches!(
        (ext, tagged.file_type()),
        ("flac", FileType::Flac) | ("mp3", FileType::Mpeg)
    ) {
        return Err("返回的音频格式与音源信息不符".into());
    }
    let properties = tagged.properties();
    let duration = properties.duration().as_secs_f64();
    let rate = properties.sample_rate().ok_or(error)?;
    let channels = properties.channels().ok_or(error)?;
    if !(1..=8).contains(&channels)
        || rate == 0
        || rate > 768000
        || duration <= 0.
        || duration_ms == 0
        || (duration - duration_ms as f64 / 1000.).abs() > 2.
    {
        return Err("下载时长或音频参数与歌曲不符，未保存".into());
    }
    let file = std::fs::File::open(path).map_err(|e| format_io_error(path, &e))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| error)?
        .format;
    let track = format.default_track().ok_or(error)?;
    if track.codec_params.codec
        != if ext == "flac" {
            CODEC_TYPE_FLAC
        } else {
            CODEC_TYPE_MP3
        }
    {
        return Err(error.into());
    }
    let track_id = track.id;
    let declared = track.codec_params.n_frames;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions { verify: true })
        .map_err(|_| error)?;
    let start = Instant::now();
    let mut frames = 0u64;
    loop {
        if start.elapsed() > Duration::from_secs(120) {
            return Err("音频校验超时，请重试".into());
        }
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(_) => return Err(error.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder.decode(&packet).map_err(|_| error)?;
        if decoded.spec().rate != rate || decoded.spec().channels.count() != channels as usize {
            return Err(error.into());
        }
        frames += decoded.frames() as u64;
    }
    // Platform CDN MD5 (when present) already checked during fetch. Symphonia's
    // bitstream verify can false-fail on some valid NetEase/QQ streams, especially
    // observed on Windows; keep it strict only when we lack a content hash.
    if decoder.finalize().verify_ok == Some(false) && !content_hash_verified {
        return Err("音频数据校验和不符，未保存".into());
    }
    let tolerance = if ext == "mp3" { 0.10 } else { 0.001 };
    if frames == 0
        || (frames as f64 / rate as f64 - duration).abs() > tolerance
        || (ext == "flac" && declared.is_some_and(|n| n != frames))
    {
        return Err("音频数据不完整，未保存".into());
    }
    Ok(())
}
fn tag_file(
    path: &Path,
    info: &Value,
    origin: &str,
    source: &str,
    audio_id: u64,
    level: &str,
    cover: Option<&[u8]>,
) -> Result<(), String> {
    let song = &info["song"];
    let ext = path.extension().and_then(|v| v.to_str()).unwrap_or("");
    let tag_type = if ext == "flac" {
        TagType::VorbisComments
    } else {
        TagType::Id3v2
    };
    let mut file = lofty::read_from_path(path).map_err(|_| "歌曲标签读取失败")?;
    let old: Vec<_> = file.tags().iter().map(|t| t.tag_type()).collect();
    for kind in old {
        file.remove(kind);
    }
    let mut tag = Tag::new(tag_type);
    tag.set_title(s(&song["name"]).into());
    tag.set_album(s(&song["album"]).into());
    for artist in info["artists"].as_array().into_iter().flatten() {
        tag.push(TagItem::new(
            ItemKey::TrackArtist,
            ItemValue::Text(s(artist).into()),
        ));
    }
    tag.insert_text(ItemKey::AlbumArtist, s(&info["artists"][0]).into());
    tag.set_track(1);
    tag.set_track_total(1);
    if let Ok(year) = s(&info["year"]).parse() {
        tag.set_year(year);
    }
    let id = n(&song["id"]);
    tag.insert_text(
        ItemKey::Comment,
        format!("origin:{origin}:{id} audio:{source}:{audio_id} quality:{level}"),
    );
    if ext == "flac" {
        for (key, value) in [
            ("TING_ORIGIN_PLATFORM", origin.to_owned()),
            ("TING_ORIGIN_ID", id.to_string()),
            ("TING_AUDIO_PLATFORM", source.to_owned()),
            ("TING_AUDIO_ID", audio_id.to_string()),
        ] {
            tag.insert_unchecked(TagItem::new(
                ItemKey::Unknown(key.into()),
                ItemValue::Text(value),
            ));
        }
    }
    if !s(&info["lyric"]).is_empty() {
        tag.insert_text(ItemKey::Lyrics, s(&info["lyric"]).into());
    }
    if let Some(data) = cover {
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            Some("Cover".into()),
            data.to_vec(),
        ));
    }
    file.insert_tag(tag);
    file.save_to_path(path, WriteOptions::default().use_id3v23(true))
        .map_err(|_| "歌曲标签写入失败")?;
    let verified = lofty::read_from_path(path).map_err(|_| "歌曲标签校验失败")?;
    let tag = verified.tag(tag_type).ok_or("歌曲标签校验失败")?;
    if tag.title().as_deref() != Some(s(&song["name"]))
        || tag.artist().is_none()
        || (cover.is_some() && tag.pictures().is_empty())
    {
        return Err("歌曲标签校验失败".into());
    }
    Ok(())
}
fn safe_name(value: &str) -> String {
    let replaced: String = value
        .chars()
        .map(|c| match c {
            ':' => '：',
            '/' => '／',
            '\\' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let clean = replaced
        .trim()
        .trim_end_matches('.')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let clean: String = clean.chars().take(65).collect();
    if clean.is_empty() {
        "_".into()
    } else {
        clean
    }
}
fn sync_audio(path: &Path) -> Result<(), String> {
    // Windows FlushFileBuffers requires write access, including after tagging.
    // Open the existing file without creating or truncating its audio data.
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|err| format_io_error(path, &err))
}

fn copy_new(mut source: impl Read, dest: &Path) -> std::io::Result<()> {
    // The destination can appear after publish's filename check. Claim it with
    // create_new so another downloader's completed file can never be truncated.
    let mut target = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)?;
    let result = std::io::copy(&mut source, &mut target).and_then(|_| target.sync_all());
    drop(target); // Windows requires closing the handle before removing it.
    if result.is_err() {
        // Only this invocation created the file; an existing target fails above.
        let _ = std::fs::remove_file(dest);
    }
    result
}

fn publish(temp: &Path, folder: &Path, stem: &str, ext: &str) -> Result<PathBuf, String> {
    for number in 0..1000 {
        let stem = if number == 0 {
            stem.into()
        } else {
            format!("{stem} ({number})")
        };
        if ["json", "lrc", "mp3", "flac"].iter().any(|suffix| {
            folder
                .join(format!("{stem}.{suffix}"))
                .symlink_metadata()
                .is_ok()
        }) {
            continue;
        }
        let dest = folder.join(format!("{stem}.{ext}"));
        // Windows often cannot hard-link (and Controlled Folder Access can deny it).
        // Prefer copy there; keep hard_link-first on Unix for atomic no-clobber publish.
        #[cfg(target_os = "windows")]
        {
            let mut attempt = 0u32;
            loop {
                match std::fs::File::open(temp).and_then(|source| copy_new(source, &dest)) {
                    Ok(_) => {
                        let _ = std::fs::remove_file(temp);
                        return Ok(dest);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => break,
                    Err(e) if windows_io_retryable(&e) && attempt < 4 => {
                        attempt += 1;
                        std::thread::sleep(Duration::from_millis(40 * u64::from(attempt)));
                    }
                    Err(e) => return Err(format_io_error(&dest, &e)),
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            match std::fs::hard_link(temp, &dest) {
                Ok(()) => return Ok(dest),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    match std::fs::File::open(temp).and_then(|source| copy_new(source, &dest)) {
                        Ok(_) => {
                            let _ = std::fs::remove_file(temp);
                            return Ok(dest);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                        Err(e) => return Err(format_io_error(&dest, &e)),
                    }
                }
            }
        }
    }
    Err("同名文件过多".into())
}
fn sidecar(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}
// This future owns Scratch through the blocking phase; canceling IPC cannot delete a
// file while the decoder is still using it. Blocking decode has its own deadline.
pub async fn run(
    id: u64,
    origin: String,
    info: Value,
    fallback: Value,
    folder: PathBuf,
    scratch: super::download::Scratch,
    guard: super::download::Guard,
) -> Result<Value, String> {
    let from_fallback = !fallback.is_null();
    let chosen = if from_fallback {
        fallback
    } else {
        info.clone()
    };
    validate_info(&chosen, if from_fallback { None } else { Some(id) })?;
    if from_fallback && (origin != "netease" || n(&info["song"]["id"]) != id) {
        return Err("补源信息无效".into());
    }
    let audio = chosen["playback"].clone();
    let source = if from_fallback {
        "qq".into()
    } else {
        origin.clone()
    };
    let audio_id = n(&chosen["song"]["id"]);
    let ext = s(&audio["format"]).to_owned();
    let level = s(&audio["level"]).to_owned();
    let temp = scratch.0.join(format!("audio.{ext}"));
    tokio::time::timeout(Duration::from_secs(480), fetch_audio(&audio, &temp))
        .await
        .map_err(|_| "下载超时，请重试")??;
    let artwork = cover(s(&info["song"]["cover"])).await;
    let canceled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    struct Cancel(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Cancel {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::Release);
        }
    }
    let _cancel = Cancel(canceled.clone());
    tokio::task::spawn_blocking(move||{
        let _guard=guard;
        let _scratch=scratch;
        let content_hash_verified=!s(&audio["md5"]).is_empty();
        validate_audio(&temp,n(&info["song"]["duration"]),content_hash_verified)?;
        tag_file(&temp,&info,&origin,&source,audio_id,&level,artwork.as_deref())?;
        let verified=lofty::read_from_path(&temp).map_err(|_|"歌曲标签校验失败")?;
        let properties=verified.properties();
        let artists:Vec<_>=info["artists"].as_array().into_iter().flatten().map(s).collect();
        let stem=format!("{} [{}{}]",safe_name(&format!("{} - {}",s(&info["song"]["name"]),artists.join(" & "))),if origin=="qq"{"QQ-"}else{""},id);
        sync_audio(&temp)?;
        if canceled.load(std::sync::atomic::Ordering::Acquire){return Err("下载已取消".into());}
        let dest=publish(&temp,&folder,&stem,&ext)?;
        let mut warnings=Vec::new();let lyric=s(&info["lyric"]);
        if artwork.is_none(){warnings.push("封面暂不可用");}if lyric.is_empty(){warnings.push("歌词暂不可用");}
        if !lyric.is_empty()&&sidecar(&dest.with_extension("lrc"),lyric.as_bytes()).is_err(){warnings.push("歌词文件写入失败");}
        let mut result=json!({"filename":dest.file_name().unwrap_or_default().to_string_lossy(),"path":dest.to_string_lossy(),"source":source,"level":level,"format":ext,"bytes":std::fs::metadata(&dest).map_err(|e| format_io_error(&dest, &e))?.len(),"bitrate":properties.audio_bitrate().unwrap_or(0)*1000,"sampleRate":properties.sample_rate().unwrap_or(0),"bitDepth":properties.bit_depth().unwrap_or(0),"cover":artwork.is_some(),"lyrics":!lyric.is_empty(),"warnings":warnings});
        let mut provenance=result.clone();provenance["origin"]=json!({"platform":origin,"id":id});provenance["audio"]=json!({"platform":source,"id":audio_id});provenance["title"]=info["song"]["name"].clone();provenance["artists"]=info["artists"].clone();
        if sidecar(&dest.with_extension("json"),serde_json::to_string_pretty(&provenance).map_err(|_|IO_ERROR)?.as_bytes()).is_err(){warnings.push("来源记录写入失败");result["warnings"]=json!(warnings);}
        Ok(result)
    }).await.map_err(|_|"音频校验任务未完成")?
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::Scratch;
    fn temp() -> Scratch {
        let p = std::env::temp_dir().join(format!("ting-native-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&p).unwrap();
        Scratch(p)
    }
    fn info(ext: &str) -> Value {
        json!({"song":{"id":123,"source":"qq","name":"Example","album":"Album","duration":20000},"artists":["Artist"],"year":"2026","lyric":"[00:00.00]Fixture lyric","playback":{"url":"https://stream.qqmusic.qq.com/fixture","trial":false,"format":ext,"level":if ext=="flac"{"lossless"}else{"exhigh"}}})
    }
    fn fixture(ext: &str, dir: &Path) -> PathBuf {
        let path = dir.join(format!("fixture.{ext}"));
        let mut command =
            std::process::Command::new(if Path::new("/opt/homebrew/bin/ffmpeg").exists() {
                "/opt/homebrew/bin/ffmpeg"
            } else {
                "ffmpeg"
            });
        command.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=20",
            "-ac",
            "2",
        ]);
        if ext == "flac" {
            command.args(["-ar", "192000", "-sample_fmt", "s32"]);
        } else {
            command.args(["-ar", "44100", "-b:a", "320k"]);
        }
        assert!(command
            .arg(&path)
            .status()
            .expect("ffmpeg is required for native audio regression tests")
            .success());
        path
    }
    #[test]
    fn only_known_https_cdns_are_allowed() {
        for url in [
            "http://stream.qqmusic.qq.com/a",
            "https://qq.com.evil.example/a",
            "https://qq.com/a",
            "https://127.0.0.1/a",
            "https://example.com/a",
            "https://user:pass@stream.qqmusic.qq.com/a",
            "https://stream.qqmusic.qq.com:444/a",
            "file:///tmp/a",
        ] {
            assert!(trusted_url(url, false).is_err());
        }
        assert!(trusted_url("https://m10.music.126.net/a", false).is_ok());
        assert!(trusted_url("https://y.gtimg.cn/a", false).is_err());
        assert!(trusted_url("https://y.gtimg.cn/a", true).is_ok());
    }
    #[test]
    fn plans_reject_trial_wrong_id_format_quality_and_missing_metadata() {
        assert!(validate_info(&info("mp3"), Some(123)).is_ok());
        for (key, value) in [
            ("trial", json!(true)),
            ("format", json!("aac")),
            ("level", json!("unknown")),
            ("url", json!("")),
        ] {
            let mut i = info("mp3");
            i["playback"][key] = value;
            assert!(validate_info(&i, Some(123)).is_err());
        }
        assert!(validate_info(&info("mp3"), Some(9)).is_err());
        let mut i = info("flac");
        i["artists"] = json!([]);
        assert!(validate_info(&i, None).is_err());
    }
    #[test]
    fn native_decode_tags_and_corruption_regression() {
        for ext in ["flac", "mp3"] {
            let dir = temp();
            let path = fixture(ext, &dir.0);
            validate_audio(&path, 20000, false).unwrap();
            assert!(validate_audio(&path, 10000, false).is_err());
            let data = std::fs::read(&path).unwrap();
            let truncated = dir.0.join(format!("truncated.{ext}"));
            std::fs::write(&truncated, &data[..data.len() / 2]).unwrap();
            assert!(validate_audio(&truncated, 20000, false).is_err());
            let mut corrupt = data.clone();
            let start = corrupt.len() / 2;
            corrupt[start..start + 4096].fill(0);
            let damaged = dir.0.join(format!("damaged.{ext}"));
            std::fs::write(&damaged, corrupt).unwrap();
            assert!(validate_audio(&damaged, 20000, false).is_err());
            let short = dir.0.join(format!("short.{ext}"));
            std::fs::write(&short, &data[..data.len() - 1]).unwrap();
            assert!(
                validate_audio(&short, 20000, false).is_err(),
                "partial final frame must fail"
            );
            tag_file(&path, &info(ext), "netease", "qq", 987, "lossless", None).unwrap();
            sync_audio(&path).unwrap();
            validate_audio(&path, 20000, false).unwrap();
            let tagged = lofty::read_from_path(&path).unwrap();
            let tag = tagged.primary_tag().unwrap();
            assert_eq!(tag.title().as_deref(), Some("Example"));
            assert_eq!(
                tag.get_string(&ItemKey::Lyrics),
                Some("[00:00.00]Fixture lyric")
            );
            assert_eq!(
                tag.get_string(&ItemKey::Comment),
                Some("origin:netease:123 audio:qq:987 quality:lossless")
            );
            if ext == "flac" {
                assert_eq!(tagged.properties().sample_rate(), Some(192000));
                assert_eq!(tagged.properties().bit_depth(), Some(24));
                assert_eq!(
                    tag.get_string(&ItemKey::Unknown("TING_AUDIO_ID".into())),
                    Some("987")
                );
            }
        }
    }
    #[test]
    fn publication_never_overwrites_any_existing_sidecar_or_audio() {
        let dir = temp();
        let source = dir.0.join("scratch");
        std::fs::write(&source, b"test audio").unwrap();
        std::fs::write(dir.0.join("Song.json"), b"existing").unwrap();
        let first = publish(&source, &dir.0, "Song", "mp3").unwrap();
        // A successful publish may consume the scratch file on Windows.
        std::fs::write(&source, b"test audio").unwrap();
        let second = publish(&source, &dir.0, "Song", "mp3").unwrap();
        assert_ne!(first, second);
        assert_eq!(first.file_name().unwrap(), "Song (1).mp3");
        assert_eq!(std::fs::read(dir.0.join("Song.json")).unwrap(), b"existing");
        assert!(sidecar(&first, b"overwrite").is_err());
    }
    #[test]
    fn copy_publication_claims_destination_once_under_concurrency() {
        let dir = temp();
        let dest = dir.0.join("Song.mp3");
        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        let payloads = [vec![11u8; 65536], vec![22u8; 65536]];
        let threads: Vec<_> = payloads
            .iter()
            .map(|payload| {
                let payload = payload.clone();
                let gate = gate.clone();
                let dest = dest.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    copy_new(std::io::Cursor::new(payload), &dest)
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .find_map(|r| r.as_ref().err())
                .unwrap()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        let complete = std::fs::read(&dest).unwrap();
        assert!(payloads.contains(&complete));
    }
    #[test]
    fn copy_publication_removes_partial_output_but_never_an_existing_file() {
        struct FailedRead;
        impl Read for FailedRead {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("fixture read failure"))
            }
        }
        let dir = temp();
        let dest = dir.0.join("Song.mp3");
        let partial = std::io::Cursor::new(b"partial audio").chain(FailedRead);
        assert!(copy_new(partial, &dest).is_err());
        assert!(
            !dest.exists(),
            "failed copies must not appear as completed downloads"
        );
        copy_new(std::io::Cursor::new(b"complete audio"), &dest).unwrap();
        assert_eq!(
            copy_new(FailedRead, &dest).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        assert_eq!(std::fs::read(dest).unwrap(), b"complete audio");
    }
    #[test]
    fn sync_before_publish_preserves_audio_and_requires_existing_file() {
        let dir = temp();
        let path = dir.0.join("audio.flac");
        let data = b"downloaded and tagged audio";
        std::fs::write(&path, data).unwrap();
        sync_audio(&path).unwrap();
        let dest = publish(&path, &dir.0, "Song", "flac").unwrap();
        assert_eq!(std::fs::read(dest).unwrap(), data);
        let missing = dir.0.join("missing.flac");
        assert!(sync_audio(&missing).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn filenames_are_sanitized_and_bounded() {
        assert_eq!(safe_name("A/B:C*?"), "A／B：C__");
        assert_eq!(safe_name(" .. "), "_");
        assert_eq!(safe_name(&"歌".repeat(100)).chars().count(), 65);
    }
    #[test]
    fn io_error_formatter_includes_path_and_kind() {
        let path = Path::new("/tmp/ting-write-test.flac");
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let msg = format_io_error(path, &err);
        assert!(msg.starts_with(IO_ERROR));
        assert!(msg.contains("ting-write-test.flac"));
        assert!(msg.contains("PermissionDenied"));
    }
    async fn response(body: Vec<u8>, length: u64) -> reqwest::Response {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8192];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(&body);
        });
        http::client()
            .unwrap()
            .get(format!("http://{addr}/fixture"))
            .send()
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn download_checks_lengths_hash_limits_and_partial_transfers() {
        let dir = temp();
        let data = vec![42u8; 4096];
        let valid = json!({"size":4096,"md5":format!("{:x}",Md5::digest(&data))});
        write_audio_response(
            &valid,
            &dir.0.join("valid"),
            response(data.clone(), 4096).await,
        )
        .await
        .unwrap();
        for (name, plan, bytes, length) in [
            (
                "checksum",
                json!({"md5":"00000000000000000000000000000000"}),
                data.clone(),
                4096,
            ),
            ("size", json!({"size":4097}), data.clone(), 4096),
            ("truncated", valid.clone(), data[..2000].to_vec(), 4096),
            ("empty", json!({}), Vec::new(), 0),
            ("oversized", json!({}), Vec::new(), 512 * 1024 * 1024 + 1),
        ] {
            assert!(
                write_audio_response(&plan, &dir.0.join(name), response(bytes, length).await)
                    .await
                    .is_err(),
                "{name}"
            );
        }
        assert!(!dir.0.join("oversized").exists());
    }
}
