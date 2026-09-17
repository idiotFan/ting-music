"""Small download helpers. Sessions are explicit; no account files are read."""
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import urljoin, urlparse
import json
import re

import requests
from mutagen.flac import FLAC, Picture
from mutagen.id3 import ID3, APIC, COMM, TIT2, TPE1, TALB, TPE2, TRCK, TDRC, USLT, ID3NoHeaderError

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36"


class DownloadError(Exception):
    """Only application-owned messages of this type may be displayed to users."""


def safe(name):
    name = name.replace(":", "：").replace("/", "／")
    name = re.sub(r'[\\*?"<>|\x00-\x1f\x7f]', "_", name).strip().rstrip(".")
    return re.sub(r"\s+", " ", name)[:120] or "_"


class NCM:
    def __init__(self, cookie):
        parsed = SimpleCookie()
        parsed.load(cookie or "")
        self.s = requests.Session()
        self.s.trust_env = False  # Ignore ~/.netrc and ambient proxy credentials.
        for key, value in parsed.items():
            self.s.cookies.set(key, value.value, domain="music.163.com")
        self.csrf = parsed["__csrf"].value if "__csrf" in parsed else ""
        self.s.headers.update({"User-Agent": UA, "Referer": "https://music.163.com/"})

    def close(self):
        self.s.close()

    def post(self, path, **params):
        params["csrf_token"] = self.csrf
        response = self.s.post("https://music.163.com" + path, data=params, timeout=(10, 20), allow_redirects=False)
        response.raise_for_status()
        if response.is_redirect:
            raise DownloadError("网易云接口地址发生变化，请稍后重试")
        data = response.json()
        if data.get("code") in (405, -460, 8810):
            raise DownloadError("网易云请求过于频繁，请稍后重试")
        return data

    def details(self, ids):
        data = self.post("/api/v3/song/detail", c=json.dumps([{"id": value} for value in ids]))
        return data.get("songs") or []

    def lyric(self, sid):
        data = self.post("/api/song/lyric", id=sid, lv=-1, tv=-1, rv=-1, kv=-1)
        lyric = (data.get("lrc") or {}).get("lyric") or ""
        return (lyric if re.search(r"\[\d+:\d+", lyric) else ""), ""


def trusted_url(url, artwork=False):
    """A CDN request must never leave the known HTTPS origins, including redirects."""
    parsed = urlparse(url)
    suffixes = (".music.126.net", ".music.163.com", ".qq.com")
    if artwork:
        suffixes += (".gtimg.cn",)
    return (parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and bool(parsed.hostname)
            and any(parsed.hostname.endswith(suffix) for suffix in suffixes))


def open_cdn(session, url, artwork=False):
    if url.startswith("http://"):
        url = "https://" + url[7:]
    for _ in range(6):
        if not trusted_url(url, artwork):
            raise DownloadError("音源返回了非预期下载地址")
        response = session.get(url, stream=True, timeout=(10, 30), allow_redirects=False)
        if response.is_redirect:
            url = urljoin(url, response.headers.get("Location", ""))
            response.close()
            continue
        response.raise_for_status()
        return response
    raise DownloadError("音源重定向过多")


def fetch_cover(pic_url):
    """Artwork is optional and always fetched without account cookies."""
    if not pic_url:
        return None
    try:
        with requests.Session() as session:
            session.trust_env = False
            with open_cdn(session, pic_url, artwork=True) as response:
                chunks = bytearray()
                for chunk in response.iter_content(65536):
                    chunks.extend(chunk)
                    if len(chunks) > 8 * 1024 * 1024:
                        return None
                data = bytes(chunks)
                if data[:3] == b"\xff\xd8\xff" and jpeg_dims(data)[0] > 0:
                    return data
    except Exception:
        pass
    return None


def jpeg_dims(data):
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[i + 7:i + 9], "big"), int.from_bytes(data[i + 5:i + 7], "big")
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = int.from_bytes(data[i + 2:i + 4], "big")
        if length < 2:
            break
        i += 2 + length
    return 0, 0


def tag_file(path: Path, meta, cover, lrc):
    provenance = (f"origin:{meta['originSource']}:{meta['id']} "
                  f"audio:{meta['source']}:{meta['audioId']} quality:{meta['level']}")
    if path.suffix == ".flac":
        tags = FLAC(path)
        tags.delete()
        tags["TITLE"] = meta["title"]
        tags["ARTIST"] = meta["artists"]
        tags["ALBUM"] = meta["album"]
        tags["ALBUMARTIST"] = meta["album_artist"] or meta["artists"][0]
        tags["TRACKNUMBER"] = str(meta["index"])
        tags["TRACKTOTAL"] = str(meta["total"])
        if meta["year"]:
            tags["DATE"] = meta["year"]
        tags["COMMENT"] = provenance
        tags["TING_ORIGIN_PLATFORM"] = meta["originSource"]
        tags["TING_ORIGIN_ID"] = str(meta["id"])
        tags["TING_AUDIO_PLATFORM"] = meta["source"]
        tags["TING_AUDIO_ID"] = str(meta["audioId"])
        if lrc:
            tags["LYRICS"] = lrc
        tags.clear_pictures()
        if cover:
            picture = Picture()
            picture.type = 3
            picture.mime = "image/jpeg"
            picture.data = cover
            picture.width, picture.height = jpeg_dims(cover)
            picture.depth = 24
            picture.desc = "Cover"
            tags.add_picture(picture)
        tags.save()
    else:
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()
        tags.delete(path)
        tags = ID3()
        tags.add(TIT2(encoding=3, text=meta["title"]))
        tags.add(TPE1(encoding=3, text="/".join(meta["artists"])))
        tags.add(TALB(encoding=3, text=meta["album"]))
        tags.add(TPE2(encoding=3, text=meta["album_artist"] or meta["artists"][0]))
        tags.add(TRCK(encoding=3, text=f"{meta['index']}/{meta['total']}"))
        tags.add(COMM(encoding=3, lang="und", desc="Ting source", text=provenance))
        if meta["year"]:
            tags.add(TDRC(encoding=3, text=meta["year"]))
        if lrc:
            tags.add(USLT(encoding=3, lang="und", desc="", text=lrc))
        if cover:
            tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))
        tags.save(path, v2_version=3)
