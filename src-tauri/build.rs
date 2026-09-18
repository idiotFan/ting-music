fn main() {
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target == "macos" || target == "ios" {
        cc::Build::new()
            .file("native/folder_sync.m")
            .file("native/media_controls.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("ting_folder_sync");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=MediaPlayer");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rerun-if-changed=native/media_controls.m");
        println!(
            "cargo:rustc-link-lib=framework={}",
            if target == "ios" { "UIKit" } else { "AppKit" }
        );
        if target == "ios" {
            println!("cargo:rustc-link-lib=framework=UniformTypeIdentifiers");
        }
        println!("cargo:rerun-if-changed=native/folder_sync.m");
    }
    tauri_build::build()
}
