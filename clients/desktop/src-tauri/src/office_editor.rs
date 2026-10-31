use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, Once};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const DEFAULT_ACTIVE_MAP: &str = "office-10-person.json";
const MAX_BODY_BYTES: usize = 45 * 1024 * 1024;
/// Records the hash of the bundled map last applied to the app data directory.
const BUNDLED_MAP_MARKER: &str = ".bundled-map.sha256";

#[derive(Default)]
pub struct OfficeEditorState {
    port: Mutex<Option<u16>>,
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn sanitize_map_file_name(raw_name: &str) -> Result<String, String> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return Err("请输入保存文件名".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("文件名不能包含路径分隔符".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let without_ext = if lower.ends_with(".office-map.json") {
        &trimmed[..trimmed.len() - ".office-map.json".len()]
    } else if lower.ends_with(".json") {
        &trimmed[..trimmed.len() - ".json".len()]
    } else {
        trimmed
    };
    let stem: String = without_ext
        .chars()
        .map(|c| {
            if (c as u32) <= 0x1f
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '-'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_string();

    if stem.is_empty() || stem == "." || stem == ".." {
        return Err("文件名无效".to_string());
    }
    if stem.eq_ignore_ascii_case("manifest") {
        return Err("manifest.json 为系统索引文件，请换一个名称".to_string());
    }
    if stem.chars().count() > 100 {
        return Err("文件名不能超过 100 个字符".to_string());
    }
    Ok(format!("{stem}.json"))
}

pub fn is_valid_office_map_object(data: &Value) -> bool {
    let Some(obj) = data.as_object() else {
        return false;
    };
    let Some(schema) = obj.get("schema").and_then(Value::as_str) else {
        return false;
    };
    if !schema.starts_with("office-map/") {
        return false;
    }
    let width_ok = obj
        .get("width")
        .and_then(Value::as_f64)
        .map(f64::is_finite)
        .unwrap_or(false);
    let height_ok = obj
        .get("height")
        .and_then(Value::as_f64)
        .map(f64::is_finite)
        .unwrap_or(false);
    width_ok
        && height_ok
        && obj.get("assets").map(Value::is_array).unwrap_or(false)
        && obj.get("elements").map(Value::is_array).unwrap_or(false)
        && obj.get("zones").map(Value::is_array).unwrap_or(false)
}

fn normalize_asset_src(src: &str) -> String {
    if let Some(rest) = src.strip_prefix("assets/styles/topdown-soft/") {
        return format!("assets/office/topdown/{rest}");
    }
    if let Some(rest) = src.strip_prefix("assets/aifred/office/") {
        return format!("assets/office/{rest}");
    }
    if src.starts_with("assets/icon_office_") {
        return format!("assets/office/{}", &src["assets/".len()..]);
    }
    src.to_string()
}

pub fn normalize_map_for_shared_storage(mut map: Value) -> Value {
    let Some(obj) = map.as_object_mut() else {
        return map;
    };

    if let Some(bg_src) = obj
        .get_mut("background")
        .and_then(Value::as_object_mut)
        .and_then(|bg| bg.get_mut("src"))
    {
        if let Some(s) = bg_src.as_str() {
            *bg_src = Value::String(normalize_asset_src(s));
        }
    }

    if let Some(assets) = obj.get_mut("assets").and_then(Value::as_array_mut) {
        for asset in assets {
            if let Some(src_val) = asset.as_object_mut().and_then(|a| a.get_mut("src")) {
                if let Some(s) = src_val.as_str() {
                    *src_val = Value::String(normalize_asset_src(s));
                }
            }
        }
    }

    let rooms_snapshot: Vec<(String, f64, f64, f64, f64)> = obj
        .get("rooms")
        .and_then(Value::as_array)
        .map(|rooms| {
            rooms
                .iter()
                .filter_map(|r| {
                    let r_obj = r.as_object()?;
                    if r_obj.get("kind").and_then(Value::as_str) == Some("work") {
                        return None;
                    }
                    let id = r_obj.get("id").and_then(Value::as_str)?.to_string();
                    let bounds = r_obj.get("bounds")?.as_object()?;
                    let x = bounds.get("x")?.as_f64()?;
                    let y = bounds.get("y")?.as_f64()?;
                    let w = bounds.get("width")?.as_f64()?;
                    let h = bounds.get("height")?.as_f64()?;
                    Some((id, x, y, w, h))
                })
                .collect()
        })
        .unwrap_or_default();

    if !rooms_snapshot.is_empty() {
        if let Some(spots) = obj.get_mut("spots").and_then(Value::as_array_mut) {
            for spot in spots {
                let Some(s_obj) = spot.as_object_mut() else {
                    continue;
                };
                let has_room = s_obj
                    .get("roomId")
                    .and_then(Value::as_str)
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                if has_room {
                    continue;
                }
                let sx = s_obj.get("x").and_then(Value::as_f64).unwrap_or(f64::NAN);
                let sy = s_obj.get("y").and_then(Value::as_f64).unwrap_or(f64::NAN);
                if !sx.is_finite() || !sy.is_finite() {
                    continue;
                }
                if let Some((room_id, _, _, _, _)) =
                    rooms_snapshot.iter().find(|(_, rx, ry, rw, rh)| {
                        sx >= *rx && sx <= *rx + *rw && sy >= *ry && sy <= *ry + *rh
                    })
                {
                    s_obj.insert("roomId".to_string(), Value::String(room_id.clone()));
                }
            }
        }
    }

    map
}

fn read_manifest(map_dir: &Path) -> (String, u64) {
    let manifest_path = map_dir.join("manifest.json");
    if let Ok(raw) = fs::read_to_string(&manifest_path) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
            let active_map = parsed
                .get("activeMap")
                .and_then(Value::as_str)
                .and_then(|s| sanitize_map_file_name(s).ok())
                .unwrap_or_else(|| DEFAULT_ACTIVE_MAP.to_string());
            let updated_at = parsed.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
            return (active_map, updated_at);
        }
    }
    (DEFAULT_ACTIVE_MAP.to_string(), 0)
}

fn write_manifest(
    map_dir: &Path,
    active_map: &str,
    updated_at: u64,
) -> Result<(String, u64), String> {
    fs::create_dir_all(map_dir).map_err(|e| format!("无法创建地图目录: {e}"))?;
    let sanitized = sanitize_map_file_name(active_map)?;
    let ts = if updated_at > 0 {
        updated_at
    } else {
        now_epoch_ms()
    };
    let payload = json!({
        "activeMap": sanitized,
        "updatedAt": ts,
    });
    let text = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(map_dir.join("manifest.json"), format!("{text}\n"))
        .map_err(|e| format!("写入 manifest.json 失败: {e}"))?;
    Ok((sanitized, ts))
}

pub fn list_shared_maps_in_dir(map_dir: &Path) -> Result<Value, String> {
    fs::create_dir_all(map_dir).map_err(|e| format!("无法创建地图目录: {e}"))?;
    let (manifest_active, manifest_updated_at) = read_manifest(map_dir);
    let mut files = Vec::new();

    let entries = fs::read_dir(map_dir).map_err(|e| format!("读取地图目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name_str) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name_str.to_ascii_lowercase().ends_with(".json")
            || name_str.eq_ignore_ascii_case("manifest.json")
        {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if !is_valid_office_map_object(&parsed) {
            continue;
        }
        let map_name = parsed
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| name_str.strip_suffix(".json").unwrap_or(name_str));
        let width = parsed.get("width").and_then(Value::as_f64).unwrap_or(0.0);
        let height = parsed.get("height").and_then(Value::as_f64).unwrap_or(0.0);
        let elements_arr = parsed.get("elements").and_then(Value::as_array);
        let elements_count = elements_arr.map(Vec::len).unwrap_or(0);
        let seats_count = elements_arr
            .map(|arr| {
                arr.iter()
                    .filter(|el| el.get("assetId").and_then(Value::as_str) == Some("aifred-chair"))
                    .count()
            })
            .unwrap_or(0);

        files.push(json!({
            "file": name_str,
            "name": map_name,
            "updatedAt": file_mtime_ms(&path),
            "width": width,
            "height": height,
            "elements": elements_count,
            "seats": seats_count,
        }));
    }

    files.sort_by(|a, b| {
        let af = a.get("file").and_then(Value::as_str).unwrap_or("");
        let bf = b.get("file").and_then(Value::as_str).unwrap_or("");
        if af == DEFAULT_ACTIVE_MAP {
            return std::cmp::Ordering::Less;
        }
        if bf == DEFAULT_ACTIVE_MAP {
            return std::cmp::Ordering::Greater;
        }
        af.cmp(bf)
    });

    let active_exists = files
        .iter()
        .any(|f| f.get("file").and_then(Value::as_str) == Some(manifest_active.as_str()));
    let active_file = if active_exists {
        manifest_active
    } else {
        files
            .first()
            .and_then(|f| f.get("file").and_then(Value::as_str))
            .unwrap_or(DEFAULT_ACTIVE_MAP)
            .to_string()
    };

    let active_mtime = files
        .iter()
        .find(|f| f.get("file").and_then(Value::as_str) == Some(active_file.as_str()))
        .and_then(|f| f.get("updatedAt").and_then(Value::as_u64))
        .unwrap_or(0);
    let updated_at = manifest_updated_at.max(active_mtime);

    Ok(json!({
        "activeFile": active_file,
        "updatedAt": updated_at,
        "files": files,
    }))
}

pub fn read_shared_map_in_dir(map_dir: &Path, raw_file: &str) -> Result<Value, String> {
    let file_name = sanitize_map_file_name(raw_file)?;
    let full_path = map_dir.join(&file_name);
    let raw = fs::read_to_string(&full_path).map_err(|_| format!("地图文件不存在: {file_name}"))?;
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|_| format!("地图文件 JSON 格式无效: {file_name}"))?;
    if !is_valid_office_map_object(&parsed) {
        return Err(format!("不是有效的办公室地图配置: {file_name}"));
    }
    let normalized = normalize_map_for_shared_storage(parsed);
    Ok(json!({
        "file": file_name,
        "map": normalized,
    }))
}

pub fn save_shared_map_in_dir(
    map_dir: &Path,
    file: &str,
    map: Value,
    set_active: bool,
) -> Result<Value, String> {
    let file_name = sanitize_map_file_name(file)?;
    if !is_valid_office_map_object(&map) {
        return Err(
            "地图配置结构无效：缺少 schema / width / height / assets / elements / zones"
                .to_string(),
        );
    }
    fs::create_dir_all(map_dir).map_err(|e| format!("无法创建地图目录: {e}"))?;
    let normalized = normalize_map_for_shared_storage(map);
    let full_path = map_dir.join(&file_name);
    let serialized = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(&full_path, format!("{serialized}\n"))
        .map_err(|e| format!("保存地图配置失败: {e}"))?;

    let now = now_epoch_ms();
    let (active_file, _) = if set_active {
        write_manifest(map_dir, &file_name, now)?
    } else {
        let (cur_active, _) = read_manifest(map_dir);
        write_manifest(map_dir, &cur_active, now)?
    };

    Ok(json!({
        "ok": true,
        "file": file_name,
        "activeFile": active_file,
        "updatedAt": now,
        "path": format!("/assets/office/map/{file_name}"),
        "map": normalized,
    }))
}

pub fn set_active_shared_map_in_dir(map_dir: &Path, raw_file: &str) -> Result<Value, String> {
    let file_name = sanitize_map_file_name(raw_file)?;
    let full_path = map_dir.join(&file_name);
    if !full_path.is_file() {
        return Err(format!("地图文件不存在：{file_name}"));
    }
    let (_, updated_at) = write_manifest(map_dir, &file_name, now_epoch_ms())?;
    Ok(json!({
        "ok": true,
        "activeFile": file_name,
        "updatedAt": updated_at,
    }))
}

fn read_embedded_asset(app: &tauri::AppHandle, rel_path: &str) -> Option<Vec<u8>> {
    let clean = rel_path.trim_start_matches('/');
    if clean.is_empty() || clean.split('/').any(|seg| seg == "..") {
        return None;
    }

    if let Some(asset) = app
        .asset_resolver()
        .get(format!("/{clean}"))
        .or_else(|| app.asset_resolver().get(clean.to_string()))
    {
        return Some(asset.bytes);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("../dist").join(clean),
        manifest_dir.join("../public").join(clean),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            if let Ok(bytes) = fs::read(&candidate) {
                return Some(bytes);
            }
        }
    }

    if let Some(sub) = clean.strip_prefix("office-editor/") {
        let external_editor = manifest_dir.join("../../office-map-edit-tool").join(sub);
        if external_editor.is_file() {
            if let Ok(bytes) = fs::read(&external_editor) {
                return Some(bytes);
            }
        }
    }

    None
}

#[derive(Debug, PartialEq, Eq)]
enum BundledMapSync {
    /// This build's map is already in place; local edits are left alone.
    Unchanged,
    /// There was no copy yet.
    Seeded,
    /// A different copy was replaced; the previous one is kept as `<name>.bak`.
    Replaced,
}

/// A packaged build shows the map that ships with it, i.e. the one the dev build serves from `public/`.
/// The copy in the app data directory is only the editor's working copy, so it follows the shipped map: edits made in the
/// packaged editor survive until a build ships a different map, which then replaces them (the old file is backed up).
/// The marker is written last, so an interrupted sync is retried on the next launch.
fn sync_bundled_map(
    map_dir: &Path,
    bundled_map: &[u8],
    bundled_manifest: Option<&[u8]>,
) -> Result<BundledMapSync, String> {
    let hash = hex::encode(Sha256::digest(bundled_map));
    let map_path = map_dir.join(DEFAULT_ACTIVE_MAP);
    let marker_path = map_dir.join(BUNDLED_MAP_MARKER);
    let existing = fs::read(&map_path).ok();
    let applied = fs::read_to_string(&marker_path).ok();
    if existing.is_some() && applied.as_deref().map(str::trim) == Some(hash.as_str()) {
        return Ok(BundledMapSync::Unchanged);
    }
    let outcome = match &existing {
        None => BundledMapSync::Seeded,
        Some(current) if current.as_slice() == bundled_map => BundledMapSync::Unchanged,
        Some(current) => {
            fs::write(map_dir.join(format!("{DEFAULT_ACTIVE_MAP}.bak")), current)
                .map_err(|e| format!("备份旧地图失败: {e}"))?;
            BundledMapSync::Replaced
        }
    };
    if outcome != BundledMapSync::Unchanged {
        fs::write(&map_path, bundled_map).map_err(|e| format!("写入内置地图失败: {e}"))?;
        match bundled_manifest {
            Some(bytes) => fs::write(map_dir.join("manifest.json"), bytes)
                .map_err(|e| format!("写入 manifest.json 失败: {e}"))?,
            None => {
                write_manifest(map_dir, DEFAULT_ACTIVE_MAP, now_epoch_ms())?;
            }
        }
    }
    fs::write(&marker_path, format!("{hash}\n")).map_err(|e| format!("写入地图标记失败: {e}"))?;
    Ok(outcome)
}

fn resolve_map_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("office-maps");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建地图目录: {e}"))?;

