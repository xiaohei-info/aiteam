//! Metadata-only local diagnostics. No environment, credentials, sessions or raw stderr export.
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

static LOCK: Mutex<()> = Mutex::new(());
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_EXPORT: u64 = 10 * 1024 * 1024;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}
fn identity(value: &str) -> bool {
    (value.len() == 32 || value.len() == 36)
        && value.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
        || value.starts_with("req_")
            && value.len() == 36
            && value[4..].bytes().all(|c| c.is_ascii_hexdigit())
}
fn safe_fields(input: &Value) -> Value {
    let mut fields = Map::new();
    if let Some(object) = input.as_object() {
        for (key, value) in object {
            let allowed = match key.as_str() {
                "status" | "duration_ms" | "count" | "retry" | "dropped" | "port" | "exit_code" => {
                    value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
                }
                "request_id" | "server_request_id" | "trace_id" | "conversation_id" | "work_id"
                | "employee_id" | "source_id" | "tenant_id" => value.as_str().is_some_and(identity),
                "method" | "outcome" | "phase" | "view" | "dependency" | "code" | "error_type"
                | "source_type" | "connection_mode" => value.as_str().is_some_and(|s| token(s, 64)),
                "route" => value.as_str().is_some_and(|s| {
                    s.starts_with('/')
                        && s.len() <= 240
                        && s.bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"/_-:{}.*".contains(&c))
                }),
                "origin" => value
                    .as_str()
                    .and_then(|s| reqwest::Url::parse(s).ok())
                    .is_some_and(|url| {
                        matches!(url.scheme(), "http" | "https")
                            && url.username().is_empty()
                            && url.password().is_none()
                            && url.query().is_none()
                            && url.fragment().is_none()
                            && url.path() == "/"
                    }),
                _ => false,
            };
            if allowed {
                fields.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(fields)
}
fn sanitize(input: &Value) -> Option<Value> {
    let event = input.get("event")?.as_str()?;
    if !token(event, 80) {
        return None;
    }
    let level = input.get("level")?.as_str()?;
    if !["debug", "info", "warn", "error"].contains(&level) {
        return None;
    }
    let service = input.get("service")?.as_str()?;
    if !["desktop-ui", "desktop-host", "agent"].contains(&service) {
        return None;
    }
    let timestamp = input
        .get("timestamp")
        .filter(|v| {
            v.as_u64().is_some()
                || v.as_str().is_some_and(|s| {
                    s.len() <= 35
                        && s.bytes()
                            .all(|c| c.is_ascii_digit() || b"-:T.Z+".contains(&c))
                })
        })
        .cloned()
        .unwrap_or(json!(now()));
    let mut record = json!({"schema_version":1, "timestamp":timestamp, "service":service, "level":level, "event":event, "fields":safe_fields(input.get("fields").unwrap_or(input))});
    if let Some(id) = input
        .get("instance_id")
        .and_then(Value::as_str)
        .filter(|s| identity(s))
    {
        record["instance_id"] = json!(id);
    }
    Some(record)
}
fn private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(std::io::Error::other("Unsafe log directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn append(path: &Path, record: &Value) -> std::io::Result<()> {
    let _guard = LOCK
        .lock()
        .map_err(|_| std::io::Error::other("Log lock unavailable"))?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("Invalid log path"))?;
    private_directory(parent)?;
    let line = serde_json::to_string(record)? + "\n";
    if line.len() > 8192 {
        return Ok(());
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(std::io::Error::other("Unsafe log file"));
        }
        if metadata.len() + line.len() as u64 > MAX_FILE {
            for index in (1..=3).rev() {
                let target = PathBuf::from(format!("{}.{}", path.display(), index));
                let source = if index == 1 {
                    path.to_path_buf()
                } else {
                    PathBuf::from(format!("{}.{}", path.display(), index - 1))
                };
                if target.exists() {
                    fs::remove_file(&target)?;
                }
                if source.exists() {
                    fs::rename(source, target)?;
                }
            }
        }
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(line.as_bytes())
}
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn host_event(root: &Path, event: &str, level: &str) {
    host_event_fields(root, event, level, json!({}));
}
/// Host lifecycle events carry only allow-listed fields, so a numeric exit code or
/// an error token can be recorded without ever persisting raw child output.
pub fn host_event_fields(root: &Path, event: &str, level: &str, fields: Value) {
    let _ = append(
        &root.join("logs/desktop.jsonl"),
        &json!({"schema_version":1,"timestamp":now(),"service":"desktop-host","event":event,"level":level,"fields":safe_fields(&fields)}),
    );
}
/// Consume child pipes in bounded chunks. Raw output is never persisted or exported.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn capture_child(reader: impl Read + Send + 'static, path: PathBuf) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut pending = Vec::new();
        let mut overflow = false;
        let mut warned = false;
        while let Ok(buffer) = reader.fill_buf() {
            if buffer.is_empty() {
                break;
            }
            let length = buffer.len();
            for byte in buffer {
                if *byte == b'\n' {
                    let record = if !overflow {
                        serde_json::from_slice::<Value>(&pending)
                            .ok()
                            .and_then(|v| sanitize(&v))
                    } else {
                        None
                    };
                    if let Some(record) = record {
                        let _ = append(&path, &record);
                    } else if !warned {
                        let _ = append(
                            &path,
                            &json!({"timestamp":now(),"service":"desktop-host","level":"warn","event":"agent.unstructured_output_omitted","fields":{}}),
                        );
                        warned = true;
                    }
                    pending.clear();
                    overflow = false;
                } else if pending.len() < 8192 {
                    pending.push(*byte);
                } else {
                    overflow = true;
                }
            }
            reader.consume(length);
        }
    });
}
#[tauri::command]
pub fn append_application_logs(app: tauri::AppHandle, records: Vec<Value>) -> Result<(), String> {
    if records.len() > 100 {
        return Err("日志批次过大".into());
    }
    let root = app.path().app_data_dir().map_err(|_| "日志目录不可用")?;
    for value in records {
        if value.get("service").and_then(Value::as_str) != Some("desktop-ui") {
            return Err("日志来源无效".into());
        }
        let record = sanitize(&value).ok_or("日志格式无效")?;
        append(&root.join("logs/desktop.jsonl"), &record).map_err(|_| "本机日志写入失败")?;
    }
    Ok(())
}
fn collect(root: &Path) -> Value {
    let mut files: Vec<PathBuf> = Vec::new();
    for (relative, prefix) in [("logs", "desktop.jsonl"), ("agent-data/logs", "agent-")] {
        let dir = root.join(relative);
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
            if let Ok(entries) = fs::read_dir(dir) {
                files.extend(entries.flatten().map(|e| e.path()).filter(|p| {
                    p.file_name()
                        .and_then(|v| v.to_str())
                        .is_some_and(|name| name.starts_with(prefix))
                }));
            }
        }
    }
    // agent.log is filtered through sanitize again: pre-upgrade raw files are never copied verbatim.
    files.push(root.join("agent.log"));
    files.sort_by_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).ok()));
    let mut records = Vec::new();
    let mut bytes = 0;
    let mut omitted = 0;
    let mut truncated = false;
    for path in files {
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.len() > MAX_FILE + 8192 || bytes + metadata.len() > MAX_EXPORT {
            truncated = true;
            continue;
        }
        let Ok(file) = fs::File::open(path) else {
            omitted += 1;
            continue;
        };
        bytes += metadata.len();
        let mut data = String::new();
        if file
            .take(MAX_FILE + 8192)
            .read_to_string(&mut data)
            .is_err()
        {
            omitted += 1;
            continue;
        }
        for line in data.lines() {
            if records.len() >= 20_000 {
                truncated = true;
                break;
            }
            if let Some(record) = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| sanitize(&v))
            {
                records.push(record);
            } else {
                omitted += 1;
            }
        }
    }
    json!({"schema_version":1,"generated_at":now(),"client_version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"records":records,"truncated":truncated,"omitted_lines":omitted,"scope":"local_device_only","excludes":["credentials","chat_content","raw_runtime_events","remote_manager_logs","remote_operation_logs"]})
}
#[tauri::command]
pub async fn application_log_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    let root = app.path().app_data_dir().map_err(|_| "日志目录不可用")?;
    tauri::async_runtime::spawn_blocking(move || collect(&root))
        .await
        .map_err(|_| "读取日志失败".into())
}
#[tauri::command]
pub async fn export_application_logs(app: tauri::AppHandle) -> Result<bool, String> {
    // Path originates in the native save dialog, never an arbitrary IPC path argument.
    tauri::async_runtime::spawn_blocking(move || {
        let root = app.path().app_data_dir().map_err(|_| "日志目录不可用")?;
        let Some(destination) = app
            .dialog()
            .file()
            .add_filter("诊断日志", &["json"])
            .set_file_name(format!("aifred-diagnostics-{}.json", now()))
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = destination.into_path().map_err(|_| "请选择本机文件路径")?;
        let bundle = collect(&root);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|_| "保存失败：请选择新的文件名，不覆盖已有文件")?;
        file.write_all(
            serde_json::to_string_pretty(&bundle)
                .map_err(|_| "日志编码失败")?
                .as_bytes(),
        )
        .map_err(|_| "日志保存失败")?;
        Ok(true)
    })
    .await
    .map_err(|_| "日志导出失败")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privacy_and_rotation() {
        let root = std::env::temp_dir().join(format!("aifred-logs-{}", uuid::Uuid::new_v4()));
        let input = json!({"event":"http.finished","level":"info","service":"desktop-ui","message":"secret","fields":{"body":"private chat","authorization":"secret","status":200,"origin":"https://user:secret@host/path?token=secret","request_id":"secret"}});
        let record = sanitize(&input).unwrap();
        assert!(!record.to_string().contains("secret"));
        assert!(!record.to_string().contains("private chat"));
        let path = root.join("logs/desktop.jsonl");
        append(&path, &record).unwrap();
        assert_eq!(collect(&root)["records"].as_array().unwrap().len(), 1);
        fs::write(&path, vec![b'x'; MAX_FILE as usize]).unwrap();
        append(&path, &record).unwrap();
        assert!(PathBuf::from(format!("{}.1", path.display())).exists());
        assert_eq!(collect(&root)["records"].as_array().unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn export_does_not_follow_symlinks() {
        let root = std::env::temp_dir().join(format!("aifred-logs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join("secret"), "password sentinel").unwrap();
        std::os::unix::fs::symlink(root.join("secret"), root.join("logs/desktop.jsonl")).unwrap();
        assert!(collect(&root)["records"].as_array().unwrap().is_empty());
        assert!(!collect(&root).to_string().contains("sentinel"));
        fs::remove_dir_all(root).unwrap();
    }
}
