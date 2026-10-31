use flate2::read::DeflateDecoder;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{Emitter, Manager};

const PREVIEW_MAX_CHARS: usize = 30_000;

fn canonicalize_existing(path: &Path, description: &str) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| crate::file_access::io_error(Path::new(description), error))
}

fn ensure_regular_file(path: &Path, description: &str) -> Result<(), String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("Failed to inspect {description}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("Not a regular file: {description}"));
    }
    Ok(())
}

/// Native directory grants are persisted separately from WebView asset access.
/// Explicit single-file picker grants remain valid for attachment workflows.
fn canonicalize_scoped_path(
    app: &tauri::AppHandle,
    raw_path: &str,
    expect_directory: bool,
) -> Result<PathBuf, String> {
    let canonical = canonicalize_existing(Path::new(raw_path), raw_path)?;
    let metadata = canonical
        .metadata()
        .map_err(|error| crate::file_access::io_error(&canonical, error))?;
    if expect_directory && !metadata.is_dir() {
        return Err(format!("Not a directory: {raw_path}"));
    }
    if !expect_directory && !metadata.is_file() {
        return Err(format!("Not a regular file: {raw_path}"));
    }
    if !crate::file_access::is_allowed(app, &canonical)?
        && !app.asset_protocol_scope().is_allowed(&canonical)
    {
        return Err(format!(
            "LOCAL_ACCESS_REQUIRED: 目录访问权限已失效：{raw_path}。请重新从系统选择器授权该目录后再扫描。"
        ));
    }
    Ok(canonical)
}

pub(crate) fn validate_path_segment(value: &str, description: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    let is_single_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    let has_forbidden_windows_character = value.chars().any(|character| {
        matches!(
            character,
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
        )
    });
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.chars().any(char::is_control)
        || has_forbidden_windows_character
        || !is_single_normal_component
    {
        return Err(format!("Invalid {description}"));
    }
    Ok(())
}

fn validate_cached_relative_path(rel_path: &Path) -> Result<(), String> {
    if rel_path.is_absolute() {
        return Err("Invalid cached file path".to_string());
    }
    let components = rel_path.components().collect::<Vec<_>>();
    if components.len() != 4
        || !components
            .iter()
            .all(|component| matches!(component, Component::Normal(_)))
        || components[2].as_os_str() != "file"
    {
        return Err("Invalid cached file path".to_string());
    }
    Ok(())
}

fn resolve_cached_path_from_root(app_data: &Path, rel_path: &Path) -> Result<PathBuf, String> {
    validate_cached_relative_path(rel_path)?;
    let canonical_root = canonicalize_existing(app_data, "app data directory")?;
    let joined = canonical_root.join(rel_path);
    let canonical_file = canonicalize_existing(&joined, "cached file")?;
    ensure_regular_file(&canonical_file, "cached file")?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err("Cached file path escapes the app data directory".to_string());
    }
    Ok(canonical_file)
}

