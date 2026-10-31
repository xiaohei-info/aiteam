//! Persistent grants for native local-file commands. Grants never widen the asset
//! protocol (which would expose a whole disk to the WebView). Only the native
//! directory picker can create a grant; callers cannot grant an arbitrary path.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Grants {
    pub startup_seen: bool,
    pub directories: Vec<PathBuf>,
}

#[derive(Default)]
pub struct FileAccessState {
    grants: Mutex<Option<Grants>>,
    picker: Mutex<()>,
    revision: AtomicU64,
}

#[derive(Serialize)]
pub struct AccessStatus {
    startup_seen: bool,
    directories: Vec<PathBuf>,
    platform: &'static str,
    suggested_root: PathBuf,
}

#[derive(Serialize)]
pub struct Selection {
    pub directories: Vec<PathBuf>,
    status: AccessStatus,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("local-file-access.json"))
}

fn read_grants(path: &Path) -> Result<Grants, String> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("无法读取目录授权记录：{e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Grants::default()),
        Err(e) => Err(format!("无法读取目录授权记录：{e}")),
    }
}

fn load(app: &tauri::AppHandle, value: &mut Option<Grants>) -> Result<(), String> {
    if value.is_none() {
        *value = Some(read_grants(&store_path(app)?)?);
    }
    Ok(())
}

fn save(app: &tauri::AppHandle, grants: &Grants) -> Result<(), String> {
    save_grants(&store_path(app)?, grants)
}

fn save_grants(path: &Path, grants: &Grants) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    let result = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(grants).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

fn suggested_root(app: &tauri::AppHandle) -> PathBuf {
    // Windows has one root per volume. Start on the user's volume; the picker
    // permits selecting additional drive roots or UNC shares independently.
    app.path()
        .home_dir()
        .ok()
        .and_then(|home| home.ancestors().last().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from(std::path::MAIN_SEPARATOR.to_string()))
}

fn status(app: &tauri::AppHandle, grants: &Grants) -> AccessStatus {
    AccessStatus {
        startup_seen: grants.startup_seen,
        directories: grants.directories.clone(),
        platform: std::env::consts::OS,
        suggested_root: suggested_root(app),
    }
}

fn covered(grants: &Grants, canonical: &Path) -> bool {
    // Re-resolve the root too: a removed root or redirected symlink must not
    // silently turn a historical grant into access to a different location.
    grants.directories.iter().any(|root| {
        root.canonicalize()
            .is_ok_and(|resolved| resolved == *root && canonical.starts_with(&resolved))
    })
}

pub fn is_allowed(app: &tauri::AppHandle, canonical: &Path) -> Result<bool, String> {
    let state = app.state::<FileAccessState>();
    let mut value = state.grants.lock().map_err(|e| e.to_string())?;
    load(app, &mut value)?;
    Ok(covered(value.as_ref().unwrap(), canonical))
}

/// A knowledge operation holds the same lock as revocation until it finishes.
/// Re-read disk too: corruption or a missing authority record closes the channel.
#[cfg(target_os = "macos")]
pub fn with_knowledge_access<T>(
    app: &tauri::AppHandle,
    canonical: &Path,
    action: impl FnOnce(u64) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<FileAccessState>();
    let _guard = state
        .grants
        .lock()
        .map_err(|_| "authorization_unavailable")?;
    let path = store_path(app)?;
    if !path.is_file() {
        return Err("authorization_unavailable".into());
    }
    let grants = read_grants(&path).map_err(|_| "authorization_unavailable")?;
    if !covered(&grants, canonical) {
        return Err("unauthorized".into());
    }
    action(state.revision.load(Ordering::Acquire))
}

pub fn io_error(path: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        format!(
            "LOCAL_OS_PERMISSION_DENIED: 系统拒绝访问 {}，请检查系统文件权限后重试。",
            path.display()
        )
    } else {
        format!("无法读取 {}：{error}", path.display())
    }
}

#[tauri::command]
pub fn local_file_access_status(
    app: tauri::AppHandle,
    state: State<'_, FileAccessState>,
) -> Result<AccessStatus, String> {
    let mut value = state.grants.lock().map_err(|e| e.to_string())?;
    load(&app, &mut value)?;
    Ok(status(&app, value.as_ref().unwrap()))
}

#[tauri::command]
pub fn dismiss_file_access_startup(
    app: tauri::AppHandle,
    state: State<'_, FileAccessState>,
) -> Result<(), String> {
    let mut value = state.grants.lock().map_err(|e| e.to_string())?;
    load(&app, &mut value)?;
    let mut next = value.as_ref().unwrap().clone();
    next.startup_seen = true;
    save(&app, &next)?;
    *value = Some(next);
    Ok(())
}

