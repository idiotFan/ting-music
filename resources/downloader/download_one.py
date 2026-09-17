"""Resolve/download one track using only a Ting session explicitly passed over stdin."""
import sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / "vendor"), str(HERE)]

import contextlib
import hashlib
import io
import json
import os
import tempfile
import time
import requests
import miniaudio
from mutagen import File as AudioFile
import library_tools as lib
from library_tools import DownloadError

RANK = {"jymaster": 6, "hires": 5, "lossless": 4, "exhigh": 3, "higher": 2, "standard": 1}


def ncm_with_cookie(cookie):
    return lib.NCM(cookie)


def highest(ncm, sid):
    best = None
    for level in ("jymaster", "hires", "lossless", "exhigh", "higher", "standard"):
        data = ncm.post("/api/song/enhance/player/url/v1", ids=json.dumps([sid]), level=level,
                        encodeType="flac" if RANK[level] >= 4 else "mp3")
        audio = (data.get("data") or [{}])[0]
        if not audio.get("url") or audio.get("freeTrialInfo"):
            continue
        if best is None or (RANK.get(audio.get("level"), 0), audio.get("br", 0)) > (RANK.get(best.get("level"), 0), best.get("br", 0)):
            best = audio
        if RANK.get(audio.get("level"), 0) >= RANK[level]:
            break
    return best


def prepare(request):
    """Resolve NetEase first; Rust obtains any QQ fallback from its current session."""
    sid = int(request["id"])
    if sid <= 0:
        raise DownloadError("请选择在线歌曲")
    ncm = ncm_with_cookie(request.get("cookie", ""))
    try:
        songs = ncm.details([sid])
        song = next((song for song in songs if int(song.get("id", 0)) == sid), None)
        if not song:
            raise DownloadError("无法读取歌曲信息，请检查网易云登录状态")
        artists = [artist["name"] for artist in song["ar"] if artist.get("name")]
        if not artists or song.get("dt", 0) <= 0:
            raise DownloadError("歌曲信息不完整，无法安全匹配音源")
        audio = highest(ncm, sid)
        lyric = ""
        try:
            lyric, _ = ncm.lyric(sid)
        except Exception:
            pass
        return {"song": {"id": sid, "source": "netease", "name": song["name"], "duration": song["dt"],
                         "artist": " / ".join(artists), "album": song["al"].get("name", ""),
                         "cover": song["al"].get("picUrl", "")},
                "artists": artists, "year": time.strftime("%Y", time.gmtime(song["publishTime"] / 1000)) if song.get("publishTime") else "",
                "lyric": lyric, "playback": ({"url": audio["url"], "format": audio.get("type"),
                    "level": audio.get("level"), "size": audio.get("size"), "md5": audio.get("md5"), "trial": False} if audio else None)}
    finally:
        ncm.close()


def fetch_audio(url, path, expected, expected_md5=None):
    limit = 512 * 1024 * 1024
    with requests.Session() as session:
        session.trust_env = False
        with lib.open_cdn(session, url) as response:
            length = int(response.headers.get("Content-Length", 0))
            if length > limit:
                raise DownloadError("单曲超过 512 MB")
            count = 0
            checksum = hashlib.md5()
            started = time.monotonic()
            with open(path, "xb") as dest:
                for chunk in response.iter_content(65536):
                    count += len(chunk)
                    if count > limit:
                        raise DownloadError("单曲超过 512 MB")
                    if time.monotonic() - started > 480:
                        raise DownloadError("下载超时，请重试")
                    checksum.update(chunk)
                    dest.write(chunk)
                dest.flush()
                os.fsync(dest.fileno())
            if count < 1000 or (length and count != length) or (expected and count != int(expected)):
                raise DownloadError("下载文件不完整")
            if expected_md5 and checksum.hexdigest().lower() != expected_md5.lower():
                raise DownloadError("下载文件校验和不符")


def validate_audio(path, duration_ms):
    """Decode every frame in bounded memory; reject truncated streams before publish."""
    audio = AudioFile(path)
    if audio is None or not audio.info or audio.info.length <= 0:
        raise DownloadError("音频校验失败")
    info = audio.info
    if abs(info.length - duration_ms / 1000) > 2:
        raise DownloadError("下载时长与歌曲不符，未保存，避免误存试听或其他版本")
    if path.suffix == ".flac" and not isinstance(audio, lib.FLAC):
        raise DownloadError("返回的音频格式与音源信息不符")
    if path.suffix == ".mp3":
        from mutagen.mp3 import MP3
        if not isinstance(audio, MP3):
            raise DownloadError("返回的音频格式与音源信息不符")
    channels = info.channels
    sample_rate = info.sample_rate
    if channels < 1 or channels > 8 or sample_rate <= 0 or sample_rate > 768000:
        raise DownloadError("音频参数不受支持")
    frames = 0
    started = time.monotonic()
    try:
        stream = miniaudio.stream_file(str(path), nchannels=channels, sample_rate=sample_rate, frames_to_read=1024)
        with contextlib.closing(stream):
            for samples in stream:
                frames += len(samples) // channels
                if time.monotonic() - started > 120:
                    raise DownloadError("音频校验超时，请重试")
        # A decoder may withhold its last partial block. MP3 may also discard encoder delay.
        tolerance = max(2048 / sample_rate, 0.10 if path.suffix == ".mp3" else 0)
        if frames <= 0 or abs(frames / sample_rate - info.length) > tolerance:
            raise DownloadError("音频数据不完整，未保存")
    except DownloadError:
        raise
    except Exception:
        raise DownloadError("音频完整解码失败，未保存") from None
    return audio