fn resolve_cached_file_path(app: &tauri::AppHandle, rel_path: &str) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve app data dir: {error}"))?;
    resolve_cached_path_from_root(&app_data, Path::new(rel_path))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CachedFile {
    pub rel_path: String,
    pub asset_url: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

#[tauri::command]
pub fn cache_file(
    app: tauri::AppHandle,
    user_id: String,
    chat_id: String,
    src_path: String,
) -> Result<CachedFile, String> {
    validate_path_segment(&user_id, "user id")?;
    validate_path_segment(&chat_id, "chat id")?;
    let src = canonicalize_scoped_path(&app, &src_path, false)?;
    let file_name = src
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Source file has no valid name".to_string())?
        .to_string();

    let size = src.metadata().map_err(|e| e.to_string())?.len();

    let mime = {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        mime_for_ext(&ext)
    };

    // Prepend a short UUID prefix to avoid collisions when the same filename
    // is sent multiple times, while keeping the display name readable on disk.
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let cached_name = match file_name.rfind('.') {
        Some(i) => format!("{}_{}.{}", &file_name[..i], suffix, &file_name[i + 1..]),
        None => format!("{file_name}_{suffix}"),
    };

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&app_data).map_err(|e| e.to_string())?;
    let canonical_app_data = canonicalize_existing(&app_data, "app data directory")?;
    let dest_dir = app_data.join(&user_id).join(&chat_id).join("file");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let canonical_dest_dir = canonicalize_existing(&dest_dir, "cache directory")?;
    if !canonical_dest_dir.starts_with(&canonical_app_data) {
        return Err("Cache directory escapes the app data directory".to_string());
    }

    let dest = canonical_dest_dir.join(&cached_name);
    let mut source_file = File::open(&src).map_err(|e| e.to_string())?;
    let mut dest_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest)
        .map_err(|e| e.to_string())?;
    std::io::copy(&mut source_file, &mut dest_file).map_err(|e| e.to_string())?;

    let rel_path = format!("{user_id}/{chat_id}/file/{cached_name}");
    let abs_path = dest.to_string_lossy().to_string();
    let asset_url = format!("asset://localhost/{}", abs_path.replace('\\', "/"));

    Ok(CachedFile {
        rel_path,
        asset_url,
        name: file_name,
        size,
        mime,
    })
}

#[tauri::command]
pub fn cache_conversation_file(
    app: tauri::AppHandle,
    user_id: String,
    chat_id: String,
    filename: String,
    mime_type: String,
    data: Vec<u8>,
) -> Result<CachedFile, String> {
    validate_path_segment(&user_id, "user id")?;
    validate_path_segment(&chat_id, "chat id")?;
    if data.len() > 32 * 1024 * 1024 {
        return Err("文件超过 32 MiB 缓存上限".to_string());
    }

    let file_name = Path::new(&filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "File has no valid name".to_string())?
        .to_string();
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let cached_name = match file_name.rfind('.') {
        Some(i) => format!("{}_{}.{}", &file_name[..i], suffix, &file_name[i + 1..]),
        None => format!("{file_name}_{suffix}"),
    };

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve app data dir: {error}"))?;
    std::fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
    let canonical_app_data = canonicalize_existing(&app_data, "app data directory")?;
    let dest_dir = app_data.join(&user_id).join(&chat_id).join("file");
    std::fs::create_dir_all(&dest_dir).map_err(|error| error.to_string())?;
    let canonical_dest_dir = canonicalize_existing(&dest_dir, "cache directory")?;
    if !canonical_dest_dir.starts_with(&canonical_app_data) {
        return Err("Cache directory escapes the app data directory".to_string());
    }

    let dest = canonical_dest_dir.join(&cached_name);
    let mut dest_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest)
        .map_err(|error| error.to_string())?;
    dest_file
        .write_all(&data)
        .map_err(|error| error.to_string())?;

    let rel_path = format!("{user_id}/{chat_id}/file/{cached_name}");
    let abs_path = dest.to_string_lossy().to_string();
    Ok(CachedFile {
        rel_path,
        asset_url: format!("asset://localhost/{}", abs_path.replace('\\', "/")),
        name: file_name,
        size: data.len() as u64,
        mime: mime_type,
    })
}

#[tauri::command]
pub fn resolve_cached_file(app: tauri::AppHandle, rel_path: String) -> Result<String, String> {
    let abs = resolve_cached_file_path(&app, &rel_path)?;
    let abs_str = abs.to_string_lossy().to_string();
    Ok(format!("asset://localhost/{}", abs_str.replace('\\', "/")))
}

