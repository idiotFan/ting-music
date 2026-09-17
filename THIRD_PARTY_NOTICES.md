# Third-party notices

## go-musicfox/netease-music

Repository: https://github.com/go-musicfox/netease-music
Reference commit: 912f2cf2b8bf772c804c6cd4b4f31f11773c7b93

The Rust API adapter follows protocol behavior from `util/cryto.go`, `service/search_service.go`, `service/song_url_v1_service.go`, `service/lyric_service.go`, `service/login_qr_service.go`, `service/user_account_service.go`, `service/user_playlist_service.go`, `service/playlist_detail_service.go`, and `service/song_detail_service.go`. It is independently implemented. No GPL go-musicfox client code is included.

Upstream MIT license (verbatim):

```text
Copyright (c) 2011-2017 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Project licensing and dependency records

Ting has not yet selected a single license for its own source code. Publishing this repository does not assign a new license to Ting or replace the licenses of its dependencies. The notices below identify the components used by version 0.8.0; the license texts shipped by those components remain authoritative.

JavaScript versions are locked in `package-lock.json`; Rust versions are locked in `src-tauri/Cargo.lock`. Python versions are pinned in `resources/qq/requirements.txt` and `resources/downloader/requirements.txt`, with official PyPI distribution hashes recorded in `scripts/dependencies-lock.json`. Generated `vendor/` and `resources/python/` directories are excluded from Git and included in prepared application bundles.

## Frontend and Rust dependencies

- Tauri: MIT / Apache-2.0.
- Lucide: ISC.
- QRCode (`node-qrcode`): MIT.
- jsQR: Apache-2.0.
- `security-framework`: MIT / Apache-2.0.

Other direct and transitive dependency notices are provided by their packages. Preserve the upstream license and notice files when preparing or redistributing a bundle.

## QQMusicApi 0.7.3

Source: [L-1124/QQMusicApi](https://github.com/L-1124/QQMusicApi). The installed `qqmusic_api_python-0.7.3.dist-info/METADATA` identifies GPL-3.0-or-later; its full license is retained in `licenses/LICENSE` under that metadata directory.

The library is installed into `resources/qq/vendor/qqmusic_api` by `scripts/prepare-resources.py`. Ting's integration is in `resources/qq/bridge.py` and `src-tauri/src/qq.rs`.

The reproducible local compatibility patch in `core/versioning.py` carries the current credential's `authst` and `tmeLoginType` in WEB / DESKTOP CGI requests, alongside the existing UIN and CSRF fields. This prevents authenticated song URL requests from losing their membership session. The adapter also preserves song type, selects quality independently of response ordering, and uses the current Ting account for download matching. Tests use dummy credentials; no account cookies or credentials are distributed.

The exact patch is maintained in the preparation script and verified before builds. This repository does not describe the generated QQMusicApi dependency as unmodified upstream code.

## Download and audio verification dependencies

`resources/downloader/library_tools.py` now contains explicit-session NetEase requests, restricted artwork fetching and metadata writing. The old standalone music-library CLI and implicit reads of musicfox credential files have been removed. `download_one.py` uses download plans supplied by the Rust backend and validates files before publishing them.

The following licenses were checked against the installed pinned packages' metadata and license files:

| Component | Version | License | Retained license file under `resources/downloader/vendor/` |
| --- | --- | --- | --- |
| requests | 2.33.0 | Apache-2.0 | `requests-2.33.0.dist-info/licenses/LICENSE`, `NOTICE` |
| mutagen | 1.47.0 | GPL-2.0-or-later | `mutagen-1.47.0.dist-info/COPYING` |
| miniaudio Python bindings | 1.71 | MIT | `miniaudio-1.71.dist-info/licenses/LICENSE` |
| cffi | 2.1.1 | MIT-0, subject to component-specific notices | `cffi-2.1.1.dist-info/licenses/LICENSE` |
| pycparser | 3.0 | BSD-3-Clause | `pycparser-3.0.dist-info/licenses/LICENSE` |

miniaudio provides the bundled native FLAC / MP3 decoder used for bounded-memory, full-stream validation. Its retained MIT license names the Python bindings copyright holder Irmen de Jong, miniaudio copyright holder David Reid, and stb_vorbis copyright holder Sean Barrett. It is used without requiring a system FFmpeg installation. FFmpeg is only a developer-test tool for generating synthetic audio fixtures; Ting does not bundle it or invoke it during normal application use.

Other HTTP, cryptography and runtime dependencies retain their package metadata, license files and notices in the generated vendor directories. Requirements files and the hash lock identify their exact versions.

## Bundled CPython 3.12.14

The macOS Apple Silicon runtime comes from the official [Astral python-build-standalone](https://github.com/astral-sh/python-build-standalone) release `20260901`, target `aarch64-apple-darwin`. `scripts/runtime-lock.json` records the precise asset URL, byte count and SHA256. The preparation script verifies the archive before extraction and execution.

CPython's retained license is `resources/python/lib/python3.12/LICENSE.txt`. That file specifies the Python Software Foundation License Version 2, preserves the historical Python license agreements and explains that incorporated software can have different licenses. The PSF license is not a blanket replacement for every component shipped in the standalone runtime.

The prepared runtime also retains pip's license at `resources/python/lib/python3.12/site-packages/pip-26.2.1.dist-info/licenses/LICENSE.txt` and the vendored dependency licenses supplied with pip. Runtime source and build information are available from the linked official standalone project and the exact release recorded in the lock file. Keep the supplied runtime and package notices when redistributing the prepared application.