    static BUNDLED_MAP_SYNC: Once = Once::new();
    BUNDLED_MAP_SYNC.call_once(|| {
        let Some(map) =
            read_embedded_asset(app, &format!("assets/office/map/{DEFAULT_ACTIVE_MAP}"))
        else {
            return;
        };
        let manifest = read_embedded_asset(app, "assets/office/map/manifest.json");
        if let Err(reason) = sync_bundled_map(&dir, &map, manifest.as_deref()) {
            if let Some(root) = dir.parent() {
                crate::diagnostics::host_event_fields(
                    root,
                    "office_map.sync_failed",
                    "warn",
                    json!({ "reason": reason }),
                );
            }
        }
    });

    let default_map_path = dir.join(DEFAULT_ACTIVE_MAP);
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.is_file() {
        if let Some(bytes) = read_embedded_asset(app, "assets/office/map/manifest.json") {
            let _ = fs::write(&manifest_path, bytes);
        } else if default_map_path.is_file() {
            let _ = write_manifest(&dir, DEFAULT_ACTIVE_MAP, now_epoch_ms());
        }
    }

    Ok(dir)
}

fn mime_type_for_path(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") {
        "text/javascript; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".atlas") || lower.ends_with(".txt") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn resolve_editor_static_asset_with<F>(
    read_asset: &F,
    rel_path: &str,
) -> Option<(&'static str, Vec<u8>)>
where
    F: Fn(&str) -> Option<Vec<u8>>,
{
    let clean_rel = rel_path.trim_start_matches('/');
    if clean_rel.split('/').any(|seg| seg == "..") {
        return None;
    }

    if clean_rel.is_empty() || clean_rel == "index.html" {
        let bytes = read_asset("office-editor/index.html")?;
        return Some((mime_type_for_path("index.html"), bytes));
    }

    if clean_rel == "examples/office-10-person.json" {
        let bytes = read_asset("office-editor/examples/office-10-person.json")
            .or_else(|| read_asset("assets/office/map/office-10-person.json"))?;
        return Some((mime_type_for_path(clean_rel), bytes));
    }

    if let Some(sub) = clean_rel.strip_prefix("assets/aifred/office/") {
        if let Some(bytes) = read_asset(&format!("assets/office/{sub}")) {
            return Some((mime_type_for_path(sub), bytes));
        }
    }

    if let Some(sub) = clean_rel.strip_prefix("assets/aifred/characters/") {
        if let Some(bytes) = read_asset(&format!("assets/characters/{sub}")) {
            return Some((mime_type_for_path(sub), bytes));
        }
    }

    if let Some(sub) = clean_rel.strip_prefix("assets/styles/topdown-soft/") {
        if clean_rel.ends_with(".png") {
            if let Some(bytes) = read_asset(&format!("assets/office/topdown/{sub}")) {
                return Some((mime_type_for_path(sub), bytes));
            }
        }
    }

    if clean_rel.starts_with("assets/office/") {
        if let Some(bytes) = read_asset(clean_rel) {
            return Some((mime_type_for_path(clean_rel), bytes));
        }
        if let Some(sub) = clean_rel.strip_prefix("assets/office/topdown/") {
            if let Some(bytes) =
                read_asset(&format!("office-editor/assets/styles/topdown-soft/{sub}"))
            {
                return Some((mime_type_for_path(sub), bytes));
            }
        }
    }

    if let Some(sub) = clean_rel.strip_prefix("assets/") {
        if sub.starts_with("icon_office_") && sub.ends_with(".png") {
            if let Some(bytes) = read_asset(&format!("assets/office/{sub}")) {
                return Some((mime_type_for_path(sub), bytes));
            }
        }
    }

    if let Some(bytes) =
        read_asset(&format!("office-editor/{clean_rel}")).or_else(|| read_asset(clean_rel))
    {
        return Some((mime_type_for_path(clean_rel), bytes));
    }

    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn url_encode_component(input: &str) -> String {
    let mut encoded = String::new();
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    encoded
}

fn open_in_system_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("http://127.0.0.1:") && !url.starts_with("http://localhost:") {
        return Err("仅允许打开本地回环地址的办公室编辑器".to_string());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/c", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(url).spawn();

    status
        .map(|_| ())
        .map_err(|e| format!("无法拉起系统浏览器: {e}"))
}

fn write_http_response(
    mut stream: TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
) {
    let mut header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in extra_headers {
        header.push_str(&format!("{k}: {v}\r\n"));
    }
    header.push_str("\r\n");
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn write_json_response(stream: TcpStream, status: u16, payload: &Value) {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let body = serde_json::to_vec(payload).unwrap_or_else(|_| b"{}".to_vec());
    write_http_response(
        stream,
        status,
        reason,
        "application/json; charset=utf-8",
        &body,
        &[],
    );
}

fn handle_http_connection_with<F>(
    stream: TcpStream,
    map_dir_result: Result<PathBuf, String>,
    port: u16,
    read_asset: F,
) where
    F: Fn(&str) -> Option<Vec<u8>>,
{
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
    let Ok(cloned) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(cloned);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
        return;
    }
    let mut parts = request_line.split_whitespace();
    let Some(method) = parts.next() else {
        return;
    };
    let Some(raw_target) = parts.next() else {
        return;
    };

    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.is_empty() || line == "\r\n" || line == "\n"
        {
            break;
        }
        if let Some((name, val)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = val.trim().parse::<usize>().unwrap_or(0);
            }
        }
    }

    if content_length > MAX_BODY_BYTES {
        write_json_response(
            stream,
            400,
            &json!({ "ok": false, "error": "配置文件体积超过限制（最大 45 MB）" }),
        );
        return;
    }

    let mut body_bytes = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body_bytes).is_err() {
        write_json_response(
            stream,
            400,
            &json!({ "ok": false, "error": "读取请求体失败" }),
        );
        return;
    }

    let (raw_path, raw_query) = match raw_target.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (raw_target, None),
    };
    let pathname = percent_decode(raw_path);

    let map_dir = match map_dir_result {
        Ok(dir) => dir,
        Err(err) => {
            write_json_response(stream, 400, &json!({ "ok": false, "error": err }));
            return;
        }
    };

    if pathname == "/__office-editor/api/maps" && method == "GET" {
        match list_shared_maps_in_dir(&map_dir) {
            Ok(val) => write_json_response(stream, 200, &val),
            Err(err) => write_json_response(stream, 400, &json!({ "ok": false, "error": err })),
        }
        return;
    }

    if let Some(raw_file) = pathname.strip_prefix("/__office-editor/api/maps/") {
        if method == "GET" {
            match read_shared_map_in_dir(&map_dir, raw_file) {
                Ok(val) => write_json_response(stream, 200, &val),
                Err(err) => write_json_response(stream, 400, &json!({ "ok": false, "error": err })),
            }
            return;
        }
    }

    if pathname == "/__office-editor/api/maps" && (method == "POST" || method == "PUT") {
        let parsed: Value = match serde_json::from_slice(&body_bytes) {
            Ok(v) => v,
            Err(_) => {
                write_json_response(
                    stream,
                    400,
                    &json!({ "ok": false, "error": "请求体不是有效 JSON" }),
                );
                return;
            }
        };
        let file = parsed.get("file").and_then(Value::as_str).unwrap_or("");
        let map = parsed.get("map").cloned().unwrap_or(Value::Null);
        let set_active = parsed
            .get("setActive")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        match save_shared_map_in_dir(&map_dir, file, map, set_active) {
            Ok(val) => write_json_response(stream, 200, &val),
            Err(err) => write_json_response(stream, 400, &json!({ "ok": false, "error": err })),
        }
        return;
    }

    if pathname == "/__office-editor/api/active-map" && method == "POST" {
        let parsed: Value = serde_json::from_slice(&body_bytes).unwrap_or_else(|_| json!({}));
        let file = parsed.get("file").and_then(Value::as_str).unwrap_or("");
        match set_active_shared_map_in_dir(&map_dir, file) {
            Ok(val) => write_json_response(stream, 200, &val),
            Err(err) => write_json_response(stream, 400, &json!({ "ok": false, "error": err })),
        }
        return;
    }

    if pathname == "/__office-editor/api/open-browser" && method == "POST" {
        let parsed: Value = serde_json::from_slice(&body_bytes).unwrap_or_else(|_| json!({}));
        let requested_file = parsed.get("file").and_then(Value::as_str);
        let active_file = list_shared_maps_in_dir(&map_dir)
            .ok()
            .and_then(|v| {
                v.get("activeFile")
                    .and_then(Value::as_str)
                    .map(String::from)
            })
            .unwrap_or_else(|| DEFAULT_ACTIVE_MAP.to_string());
        let target_file = match requested_file {
            Some(f) if !f.trim().is_empty() => match sanitize_map_file_name(f) {
                Ok(s) => s,
                Err(err) => {
                    write_json_response(stream, 400, &json!({ "ok": false, "error": err }));
                    return;
                }
            },
            _ => active_file,
        };
        let target_url = format!(
            "http://127.0.0.1:{port}/office-editor/?file={}",
            url_encode_component(&target_file)
        );
        let _ = open_in_system_browser(&target_url);
        write_json_response(
            stream,
            200,
            &json!({ "ok": true, "url": target_url, "file": target_file }),
        );
        return;
    }

    if pathname == "/office-editor" && (method == "GET" || method == "HEAD") {
        let location = match raw_query {
            Some(q) if !q.is_empty() => format!("/office-editor/?{q}"),
            _ => "/office-editor/".to_string(),
        };
        write_http_response(
            stream,
            302,
            "Found",
            "text/plain; charset=utf-8",
            b"",
            &[("Location", &location)],
        );
        return;
    }

    if method == "GET" || method == "HEAD" {
        let rel_path = if let Some(sub) = pathname.strip_prefix("/office-editor/") {
            Some(sub)
        } else if pathname.starts_with("/assets/") {
            Some(pathname.trim_start_matches('/'))
        } else {
            None
        };

        if let Some(rel) = rel_path {
            if let Some((mime, bytes)) = resolve_editor_static_asset_with(&read_asset, rel) {
                let body = if method == "HEAD" {
                    &[][..]
                } else {
                    &bytes[..]
                };
                write_http_response(stream, 200, "OK", mime, body, &[]);
                return;
            }
        }
    }

    write_http_response(
        stream,
        404,
        "Not Found",
        "text/plain; charset=utf-8",
        b"Not found",
        &[],
    );
}