/// Reveal the cached file in Finder (macOS) / Explorer (Windows) / file manager (Linux).
#[tauri::command]
pub fn show_in_folder(app: tauri::AppHandle, rel_path: String) -> Result<(), String> {
    let abs = resolve_cached_file_path(&app, &rel_path)?;
    let abs_str = abs.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .args(["-R", &abs_str])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .args(["/select,", &abs_str])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(abs.parent().unwrap_or(&abs).to_str().unwrap_or(""))
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn open_local_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file_path = canonicalize_scoped_path(&app, &path, false)?;
    validate_upload_file_extension(&file_path)?;
    let path = file_path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Reveal a scanned local file in Finder / Explorer / the file manager.
#[tauri::command]
pub fn reveal_local_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file_path = canonicalize_scoped_path(&app, &path, false)?;
    let path = file_path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .args(["/select,", &path])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(file_path.parent().unwrap_or(&file_path))
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn open_cached_file(app: tauri::AppHandle, rel_path: String) -> Result<(), String> {
    let file_path = resolve_cached_file_path(&app, &rel_path)?;
    let path = file_path.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScannedKnowledgeFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct KnowledgeScanProgress {
    pub scan_id: String,
    pub directory: String,
    pub completed_directories: usize,
    pub total_directories: usize,
    pub files_found: usize,
    pub phase: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KnowledgeFilePreview {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub file_type: String,
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn scan_local_knowledge_files(
    app: tauri::AppHandle,
    extra_dirs: Vec<String>,
    scan_id: Option<String>,
) -> Result<Vec<ScannedKnowledgeFile>, String> {
    let scan_id = scan_id.unwrap_or_default();
    let mut dirs_to_scan: Vec<PathBuf> = Vec::new();

    for extra in &extra_dirs {
        let canonical = canonicalize_scoped_path(&app, extra, true)?;
        if dirs_to_scan
            .iter()
            .any(|existing| canonical == *existing || canonical.starts_with(existing))
        {
            continue;
        }
        dirs_to_scan.retain(|existing| !existing.starts_with(&canonical));
        dirs_to_scan.push(canonical);
    }

    let total_directories = dirs_to_scan.len();
    tauri::async_runtime::spawn_blocking(move || {
        let mut results: Vec<ScannedKnowledgeFile> = Vec::new();
        let mut seen_paths = std::collections::HashSet::new();
        for (index, dir) in dirs_to_scan.into_iter().enumerate() {
            let directory = dir.to_string_lossy().to_string();
            // Recheck grants after queueing; a settings revocation must also
            // stop an in-flight scan before its next root is read.
            scan_dir_for_knowledge_files(
                &dir,
                &dir,
                &mut seen_paths,
                &mut results,
                &|path| canonicalize_scoped_path(&app, &path.to_string_lossy(), true).map(|_| ()),
                true,
            )?;
            let _ = app.emit(
                "knowledge-scan-progress",
                KnowledgeScanProgress {
                    scan_id: scan_id.clone(),
                    directory,
                    completed_directories: index + 1,
                    total_directories,
                    files_found: results.len(),
                    phase: if index + 1 == total_directories {
                        "completed".into()
                    } else {
                        "scanning".into()
                    },
                },
            );
        }
        results.sort_by_key(|entry| entry.name.to_lowercase());
        Ok(results)
    })
    .await
    .map_err(|error| format!("本地扫描任务失败: {error}"))?
}

fn scan_dir_for_knowledge_files(
    allowed_root: &Path,
    dir: &Path,
    seen_paths: &mut std::collections::HashSet<PathBuf>,
    results: &mut Vec<ScannedKnowledgeFile>,
    check_access: &impl Fn(&Path) -> Result<(), String>,
    // Only the directory the user explicitly authorized fails the whole scan.
    // Protected subdirectories (a root grant always contains some) are skipped so
    // a broad selection still returns everything that is actually readable.
    is_scan_root: bool,
) -> Result<(), String> {
    check_access(dir)?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if is_scan_root => return Err(crate::file_access::io_error(dir, error)),
        Err(_) => return Ok(()),
    };

    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if should_skip_knowledge_path(&path) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Never follow symlinks while recursively scanning. This prevents a
        // selected directory from being used as a bridge to another tree and
        // also avoids symlink cycles.
        if file_type.is_symlink() {
            continue;
        }
        let Ok(canonical_path) = path.canonicalize() else {
            continue;
        };
        if !canonical_path.starts_with(allowed_root) {
            continue;
        }
        if file_type.is_dir() {
            scan_dir_for_knowledge_files(
                allowed_root,
                &canonical_path,
                seen_paths,
                results,
                check_access,
                false,
            )?;
        } else if let Some(ext) = canonical_path.extension().and_then(|e| e.to_str()) {
            if is_supported_knowledge_file_ext(ext) && seen_paths.insert(canonical_path.clone()) {
                let size = canonical_path.metadata().map(|m| m.len()).unwrap_or(0);
                let modified_at = canonical_path
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64);
                let name = canonical_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let path_str = canonical_path.to_string_lossy().to_string();
                results.push(ScannedKnowledgeFile {
                    name,
                    path: path_str,
                    size,
                    modified_at,
                });
            }
        }
    }
    Ok(())
}

fn is_supported_knowledge_file_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("docx")
        || ext.eq_ignore_ascii_case("md")
        || ext.eq_ignore_ascii_case("pdf")
        || ext.eq_ignore_ascii_case("csv")
        || ext.eq_ignore_ascii_case("ppt")
        || ext.eq_ignore_ascii_case("pptx")
}

