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

Ting has not selected a single license for its own source. Dependency licenses remain authoritative. JavaScript packages are locked in `package-lock.json`; Rust packages in `src-tauri/Cargo.lock`.

Version 0.9.0 no longer bundles CPython, QQMusicApi, requests, mutagen, miniaudio or Python wheels. The earlier integration remains available in the v0.8.0 source history.

## Protocol reference

The new Rust QQ adapter uses [L-1124/QQMusicApi 0.7.3](https://github.com/L-1124/QQMusicApi) as a protocol reference for endpoint names, request fields and QR authorization states. QQMusicApi is GPL-3.0-or-later. Its Python implementation and compatibility patch are no longer shipped. The Rust adapter preserves WEB/DESKTOP membership fields and uses the service's plain Base64 LRC response rather than translating the QRC cipher.

## Native audio and other dependencies

- Symphonia 0.5.5: MPL-2.0. Used unmodified for full-stream FLAC/MP3 verification. Source: https://github.com/pdeljanov/Symphonia/tree/6d533f26150953a882a6a111ebd13f0abf7129d5 . License is included in `resources/licenses/Symphonia-MPL-2.0.txt`.
- Lofty 0.22.4: MIT OR Apache-2.0. Used for audio properties and metadata. Source: https://github.com/Serial-ATA/lofty-rs/tree/d9eb83ba614001973f9ba3663c9f3e10dd27a702 . Both license texts are included in `resources/licenses/`.
- Unicode normalization / case folding: MIT OR Apache-2.0, per locked crate metadata.
- Tauri and security-framework: MIT / Apache-2.0.
- Lucide: ISC. QRCode (node-qrcode): MIT. jsQR: Apache-2.0.

Transitive dependency notices are supplied with their upstream packages. FFmpeg is only used to generate synthetic regression fixtures on development machines; it is neither bundled nor invoked by Ting. Python 3 remains optional development tooling for release packaging and credential scans, not an application dependency.

## swift-rs compatibility copy

`src-tauri/compat/swift-rs` retains upstream swift-rs 1.0.8 under MIT OR Apache-2.0, with one documented Xcode 27 build-helper change. Original license texts and attribution are included beside the source; see `TING-PATCH.md`. Upstream: https://github.com/Brendonovich/swift-rs.