def validate_info(info, sid=None):
    song = info.get("song") or {}
    audio = info.get("playback") or {}
    if (not song.get("id") or (sid is not None and int(song["id"]) != sid)
            or audio.get("trial") or not audio.get("url") or audio.get("format") not in ("mp3", "flac")):
        raise DownloadError("音乐平台没有返回完整可下载音源")
    if audio.get("level") not in (*RANK.keys(), "master"):
        raise DownloadError("音质信息无效")
    if song.get("duration", 0) <= 0 or not song.get("name") or not info.get("artists"):
        raise DownloadError("歌曲信息不完整，无法安全下载")
    return song, audio


def run(request):
    sid = int(request["id"])
    requested_source = request.get("source", "netease")
    if sid <= 0 or requested_source not in ("netease", "qq"):
        raise DownloadError("请选择支持平台的在线歌曲")
    info = request.get("info") or {}
    fallback = request.get("fallback")
    if fallback:
        if requested_source != "netease" or int((info.get("song") or {}).get("id", 0)) != sid:
            raise DownloadError("补源信息无效")
        audio_song, audio = validate_info(fallback)
        song = info["song"]
        source = "qq"
    else:
        song, audio = validate_info(info, sid)
        audio_song = song
        source = requested_source
    artists = info["artists"]
    ext = audio["format"]
    folder = Path(request["out"])
    folder.mkdir(parents=True, exist_ok=True)
    meta = {"id": sid, "originSource": requested_source, "audioId": int(audio_song["id"]),
            "title": song["name"], "artists": artists, "album": song.get("album", ""),
            "album_artist": artists[0], "year": str(info.get("year") or ""), "index": 1,
            "total": 1, "source": source, "level": audio["level"]}
    warnings = []
    # Rust owns the outer scratch directory and removes it even when the child is killed.
    scratch_parent = Path(request["scratch"]) if request.get("scratch") else folder
    with tempfile.TemporaryDirectory(prefix=".ting-", dir=scratch_parent) as scratch:
        tmp = Path(scratch) / f"audio.{ext}"
        fetch_audio(audio["url"], tmp, audio.get("size"), audio.get("md5"))
        validate_audio(tmp, song["duration"])
        cover = lib.fetch_cover(song.get("cover"))
        lrc = info.get("lyric") or ""
        if not cover:
            warnings.append("封面暂不可用")
        if not lrc:
            warnings.append("歌词暂不可用")
        lib.tag_file(tmp, meta, cover, lrc)
        verified = AudioFile(tmp)
        if verified is None or not verified.tags:
            raise DownloadError("歌曲标签校验失败")
        audio_info = verified.info
        stem = lib.safe(f"{song['name']} - {' & '.join(artists)}")[:65] + (f" [QQ-{sid}]" if requested_source == "qq" else f" [{sid}]")
        for number in range(1000):
            name = stem + (f" ({number})" if number else "")
            dest = folder / f"{name}.{ext}"
            if any((folder / f"{name}.{suffix}").exists() for suffix in ("json", "lrc", "mp3", "flac")):
                continue
            try:
                os.link(tmp, dest)
                break
            except FileExistsError:
                continue
        else:
            raise DownloadError("同名文件过多")
        if lrc:
            try:
                with (folder / f"{name}.lrc").open("x", encoding="utf-8") as sidecar:
                    sidecar.write(lrc)
            except OSError:
                warnings.append("歌词文件写入失败")
        result = {"filename": dest.name, "path": str(dest), "source": source, "level": meta["level"],
                  "format": ext, "bytes": dest.stat().st_size, "bitrate": getattr(audio_info, "bitrate", 0),
                  "sampleRate": getattr(audio_info, "sample_rate", 0), "bitDepth": getattr(audio_info, "bits_per_sample", 0),
                  "cover": bool(cover), "lyrics": bool(lrc), "warnings": warnings}
        provenance = {"origin": {"platform": requested_source, "id": sid},
                      "audio": {"platform": source, "id": int(audio_song["id"])}}
        try:
            with (folder / f"{name}.json").open("x", encoding="utf-8") as sidecar:
                json.dump({**result, **provenance, "title": song["name"], "artists": artists}, sidecar, ensure_ascii=False, indent=2)
        except OSError:
            warnings.append("来源记录写入失败")
        return result


def public_error(exc):
    if isinstance(exc, DownloadError):
        return str(exc)
    if isinstance(exc, requests.RequestException):
        return "音源请求失败，请检查网络与 Ting 当前登录状态"
    if isinstance(exc, OSError):
        return "下载文件无法写入，请检查磁盘空间和目录权限"
    return "音源请求或音频校验失败，请检查网络与 Ting 当前登录状态"


if __name__ == "__main__":
    os.umask(0o077)
    try:
        request = json.load(sys.stdin)
        with contextlib.redirect_stdout(io.StringIO()):
            result = prepare(request) if request.get("operation") == "prepare" else run(request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": public_error(exc)}, ensure_ascii=False))
        sys.exit(1)
