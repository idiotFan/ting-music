# Xcode 27 C ABI export compatibility

Based on the unmodified crates.io `swift-rs` 1.0.8 source archive, verified against its Cargo.lock checksum before extraction. Archive SHA256: `e45c444e496845d3f2a351146bff59aae4975b2280238df1dfaa0c7d1846f38e`. Upstream: <https://github.com/Brendonovich/swift-rs>. Original MIT and Apache-2.0 license files are retained.

The only implementation change is in `src-rs/build.rs`, inside `globalize_cdecl_symbols`: include `SwiftRs.o` alongside the current package's object when detecting internalized C exports. Xcode 27 builds Tauri's static archive with both `Tauri.o` and `SwiftRs.o`, but the upstream helper only processes `Tauri.o`. Rust consequently fails to link `retain_object`, `release_object` and `string_from_bytes`.

This extends the existing upstream Xcode 27 workaround; it does not change runtime behavior, exported function bodies, or protocol code. It still only promotes unique, plain C identifiers that are local text symbols, and requires rustup's `llvm-tools` component. Other Xcode versions skip the workaround. Remove this local Cargo patch once upstream handles bundled SwiftRs objects.

The copy omits upstream CI/repository metadata and nested Cargo.lock; library sources, tests, README, manifests, and licenses are retained. No global Cargo registry files are edited.