#[tauri::command]
pub async fn select_file_access_directories(
    app: tauri::AppHandle,
    default_path: Option<String>,
) -> Result<Selection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<FileAccessState>();
        let _picker = state
            .picker
            .try_lock()
            .map_err(|_| "目录授权窗口已打开，请先完成当前选择".to_string())?;
        // Never hold the grant lock across a native dialog: status/revoke
        // commands must remain responsive while it is open.
        let revision = state.revision.load(Ordering::Acquire);
        let initial = default_path
            .map(PathBuf::from)
            .map(|path| {
                if path.is_file() {
                    path.parent().unwrap_or(&path).to_path_buf()
                } else {
                    path
                }
            })
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| suggested_root(&app));
        let mut picker = app
            .dialog()
            .file()
            .set_title("授权本地文件访问：选择磁盘根目录或文件夹（可多选）")
            .set_directory(initial);
        if let Some(window) = app.get_webview_window("main") {
            picker = picker.set_parent(&window);
        }
        let selected = picker.blocking_pick_folders();
        let mut directories = Vec::new();
        if let Some(selected) = selected {
            for item in selected {
                let path = item.into_path().map_err(|e| e.to_string())?;
                let canonical = path.canonicalize().map_err(|e| io_error(&path, e))?;
                if !canonical.is_dir() {
                    return Err("请选择目录".into());
                }
                // Directory selection does not supersede TCC / ACL restrictions.
                std::fs::read_dir(&canonical).map_err(|e| io_error(&canonical, e))?;
                directories.push(canonical);
            }
        }
        let mut value = state.grants.lock().map_err(|e| e.to_string())?;
        load(&app, &mut value)?;
        if revision != state.revision.load(Ordering::Acquire) {
            return Err("授权设置已改变，请重新选择目录".into());
        }
        if !directories.is_empty() {
            let mut next = value.as_ref().unwrap().clone();
            next.startup_seen = true;
            for path in &directories {
                if !next.directories.iter().any(|root| path.starts_with(root)) {
                    next.directories.retain(|root| !root.starts_with(path));
                    next.directories.push(path.clone());
                }
            }
            save(&app, &next)?;
            *value = Some(next);
            state.revision.fetch_add(1, Ordering::Release);
        }
        Ok(Selection {
            directories,
            status: status(&app, value.as_ref().unwrap()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn revoke_file_access(
    app: tauri::AppHandle,
    state: State<'_, FileAccessState>,
    directory: Option<PathBuf>,
) -> Result<AccessStatus, String> {
    let mut value = state.grants.lock().map_err(|e| e.to_string())?;
    load(&app, &mut value)?;
    let mut next = value.as_ref().unwrap().clone();
    match directory {
        Some(path) => next.directories.retain(|root| *root != path),
        None => next.directories.clear(),
    }
    // Revoking is a persistent choice, not an invitation to prompt next launch.
    next.startup_seen = true;
    save(&app, &next)?;
    *value = Some(next);
    state.revision.fetch_add(1, Ordering::Release);
    Ok(status(&app, value.as_ref().unwrap()))
}

#[tauri::command]
pub fn open_file_privacy_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer.exe")
        .arg("ms-settings:privacy-broadfilesystemaccess")
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("请在系统文件管理器中检查目录权限".into());
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_and_revocation_survive_disk_reload() {
        let base = std::env::temp_dir().join(format!("aifred-access-{}", uuid::Uuid::new_v4()));
        let path = base.join("grants.json");
        assert!(!read_grants(&path).unwrap().startup_seen);
        std::fs::create_dir_all(&base).unwrap();
        let mut grants = Grants {
            startup_seen: true,
            directories: vec![base.canonicalize().unwrap()],
        };
        save_grants(&path, &grants).unwrap();
        assert!(covered(
            &read_grants(&path).unwrap(),
            &base.canonicalize().unwrap()
        ));
        grants.directories.clear();
        save_grants(&path, &grants).unwrap();
        let restarted = read_grants(&path).unwrap();
        assert!(restarted.startup_seen);
        assert!(restarted.directories.is_empty());
        assert!(!path.with_extension("tmp").exists());
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(read_grants(&path).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn grants_use_components_and_can_be_revoked() {
        let base = std::env::temp_dir().join(format!("aifred-access-{}", uuid::Uuid::new_v4()));
        let root = base.join("allowed");
        let sibling = base.join("allowed-other");
        std::fs::create_dir_all(root.join("child")).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let mut grants = Grants {
            startup_seen: true,
            directories: vec![root.canonicalize().unwrap()],
        };
        assert!(covered(
            &grants,
            &root.join("child").canonicalize().unwrap()
        ));
        assert!(!covered(&grants, &sibling.canonicalize().unwrap()));
        let restored: Grants =
            serde_json::from_slice(&serde_json::to_vec(&grants).unwrap()).unwrap();
        assert!(covered(&restored, &root.canonicalize().unwrap()));
        grants.directories.clear();
        assert!(!covered(&grants, &root.canonicalize().unwrap()));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_outside_grant_is_denied() {
        let base = std::env::temp_dir().join(format!("aifred-access-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(base.join("allowed")).unwrap();
        std::fs::create_dir_all(base.join("outside")).unwrap();
        std::os::unix::fs::symlink(base.join("outside"), base.join("allowed/link")).unwrap();
        let grants = Grants {
            startup_seen: true,
            directories: vec![base.join("allowed").canonicalize().unwrap()],
        };
        assert!(!covered(
            &grants,
            &base.join("allowed/link").canonicalize().unwrap()
        ));
        std::fs::remove_dir_all(base).unwrap();
    }
}
