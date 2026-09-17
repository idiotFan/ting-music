# Rust migration and iOS first build (0.9.0)

QQ Music networking and music downloads run in Rust. The app no longer launches Python, bundles CPython, installs Python wheels, or invokes FFmpeg. FFmpeg is a development-test dependency only; Python 3 is used by optional release/security tooling, not the app.

## Preserved behavior

- QQ / WeChat QR challenge and polling, login refresh, backend-only credentials and Keychain persistence. The credential schema accepts both earlier Ting snake_case keys and platform camelCase aliases. A temporary network failure does not erase a saved login.
- QQ search, created/favorite playlists, paging, ownership-checked track add/remove, LRC, actual quality priority, media MID and song type. WEB and desktop requests carry membership credentials. Vkey GUIDs are full 32-character UUIDs.
- Both current account sessions remain isolated. NetEase-to-QQ fallback requires a unique matching recording and verifies the authoritative details again.
- Downloads use a cookie-free, proxy-free client; validate every redirect; enforce size, length and available MD5 checks; decode the entire FLAC/MP3 stream before publication. MP3 also checks individual frame boundaries. Files keep their actual format, metadata, artwork, lyrics and both origin/audio IDs; atomic no-clobber publication preserves existing files.
- Blocking audio work has bounded time and owns the scratch-directory and single-download guard. Canceling its caller prevents publication after validation and leaves cleanup with the worker.

## Regression coverage

Native tests cover credentials/aliases, quality ordering, trusted origins, membership parameters, ownership before writes, server-authoritative song types, playlist deduplication, ambiguous fallback rejection, malformed/error response redaction, transfer limits/checksums/interruption, 192 kHz / 24-bit FLAC, MP3, truncation (including final-byte truncation), corrupt frames, wrong durations, tags and no-overwrite behavior. Network mocks listen only on loopback; production endpoints remain fixed.

Read-only live tests are explicitly opt-in. The saved-member test loads the local Keychain in memory and never prints credentials, profile data or signed URLs. Cloud playlist writes and completion of a fresh QR login are not performed by regression tests.

## iOS build

Requires full Xcode, CocoaPods, XcodeGen, Rust iOS targets and an Apple development identity. Xcode 27 internalizes C exports in both Tauri and its SwiftRs dependency. The local `src-tauri/compat/swift-rs` Cargo patch extends the upstream 1.0.8 build helper to handle the bundled SwiftRs object; see its TING-PATCH.md. It needs rustup’s `llvm-tools` component. No global Cargo registry is modified.

```sh
npm ci
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
rustup component add llvm-tools
npm run tauri -- ios init --ci --skip-targets-install
export TAURI_APPLE_DEVELOPMENT_TEAM=YOURTEAMID
node scripts/prepare-ios.mjs
node scripts/preflight.mjs
npm run tauri -- ios build --ci --export-method debugging -- --locked
```

The generated Xcode project and signing identity stay outside Git. `prepare-ios.mjs` makes the generated deployment target and command path reproducible. iOS uses the existing app identifier, but credentials remain on that iPhone; no Mac session is copied to the phone.

`Info.ios.plist` declares `UIApplicationSceneManifest` with `UIApplicationSupportsMultipleScenes=true`: Tao 0.35 uses that flag to register its built-in scene delegate. Without it, an iOS 27 SDK build traps at startup in `UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. This setting enables the scene lifecycle; multiple-window behavior on iPad remains unvalidated. See [Apple’s migration requirement](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle).

Phone adaptation includes safe areas, a full-window lyrics sheet, no desktop window resizing, and iOS Keychain persistence. Downloads use Documents/Ting in the app sandbox, exposed through Files sharing. Playback currently uses WKWebView audio. Native background playback, lock-screen controls and an on-device alternative to scanning a QR displayed on the same phone remain future work. This is a device-test build, not an App Store release.