fn is_supported_upload_file_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "txt"
            | "md"
            | "markdown"
            | "csv"
            | "json"
            | "log"
            | "html"
            | "htm"
            | "doc"
            | "docx"
            | "pdf"
            | "ppt"
            | "pptx"
            | "zip"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "bmp"
            | "svg"
    )
}

fn validate_upload_file_extension(path: &Path) -> Result<(), String> {
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    if !is_supported_upload_file_ext(extension) {
        return Err(format!("Unsupported local file type: {}", path.display()));
    }
    Ok(())
}

fn should_skip_knowledge_path(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return true;
    };
    name.is_empty()
        || name.starts_with('.')
        || name.starts_with("~$")
        || name.starts_with("._")
        || name.ends_with(".tmp")
        || name.ends_with(".temp")
}

#[tauri::command]
pub fn read_file_as_base64(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let file_path = canonicalize_scoped_path(&app, &path, false)?;
    validate_upload_file_extension(&file_path)?;
    let bytes =
        std::fs::read(&file_path).map_err(|e| crate::file_access::io_error(&file_path, e))?;
    Ok(encode_base64(&bytes))
}

#[tauri::command]
pub fn preview_local_knowledge_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<KnowledgeFilePreview, String> {
    let file_path = canonicalize_scoped_path(&app, &path, false)?;
    let metadata = file_path
        .metadata()
        .map_err(|e| format!("Failed to inspect {path}: {e}"))?;

    let name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let file_type = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let raw_content = match file_type.as_str() {
        "md" | "markdown" | "csv" | "txt" | "json" | "log" => read_text_preview(&file_path)?,
        "docx" => read_docx_preview(&file_path)?,
        "pdf" => return Err("PDF 文件可直接上传到知识库，暂不支持本地正文预览".to_string()),
        "ppt" | "pptx" => {
            return Err("PowerPoint 文件可直接上传到知识库，暂不支持本地正文预览".to_string())
        }
        _ => return Err(format!("Unsupported preview type: {file_type}")),
    };
    let (content, truncated) = truncate_preview(raw_content);

    Ok(KnowledgeFilePreview {
        name,
        path: file_path.to_string_lossy().to_string(),
        size: metadata.len(),
        file_type,
        content,
        truncated,
    })
}