fn handle_http_connection(stream: TcpStream, app: tauri::AppHandle, port: u16) {
    let map_dir_result = resolve_map_dir(&app);
    handle_http_connection_with(stream, map_dir_result, port, |rel| {
        read_embedded_asset(&app, rel)
    });
}

fn ensure_editor_server(app: &tauri::AppHandle, state: &OfficeEditorState) -> Result<u16, String> {
    let mut guard = state
        .port
        .lock()
        .map_err(|_| "办公室编辑器服务状态锁异常".to_string())?;
    if let Some(existing_port) = *guard {
        return Ok(existing_port);
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("无法绑定本地办公室编辑器端口: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("无法读取本地办公室编辑器端口: {e}"))?
        .port();

    let app_handle = app.clone();
    std::thread::Builder::new()
        .name("aifred-office-editor-http".to_string())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let handle = app_handle.clone();
                std::thread::spawn(move || {
                    handle_http_connection(stream, handle, port);
                });
            }
        })
        .map_err(|e| format!("无法启动办公室编辑器服务线程: {e}"))?;

    *guard = Some(port);
    Ok(port)
}

#[tauri::command]
pub fn list_office_maps(app: tauri::AppHandle) -> Result<Value, String> {
    let map_dir = resolve_map_dir(&app)?;
    list_shared_maps_in_dir(&map_dir)
}

