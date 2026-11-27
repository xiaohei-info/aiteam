//! Files copied in Finder / Explorer, as paths.
//!
//! The WebView hands a pasted file to the page as bytes (`File`), which would have to be copied
//! through IPC and capped in size. A dropped file arrives as a path instead. Reading the paths of
//! copied files straight from the system clipboard lets paste take the very same route as drop.

/// `file://` URLs → local paths; anything that is not a local file URL is skipped.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn paths_from_file_urls<I: IntoIterator<Item = String>>(urls: I) -> Vec<String> {
    urls.into_iter()
        .filter_map(|raw| url::Url::parse(raw.trim()).ok())
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[cfg(target_os = "macos")]
fn clipboard_file_paths() -> Vec<String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    let Some(items) = pasteboard.pasteboardItems() else { return Vec::new() };
    let file_url = NSString::from_str("public.file-url");
    paths_from_file_urls(
        items
            .iter()
            .filter_map(|item| item.stringForType(&file_url))
            .map(|raw| resolve_file_reference(&raw).unwrap_or_else(|| raw.to_string())),
    )
}

/// Finder puts a file *reference* URL on the clipboard (`file:///.file/id=6571367.61373793`),
/// which names the file by inode, not by path. Ask Foundation for the real path behind it; a plain
/// `file:///Users/...` URL comes back unchanged.
#[cfg(target_os = "macos")]
fn resolve_file_reference(raw: &objc2_foundation::NSString) -> Option<String> {
    use objc2_foundation::NSURL;

    let url = NSURL::URLWithString(raw)?;
    let resolved = url.filePathURL()?;
    resolved.absoluteString().map(|s| s.to_string())
}

#[cfg(windows)]
fn clipboard_file_paths() -> Vec<String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    // SAFETY: the clipboard is opened and closed on this thread; the HDROP handle is only read
    // while the clipboard is open, and each buffer is sized from DragQueryFileW's own length.
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP as u32) == 0 || OpenClipboard(std::ptr::null_mut()) == 0 {
            return Vec::new();
        }
        let handle = GetClipboardData(CF_HDROP as u32);
        let mut paths = Vec::new();
        if !handle.is_null() {
            let drop = handle as HDROP;
            let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
            for index in 0..count {
                let len = DragQueryFileW(drop, index, std::ptr::null_mut(), 0);
                let mut buffer = vec![0u16; len as usize + 1];
                let written = DragQueryFileW(drop, index, buffer.as_mut_ptr(), buffer.len() as u32);
                if written > 0 {
                    paths.push(String::from_utf16_lossy(&buffer[..written as usize]));
                }
            }
        }
        CloseClipboard();
        paths
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn clipboard_file_paths() -> Vec<String> {
    Vec::new()
}

/// Paths of the files on the system clipboard; empty when it holds no copied files.
///
/// Copying a file in Finder/Explorer and pasting it is the user handing that file over, exactly like
/// dropping it: the paths are allowed the same way Tauri's own drag-and-drop handler allows dropped
/// ones, so a paste no longer fails on a folder the user never authorized for scanning.
#[tauri::command]
pub fn read_clipboard_file_paths(app: tauri::AppHandle) -> Vec<String> {
    let paths = clipboard_file_paths();
    let scope = tauri::Manager::asset_protocol_scope(&app);
    for path in &paths {
        // Only files: a copied folder is refused later with its own message, and must not widen the scope.
        if std::path::Path::new(path).is_file() {
            let _ = scope.allow_file(path);
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::paths_from_file_urls;

    #[test]
    fn decodes_file_urls_and_skips_everything_else() {
        let paths = paths_from_file_urls([
            "file:///Users/me/Downloads/cc-haha-main.zip".to_string(),
            "file:///Users/me/%E6%96%87%E7%A8%BF/a%20b.pdf".to_string(),
            "https://example.com/x.zip".to_string(),
            "not a url".to_string(),
        ]);
        assert_eq!(paths, ["/Users/me/Downloads/cc-haha-main.zip", "/Users/me/文稿/a b.pdf"]);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::{paths_from_file_urls, resolve_file_reference};
    use objc2_foundation::{NSString, NSURL};

    #[test]
    fn resolves_a_finder_file_reference_url_to_its_path() {
        let dir = std::env::temp_dir().join("clipboard_files_ref_test 中文");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a b.zip");
        std::fs::write(&file, b"x").unwrap();
        let file = file.canonicalize().unwrap();

        let reference = NSURL::fileURLWithPath(&NSString::from_str(file.to_str().unwrap()))
            .fileReferenceURL()
            .and_then(|url| url.absoluteString())
            .unwrap();
        assert!(reference.to_string().starts_with("file:///.file/id="), "{reference}");

        let resolved = resolve_file_reference(&reference).unwrap();
        assert_eq!(paths_from_file_urls([resolved]), [file.to_string_lossy().into_owned()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