#[tauri::command]
pub fn preview_knowledge_file_content(
    name: String,
    file_type: String,
    data_base64: String,
) -> Result<KnowledgeFilePreview, String> {
    let bytes = decode_base64(&data_base64)?;
    let file_type = file_type.to_lowercase();
    let raw_content = match file_type.as_str() {
        "md" | "csv" => String::from_utf8_lossy(&bytes).to_string(),
        "docx" => {
            let document_xml = read_zip_entry(&bytes, "word/document.xml")?;
            let xml = String::from_utf8_lossy(&document_xml);
            let text = extract_docx_text(&xml);
            if text.trim().is_empty() {
                return Err("未能从 docx 中提取到可预览正文".to_string());
            }
            text
        }
        _ => return Err(format!("Unsupported preview type: {file_type}")),
    };
    let (content, truncated) = truncate_preview(raw_content);

    Ok(KnowledgeFilePreview {
        name,
        path: String::new(),
        size: bytes.len() as u64,
        file_type,
        content,
        truncated,
    })
}

fn read_text_preview(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| crate::file_access::io_error(path, e))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn read_docx_preview(path: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| crate::file_access::io_error(path, e))?;
    let document_xml = read_zip_entry(&bytes, "word/document.xml")?;
    let xml = String::from_utf8_lossy(&document_xml);
    let text = extract_docx_text(&xml);
    if text.trim().is_empty() {
        return Err("未能从 docx 中提取到可预览正文".to_string());
    }
    Ok(text)
}

fn encode_base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u8 = 0;

    for byte in input.bytes().filter(|b| !b.is_ascii_whitespace()) {
        if byte == b'=' {
            break;
        }
        let Some(value) = decode_base64_value(byte) else {
            return Err("Invalid base64 data".to_string());
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
        }
    }

    Ok(output)
}

fn decode_base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn read_zip_entry(data: &[u8], target_name: &str) -> Result<Vec<u8>, String> {
    let eocd_offset = find_zip_eocd(data).ok_or("Invalid docx: missing ZIP directory")?;
    let central_dir_offset = read_u32(data, eocd_offset + 16)? as usize;
    let central_dir_size = read_u32(data, eocd_offset + 12)? as usize;
    let central_dir_end = central_dir_offset
        .checked_add(central_dir_size)
        .ok_or("Invalid docx: ZIP directory is too large")?;
    if central_dir_end > data.len() {
        return Err("Invalid docx: ZIP directory out of range".to_string());
    }

    let mut cursor = central_dir_offset;
    while cursor + 46 <= central_dir_end {
        if read_u32(data, cursor)? != 0x0201_4b50 {
            return Err("Invalid docx: corrupt ZIP directory".to_string());
        }

        let compression_method = read_u16(data, cursor + 10)?;
        let compressed_size = read_u32(data, cursor + 20)? as usize;
        let file_name_len = read_u16(data, cursor + 28)? as usize;
        let extra_len = read_u16(data, cursor + 30)? as usize;
        let comment_len = read_u16(data, cursor + 32)? as usize;
        let local_header_offset = read_u32(data, cursor + 42)? as usize;
        let name_start = cursor + 46;
        let name_end = name_start
            .checked_add(file_name_len)
            .ok_or("Invalid docx: ZIP filename is too large")?;
        if name_end > central_dir_end {
            return Err("Invalid docx: ZIP filename out of range".to_string());
        }

        let name = String::from_utf8_lossy(&data[name_start..name_end]);
        if name == target_name {
            return read_zip_local_entry(
                data,
                local_header_offset,
                compressed_size,
                compression_method,
            );
        }

        cursor = name_end
            .checked_add(extra_len)
            .and_then(|v| v.checked_add(comment_len))
            .ok_or("Invalid docx: ZIP entry is too large")?;
    }

    Err(format!("Invalid docx: missing {target_name}"))
}