#[tauri::command]
pub fn read_office_map(app: tauri::AppHandle, file: String) -> Result<Value, String> {
    let map_dir = resolve_map_dir(&app)?;
    read_shared_map_in_dir(&map_dir, &file)
}

#[tauri::command]
pub fn set_active_office_map_cmd(app: tauri::AppHandle, file: String) -> Result<Value, String> {
    let map_dir = resolve_map_dir(&app)?;
    set_active_shared_map_in_dir(&map_dir, &file)
}

#[tauri::command]
pub fn open_office_map_editor(
    app: tauri::AppHandle,
    state: tauri::State<'_, OfficeEditorState>,
    file: Option<String>,
) -> Result<Value, String> {
    let map_dir = resolve_map_dir(&app)?;
    let port = ensure_editor_server(&app, &state)?;
    let active_file = list_shared_maps_in_dir(&map_dir)
        .ok()
        .and_then(|v| {
            v.get("activeFile")
                .and_then(Value::as_str)
                .map(String::from)
        })
        .unwrap_or_else(|| DEFAULT_ACTIVE_MAP.to_string());
    let target_file = match file {
        Some(f) if !f.trim().is_empty() => sanitize_map_file_name(&f)?,
        _ => active_file,
    };
    let target_url = format!(
        "http://127.0.0.1:{port}/office-editor/?file={}",
        url_encode_component(&target_file)
    );
    open_in_system_browser(&target_url)?;
    Ok(json!({
        "ok": true,
        "url": target_url,
        "file": target_file,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_map_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aifred-map-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn marker_of(dir: &Path) -> String {
        fs::read_to_string(dir.join(BUNDLED_MAP_MARKER))
            .unwrap()
            .trim()
            .to_string()
    }

    #[test]
    fn bundled_map_is_seeded_into_an_empty_directory() {
        let dir = temp_map_dir();
        let manifest = br#"{"activeMap":"office-10-person.json","elements":160}"#;
        let outcome = sync_bundled_map(&dir, b"map-v2", Some(manifest)).unwrap();
        assert_eq!(outcome, BundledMapSync::Seeded);
        assert_eq!(fs::read(dir.join(DEFAULT_ACTIVE_MAP)).unwrap(), b"map-v2");
        assert_eq!(fs::read(dir.join("manifest.json")).unwrap(), manifest);
        assert_eq!(marker_of(&dir), hex::encode(Sha256::digest(b"map-v2")));
        assert!(!dir.join(format!("{DEFAULT_ACTIVE_MAP}.bak")).exists());
    }

    #[test]
    fn a_stale_copy_without_marker_is_replaced_and_backed_up() {
        // An app data copy written by an older build: no marker, different content.
        let dir = temp_map_dir();
        fs::write(dir.join(DEFAULT_ACTIVE_MAP), b"map-v1").unwrap();
        let outcome = sync_bundled_map(&dir, b"map-v2", Some(b"{}")).unwrap();
        assert_eq!(outcome, BundledMapSync::Replaced);
        assert_eq!(fs::read(dir.join(DEFAULT_ACTIVE_MAP)).unwrap(), b"map-v2");
        assert_eq!(
            fs::read(dir.join(format!("{DEFAULT_ACTIVE_MAP}.bak"))).unwrap(),
            b"map-v1"
        );
        assert_eq!(marker_of(&dir), hex::encode(Sha256::digest(b"map-v2")));
    }

    #[test]
    fn local_edits_survive_until_the_bundled_map_changes() {
        let dir = temp_map_dir();
        sync_bundled_map(&dir, b"map-v2", None).unwrap();
        fs::write(dir.join(DEFAULT_ACTIVE_MAP), b"edited").unwrap();
        // Same bundled map on the next launch: the edit is kept.
        assert_eq!(
            sync_bundled_map(&dir, b"map-v2", None).unwrap(),
            BundledMapSync::Unchanged
        );
        assert_eq!(fs::read(dir.join(DEFAULT_ACTIVE_MAP)).unwrap(), b"edited");
        // A new build ships a different map: it wins and the edit is backed up.
        assert_eq!(
            sync_bundled_map(&dir, b"map-v3", None).unwrap(),
            BundledMapSync::Replaced
        );
        assert_eq!(fs::read(dir.join(DEFAULT_ACTIVE_MAP)).unwrap(), b"map-v3");
        assert_eq!(
            fs::read(dir.join(format!("{DEFAULT_ACTIVE_MAP}.bak"))).unwrap(),
            b"edited"
        );
    }

    #[test]
    fn an_identical_copy_only_gets_a_marker() {
        let dir = temp_map_dir();
        fs::write(dir.join(DEFAULT_ACTIVE_MAP), b"map-v2").unwrap();
        assert_eq!(
            sync_bundled_map(&dir, b"map-v2", None).unwrap(),
            BundledMapSync::Unchanged
        );
        assert!(!dir.join(format!("{DEFAULT_ACTIVE_MAP}.bak")).exists());
        assert_eq!(marker_of(&dir), hex::encode(Sha256::digest(b"map-v2")));
    }

    #[test]
    fn a_missing_bundled_manifest_falls_back_to_a_generated_one() {
        let dir = temp_map_dir();
        sync_bundled_map(&dir, b"map-v2", None).unwrap();
        let manifest: Value =
            serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["activeMap"], DEFAULT_ACTIVE_MAP);
    }

    #[test]
    fn sanitizes_map_file_names_and_rejects_traversal() {
        assert_eq!(
            sanitize_map_file_name("office-10-person.json").unwrap(),
            "office-10-person.json"
        );
        assert_eq!(
            sanitize_map_file_name("custom-layout").unwrap(),
            "custom-layout.json"
        );
        assert!(sanitize_map_file_name("../secret.json").is_err());
        assert!(sanitize_map_file_name("manifest.json").is_err());
    }

    #[test]
    fn saves_lists_and_reads_shared_maps_in_temp_dir() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aifred-office-editor-test-{}",
            uuid::Uuid::new_v4()
        ));
        let sample_map = json!({
            "schema": "office-map/1.0",
            "name": "测试办公室",
            "width": 1280,
            "height": 720,
            "assets": [{ "id": "chair", "src": "assets/styles/topdown-soft/chair-top.png" }],
            "elements": [{ "id": "el-1", "assetId": "aifred-chair", "x": 100, "y": 100 }],
            "zones": [],
            "rooms": [{
                "id": "room-meet-1",
                "kind": "meeting",
                "bounds": { "x": 10, "y": 10, "width": 200, "height": 200 }
            }],
            "spots": [{ "id": "spot-1", "x": 50, "y": 50 }]
        });

        let saved =
            save_shared_map_in_dir(&temp_dir, "office-custom.json", sample_map, true).unwrap();
        assert_eq!(saved["file"], "office-custom.json");
        assert_eq!(saved["activeFile"], "office-custom.json");

        let listed = list_shared_maps_in_dir(&temp_dir).unwrap();
        assert_eq!(listed["activeFile"], "office-custom.json");
        assert_eq!(listed["files"].as_array().unwrap().len(), 1);

        let loaded = read_shared_map_in_dir(&temp_dir, "office-custom.json").unwrap();
        assert_eq!(
            loaded["map"]["assets"][0]["src"],
            "assets/office/topdown/chair-top.png"
        );
        assert_eq!(loaded["map"]["spots"][0]["roomId"], "room-meet-1");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn loopback_http_handler_serves_editor_assets_and_map_apis() {
        let temp_dir = std::env::temp_dir().join(format!(
            "aifred-office-editor-http-{}",
            uuid::Uuid::new_v4()
        ));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir_for_server = temp_dir.clone();

        let server_thread = std::thread::spawn(move || {
            for _ in 0..3 {
                let (stream, _) = listener.accept().unwrap();
                let dir = dir_for_server.clone();
                handle_http_connection_with(stream, Ok(dir), port, |rel| match rel {
                    "office-editor/index.html" => {
                        Some(b"<!doctype html><title>Editor</title>".to_vec())
                    }
                    "assets/office/desk.png" => Some(vec![137, 80, 78, 71]),
                    _ => None,
                });
            }
        });

        let send_http = |req: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.write_all(req.as_bytes()).unwrap();
            stream.flush().unwrap();
            let mut resp = Vec::new();
            stream.read_to_end(&mut resp).unwrap();
            String::from_utf8_lossy(&resp).into_owned()
        };

        let html_res = send_http("GET /office-editor/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert!(html_res.starts_with("HTTP/1.1 200 OK"));
        assert!(html_res.contains("<title>Editor</title>"));

        let aliased_asset = send_http(
            "GET /office-editor/assets/aifred/office/desk.png HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        );
        assert!(aliased_asset.starts_with("HTTP/1.1 200 OK"));
        assert!(aliased_asset.contains("Content-Type: image/png"));

        let payload = serde_json::to_string(&json!({
            "file": "http-saved.json",
            "setActive": true,
            "map": {
                "schema": "office-map/1.0",
                "name": "HTTP 测试布局",
                "width": 1600,
                "height": 1200,
                "assets": [],
                "elements": [],
                "zones": []
            }
        }))
        .unwrap();
        let save_req = format!(
            "POST /__office-editor/api/maps HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            payload
        );
        let save_res = send_http(&save_req);
        assert!(save_res.starts_with("HTTP/1.1 200 OK"));
        assert!(save_res.contains("\"activeFile\":\"http-saved.json\""));

        server_thread.join().unwrap();
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
