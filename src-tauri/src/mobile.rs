//! iOS sharing exports the verified PNG file without image re-encoding.
use base64::{engine::general_purpose::STANDARD, Engine};

fn qr_png(data_url: &str) -> Result<Vec<u8>, String> {
    if data_url.len() > 1_500_000 {
        return Err("二维码图片过大".into());
    }
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("仅支持 PNG 二维码")?;
    let bytes = STANDARD.decode(encoded).map_err(|_| "二维码图片无效")?;
    if bytes.len() < 33 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return Err("二维码图片无效".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if !(64..=2048).contains(&width) || !(64..=2048).contains(&height) {
        return Err("二维码尺寸无效".into());
    }
    Ok(bytes)
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn share_login_qr(window: tauri::WebviewWindow, data_url: String) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::{runtime::Bool, MainThreadMarker, MainThreadOnly};
    use objc2_foundation::{NSArray, NSData, NSError, NSString, NSURL};
    use objc2_ui_kit::{UIActivityType, UIActivityViewController, UIImage, UIViewController};
    use tauri::Manager;
    let bytes = qr_png(&data_url)?;
    let cache = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|_| "临时目录不可用")?
        .join("login-qr");
    std::fs::create_dir_all(&cache).map_err(|_| "无法准备二维码文件")?;
    // Remove only our expired exports, including leftovers from an interrupted share.
    if let Ok(files) = std::fs::read_dir(&cache) {
        for entry in files.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("Ting-login-")
                && entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age.as_secs() > 600)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let path = cache.join(format!("Ting-login-{}.png", uuid::Uuid::new_v4().simple()));
    if std::fs::write(&path, &bytes).is_err() {
        let _ = std::fs::remove_file(&path);
        return Err("无法准备二维码文件".into());
    }
    let cleanup_path = path.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let dispatch = window.with_webview(move |webview| {
        let result = (|| {
            let mtm = MainThreadMarker::new().ok_or("系统分享需要主线程")?;
            // Tauri supplies this controller on the UI thread and owns its lifetime.
            let controller =
                unsafe { (webview.view_controller() as *const UIViewController).as_ref() }
                    .ok_or("当前窗口不可用")?;
            if controller.presentedViewController().is_some() {
                return Err("请先关闭当前系统面板".to_string());
            }
            let data = NSData::with_bytes(&bytes);
            // Decode only to validate. Share the original PNG URL, not a UIImage
            // that an activity could implicitly encode to a different format.
            UIImage::imageWithData(&data).ok_or("二维码图片无法读取")?;
            let file = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            let items = NSArray::from_slice(&[file.as_ref()]);
            let sheet = unsafe {
                UIActivityViewController::initWithActivityItems_applicationActivities(
                    UIActivityViewController::alloc(mtm),
                    &items,
                    None,
                )
            };
            let completed_path = path.clone();
            let completion = RcBlock::new(
                move |_: *mut UIActivityType, _: Bool, _: *mut NSArray, _: *mut NSError| {
                    let _ = std::fs::remove_file(&completed_path);
                },
            );
            unsafe {
                sheet.setCompletionWithItemsHandler(RcBlock::as_ptr(&completion) as *mut _);
            }
            // iPad requires an anchor; using the current view also follows its safe areas.
            if let Some(popover) = sheet.popoverPresentationController() {
                let view = controller.view().ok_or("当前视图不可用")?;
                popover.setSourceView(Some(&view));
                popover.setSourceRect(view.bounds());
            }
            controller.presentViewController_animated_completion(&sheet, true, None);
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        let _ = send.send(result);
    });
    if dispatch.is_err() {
        let _ = std::fs::remove_file(cleanup_path);
        return Err("无法打开系统分享面板".into());
    }
    match receive.await {
        Ok(result) => result,
        Err(_) => {
            let _ = std::fs::remove_file(cleanup_path);
            Err("系统分享面板已关闭".into())
        }
    }
}

#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub async fn share_login_qr(data_url: String) -> Result<(), String> {
    let _ = qr_png(&data_url)?;
    Err("此平台请使用系统浏览器的图片分享功能".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_image_rejects_non_png_oversize_and_unbounded_dimensions() {
        assert!(qr_png("https://example.com/image.png").is_err());
        assert!(qr_png(&"a".repeat(1_500_001)).is_err());
        let mut bytes = vec![0; 33];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        bytes[20..24].copy_from_slice(&256u32.to_be_bytes());
        assert!(qr_png(&format!(
            "data:image/png;base64,{}",
            STANDARD.encode(&bytes)
        ))
        .is_err());
        bytes[16..20].copy_from_slice(&256u32.to_be_bytes());
        // This parser only bounds input; UIKit validates the full encoded image.
        assert_eq!(
            qr_png(&format!(
                "data:image/png;base64,{}",
                STANDARD.encode(&bytes)
            ))
            .unwrap(),
            bytes
        );
    }
}