fn read_zip_local_entry(
    data: &[u8],
    offset: usize,
    compressed_size: usize,
    compression_method: u16,
) -> Result<Vec<u8>, String> {
    if offset + 30 > data.len() || read_u32(data, offset)? != 0x0403_4b50 {
        return Err("Invalid docx: corrupt ZIP local header".to_string());
    }

    let file_name_len = read_u16(data, offset + 26)? as usize;
    let extra_len = read_u16(data, offset + 28)? as usize;
    let data_start = offset
        .checked_add(30)
        .and_then(|v| v.checked_add(file_name_len))
        .and_then(|v| v.checked_add(extra_len))
        .ok_or("Invalid docx: ZIP local entry is too large")?;
    let data_end = data_start
        .checked_add(compressed_size)
        .ok_or("Invalid docx: ZIP compressed entry is too large")?;
    if data_end > data.len() {
        return Err("Invalid docx: ZIP compressed entry out of range".to_string());
    }

    let compressed = &data[data_start..data_end];
    match compression_method {
        0 => Ok(compressed.to_vec()),
        8 => {
            let mut decoder = DeflateDecoder::new(compressed);
            let mut output = Vec::new();
            decoder
                .read_to_end(&mut output)
                .map_err(|e| format!("Failed to decompress docx: {e}"))?;
            Ok(output)
        }
        other => Err(format!("Unsupported docx compression method: {other}")),
    }
}

fn find_zip_eocd(data: &[u8]) -> Option<usize> {
    let min_offset = data.len().saturating_sub(65_557);
    if data.len() < 22 {
        return None;
    }

    (min_offset..=data.len() - 22)
        .rev()
        .find(|&offset| data.get(offset..offset + 4) == Some(&[0x50, 0x4b, 0x05, 0x06]))
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, String> {
    let bytes = data
        .get(offset..offset + 2)
        .ok_or("Invalid docx: unexpected end of ZIP data")?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, String> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or("Invalid docx: unexpected end of ZIP data")?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn extract_docx_text(xml: &str) -> String {
    let mut text = String::new();
    let mut cursor = 0;

    while cursor < xml.len() {
        let rest = &xml[cursor..];
        if rest.starts_with("<w:t") {
            if let Some(tag_end) = rest.find('>') {
                let content_start = cursor + tag_end + 1;
                if let Some(close_offset) = xml[content_start..].find("</w:t>") {
                    let content_end = content_start + close_offset;
                    text.push_str(&decode_xml_entities(&xml[content_start..content_end]));
                    cursor = content_end + "</w:t>".len();
                    continue;
                }
            }
        } else if rest.starts_with("<w:tab") {
            text.push('\t');
        } else if rest.starts_with("<w:br") || rest.starts_with("<w:cr") {
            text.push('\n');
        } else if rest.starts_with("</w:p>") {
            let trimmed = text.trim_end_matches([' ', '\t']);
            if !trimmed.is_empty() && !trimmed.ends_with('\n') {
                text.push('\n');
            }
        }

        cursor += rest.chars().next().map(char::len_utf8).unwrap_or(1);
    }

    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn decode_xml_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(entity_start) = rest.find('&') {
        output.push_str(&rest[..entity_start]);
        rest = &rest[entity_start + 1..];
        let Some(entity_end) = rest.find(';') else {
            output.push('&');
            output.push_str(rest);
            return output;
        };

        let entity = &rest[..entity_end];
        match entity {
            "amp" => output.push('&'),
            "lt" => output.push('<'),
            "gt" => output.push('>'),
            "quot" => output.push('"'),
            "apos" => output.push('\''),
            _ if entity.starts_with("#x") => {
                if let Ok(code) = u32::from_str_radix(&entity[2..], 16) {
                    if let Some(ch) = char::from_u32(code) {
                        output.push(ch);
                    }
                }
            }
            _ if entity.starts_with('#') => {
                if let Ok(code) = entity[1..].parse::<u32>() {
                    if let Some(ch) = char::from_u32(code) {
                        output.push(ch);
                    }
                }
            }
            _ => {
                output.push('&');
                output.push_str(entity);
                output.push(';');
            }
        }
        rest = &rest[entity_end + 1..];
    }

    output.push_str(rest);
    output
}

fn truncate_preview(content: String) -> (String, bool) {
    for (char_count, (index, _)) in content.char_indices().enumerate() {
        if char_count == PREVIEW_MAX_CHARS {
            return (content[..index].to_string(), true);
        }
    }
    (content, false)
}

fn mime_for_ext(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "zip" => "application/zip",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_cached_path_from_root, validate_cached_relative_path, validate_path_segment,
    };
    use std::path::Path;

    fn create_test_directory(label: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "aifred-files-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn cache_segments_reject_path_components_and_platform_separators() {
        for invalid in ["", ".", "..", "../outside", "a/b", "a\\b", "C:", "bad\0id"] {
            assert!(
                validate_path_segment(invalid, "test segment").is_err(),
                "expected invalid segment: {invalid:?}"
            );
        }
        for valid in ["user-123", "chat_456", "user@example.com", "成员"] {
            assert!(
                validate_path_segment(valid, "test segment").is_ok(),
                "expected valid segment: {valid:?}"
            );
        }
    }

    #[test]
    fn cached_relative_paths_require_the_exact_cache_layout() {
        assert!(validate_cached_relative_path(Path::new("user/chat/file/report.pdf")).is_ok());
        for invalid in [
            "../secret.db",
            "/tmp/secret.db",
            "user/chat/other/report.pdf",
            "user/chat/file/nested/report.pdf",
            "user/chat/file/../../secret.db",
        ] {
            assert!(
                validate_cached_relative_path(Path::new(invalid)).is_err(),
                "expected invalid cached path: {invalid}"
            );
        }
    }

    #[test]
    fn cached_path_resolution_stays_under_the_canonical_app_data_root() {
        let root = create_test_directory("cache-root");
        let cache_dir = root.join("user").join("chat").join("file");
        std::fs::create_dir_all(&cache_dir).expect("create cache tree");
        let cached_file = cache_dir.join("report.pdf");
        std::fs::write(&cached_file, b"cached").expect("write cached file");

        let resolved = resolve_cached_path_from_root(&root, Path::new("user/chat/file/report.pdf"))
            .expect("resolve valid cached file");
        assert_eq!(resolved, cached_file.canonicalize().unwrap());
        assert!(resolve_cached_path_from_root(
            &root,
            Path::new("user/chat/file/../../../../etc/passwd"),
        )
        .is_err());

        std::fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn cached_path_resolution_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = create_test_directory("symlink-root");
        let outside = create_test_directory("symlink-outside");
        let outside_file = outside.join("secret.pdf");
        std::fs::write(&outside_file, b"secret").expect("write outside file");
        let cache_dir = root.join("user").join("chat").join("file");
        std::fs::create_dir_all(&cache_dir).expect("create cache tree");
        symlink(&outside_file, cache_dir.join("escape.pdf")).expect("create symlink");

        let error = resolve_cached_path_from_root(&root, Path::new("user/chat/file/escape.pdf"))
            .expect_err("symlink must not escape cache root");
        assert!(error.contains("escapes the app data directory"));

        std::fs::remove_dir_all(&root).expect("remove root directory");
        std::fs::remove_dir_all(&outside).expect("remove outside directory");
    }
}

/// The native save dialog owns the destination; paths never enter the WebView.
#[tauri::command]
pub async fn save_conversation_file(
    app: tauri::AppHandle,
    filename: String,
    data: Vec<u8>,
) -> Result<bool, String> {
    if data.len() > 32 * 1024 * 1024 {
        return Err("文件超过 32 MiB 保存上限".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let safe_name = std::path::Path::new(&filename)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("download");
        let Some(destination) = app
            .dialog()
            .file()
            .set_file_name(safe_name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = destination.into_path().map_err(|_| "保存位置无效")?;
        std::fs::write(path, data).map_err(|_| "文件保存失败")?;
        Ok(true)
    })
    .await
    .map_err(|_| "文件保存任务失败")?
}
