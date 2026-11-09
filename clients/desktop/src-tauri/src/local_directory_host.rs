//! Private desktop → Agent authority channel. Credentials never enter the WebView.
use crate::agent_projects::{file_id, resolve_project_dir, AgentProjectsState};
use crate::{file_access, local_directory_reader::SourceRoot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(Clone)]
pub struct ChannelConfig {
    pub socket: PathBuf,
    pub token: String,
}
struct Pending {
    tenant: String,
    member: String,
    expires: Instant,
    resource: Option<Value>,
    /// Kept apart from `resource`: a project ticket never registers a knowledge directory, nor the reverse.
    project: Option<Value>,
}
struct Bridge {
    config: ChannelConfig,
    pending: Mutex<HashMap<String, Pending>>,
    epoch: String,
}
static BRIDGE: OnceLock<Arc<Bridge>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    token: String,
    operation: String,
    #[serde(default)]
    tenant_id: String,
    #[serde(default)]
    member_id: String,
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    canonical_path: PathBuf,
    #[serde(default)]
    root_identity: String,
    #[serde(default)]
    relative_path: PathBuf,
}

pub fn config() -> Option<ChannelConfig> {
    BRIDGE.get().map(|bridge| bridge.config.clone())
}

fn socket_directory() -> PathBuf {
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..16];
    let candidate = std::env::temp_dir().join(format!("akb-{suffix}"));
    // macOS sockaddr_un.sun_path is 104 bytes (103 chars + NUL). Fall back to /tmp if TMPDIR is too long.
    if candidate.join("s.sock").as_os_str().len() < 100 {
        candidate
    } else {
        PathBuf::from("/tmp").join(format!("akb-{suffix}"))
    }
}

pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    if BRIDGE.get().is_some() {
        return Ok(());
    }
    let directory = socket_directory();
    std::fs::create_dir(&directory).map_err(|_| "host_channel_unavailable")?;
    if std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).is_err() {
        let _ = std::fs::remove_dir_all(&directory);
        return Err("host_channel_unavailable".into());
    }
    let socket = directory.join("s.sock");
    let listener = match UnixListener::bind(&socket) {
        Ok(listener) => listener,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&directory);
            return Err("host_channel_unavailable".into());
        }
    };
    if std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).is_err() {
        let _ = std::fs::remove_dir_all(&directory);
        return Err("host_channel_unavailable".into());
    }
    let bridge = Arc::new(Bridge {
        config: ChannelConfig {
            socket,
            token: format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()),
        },
        pending: Mutex::new(HashMap::new()),
        epoch: uuid::Uuid::new_v4().to_string(),
    });
    BRIDGE
        .set(bridge.clone())
        .map_err(|_| "host_channel_already_started")?;
    std::thread::spawn(move || {
        // One bounded request at a time; malformed clients cannot allocate workers.
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            let response = match BufReader::new((&stream).take(16_385)).read_line(&mut line) {
                Ok(_) if line.len() <= 16_384 && line.ends_with('\n') => {
                    serde_json::from_str::<Request>(&line)
                        .map_err(|_| "invalid_request".to_string())
                        .and_then(|request| bridge.handle(&app, request))
                }
                _ => Err("invalid_request".into()),
            };
            let value = match response {
                Ok(data) => json!({"data": data}),
                Err(code) => json!({"error": code}),
            };
            if let Ok(bytes) = serde_json::to_vec(&value) {
                let _ = stream.write_all(&bytes);
                let _ = stream.write_all(b"\n");
            }
        }
        let _ = std::fs::remove_dir_all(directory);
    });
    Ok(())
}

impl Bridge {
    fn handle(&self, app: &tauri::AppHandle, request: Request) -> Result<Value, String> {
        if request.token != self.config.token {
            return Err("unauthorized".into());
        }
        match request.operation.as_str() {
            "status" => Ok(
                json!({"epoch": self.epoch, "platform": "darwin", "formats": ["txt", "md", "markdown", "csv", "json", "log"]}),
            ),
            "challenge" => {
                if request.tenant_id.is_empty()
                    || request.member_id.is_empty()
                    || request.tenant_id.len() > 200
                    || request.member_id.len() > 200
                {
                    return Err("unauthorized".into());
                }
                let mut pending = self
                    .pending
                    .lock()
                    .map_err(|_| "authorization_unavailable")?;
                pending.retain(|_, value| value.expires > Instant::now());
                if pending.len() >= 64 {
                    return Err("budget_exhausted".into());
                }
                let ticket = uuid::Uuid::new_v4().to_string();
                pending.insert(
                    ticket.clone(),
                    Pending {
                        tenant: request.tenant_id,
                        member: request.member_id,
                        expires: Instant::now() + Duration::from_secs(120),
                        resource: None,
                        project: None,
                    },
                );
                Ok(json!({"challenge": ticket}))
            }
            "consume" => {
                let mut pending = self
                    .pending
                    .lock()
                    .map_err(|_| "authorization_unavailable")?;
                let value = pending.remove(&request.ticket).ok_or("citation_expired")?;
                if value.expires <= Instant::now()
                    || value.tenant != request.tenant_id
                    || value.member != request.member_id
                {
                    return Err("unauthorized".into());
                }
                let resource = value.resource.ok_or("unauthorized")?;
                let path = Path::new(resource["canonical_path"].as_str().ok_or("unauthorized")?);
                file_access::with_knowledge_access(app, path, |revision| {
                    if resource["authorization_revision"].as_u64() != Some(revision) {
                        return Err("unauthorized".into());
                    }
                    SourceRoot::open(path, resource["root_identity"].as_str())?;
                    Ok(resource.clone())
                })
            }
            "consume_project" => take_project_ticket(
                &self.pending,
                &request.ticket,
                &request.tenant_id,
                &request.member_id,
            ),
            "check" | "list" | "read" => {
                file_access::with_knowledge_access(app, &request.canonical_path, |revision| {
                    reject_runtime_roots(app, &request.canonical_path)?;
                    let protected = protected_roots(app)?;
                    let target = request.canonical_path.join(&request.relative_path);
                    if is_protected(&target, &protected) {
                        return Err("source_overlaps_runtime".into());
                    }
                    if request.root_identity.is_empty() {
                        return Err("unauthorized".into());
                    }
                    let root =
                        SourceRoot::open(&request.canonical_path, Some(&request.root_identity))?;
                    let authority = format!("{}:{revision}", self.epoch);
                    match request.operation.as_str() {
                        "list" => {
                            let (entries, partial) = root.list(&request.relative_path, 2048)?;
                            // A grant may sit above protected paths (e.g. "/"); never list into them.
                            let entries = entries
                                .into_iter()
                                .filter(|(name, _)| !is_protected(&target.join(name), &protected));
                            Ok(
                                json!({"authority": authority, "entries": entries.map(|(name,directory)| json!({"name":name,"directory":directory})).collect::<Vec<_>>(), "partial": partial}),
                            )
                        }
                        "read" => {
                            let (text, version) = root.read_text(&request.relative_path)?;
                            Ok(
                                json!({"authority": authority, "text": text, "content_version": version}),
                            )
                        }
                        _ => Ok(json!({"authority": authority})),
                    }
                })
            }
            _ => Err("unsupported_operation".into()),
        }
    }
}

// Runtime allowlists and Agent state that no registered source may expose.
fn protected_roots(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut protected = vec![
        PathBuf::from("/System"),
        PathBuf::from("/usr"),
        PathBuf::from("/bin"),
        PathBuf::from("/sbin"),
        PathBuf::from("/Library/Apple"),
        PathBuf::from("/dev"),
        PathBuf::from("/opt"),
    ];
    protected.push(
        app.path()
            .app_data_dir()
            .map_err(|_| "authorization_unavailable")?,
    );
    protected.push(
        app.path()
            .resource_dir()
            .map_err(|_| "authorization_unavailable")?,
    );
    if cfg!(debug_assertions) {
        protected.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent/runtime"));
    }
    Ok(protected)
}

/// True when `path` is a protected root or inside one. Compared per component and
/// case-insensitively because default macOS volumes ignore case.
fn is_protected(path: &Path, protected: &[PathBuf]) -> bool {
    let lower = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let target = lower(path);
    protected
        .iter()
        .any(|root| target.starts_with(&lower(root)))
}

// A source may be an ancestor of protected paths (whole disk, home directory); the
// protected subtrees are excluded again on every list/read. Only a source that is
// itself inside a protected tree is refused.
fn reject_runtime_roots(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    if is_protected(path, &protected_roots(app)?) {
        return Err("source_overlaps_runtime".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct RegistrationSelection {
    ticket: String,
}

pub async fn select_local_knowledge_directory(
    app: tauri::AppHandle,
    challenge: String,
) -> Result<RegistrationSelection, String> {
    let bridge = BRIDGE.get().ok_or("authorization_unavailable")?.clone();
    let pending = take_challenge(&bridge.pending, &challenge)?;
    let selected = file_access::select_file_access_directories(app.clone(), None).await?;
    let path = selected.directories.first().ok_or("cancelled")?;
    reject_runtime_roots(&app, path)?;
    file_access::with_knowledge_access(&app, path, |revision| {
        let root = SourceRoot::open(path, None)?;
        let ticket = uuid::Uuid::new_v4().to_string();
        let resource = json!({"canonical_path": path, "display_name": path.file_name().unwrap_or_default().to_string_lossy(), "root_identity": root.identity(), "authorization_revision": revision});
        bridge
            .pending
            .lock()
            .map_err(|_| "authorization_unavailable")?
            .insert(
                ticket.clone(),
                Pending {
                    resource: Some(resource),
                    expires: Instant::now() + Duration::from_secs(30),
                    ..pending
                },
            );
        Ok(RegistrationSelection { ticket })
    })
}

/// Removes a challenge that has not been turned into a ticket yet.
fn take_challenge(
    pending: &Mutex<HashMap<String, Pending>>,
    challenge: &str,
) -> Result<Pending, String> {
    let value = pending
        .lock()
        .map_err(|_| "authorization_unavailable")?
        .remove(challenge)
        .ok_or("citation_expired")?;
    if value.expires <= Instant::now() || value.resource.is_some() || value.project.is_some() {
        return Err("citation_expired".into());
    }
    Ok(value)
}

/// An employee writes in a project folder, so unlike a knowledge source it may neither sit inside
/// protected data nor contain it. Root and the home folder are never a project.
fn project_folder_allowed(path: &Path, home: &Path, protected: &[PathBuf]) -> bool {
    let inside = |candidate: &Path, parent: &Path| is_protected(candidate, &[parent.to_path_buf()]);
    path.parent().is_some()
        && !inside(home, path)
        && !is_protected(path, protected)
        && !protected.iter().any(|root| inside(root, path))
}

/// Turns a challenge into a one-time ticket for a listed project. The host resolves the folder again
/// from the source and opaque id, so the WebView never names a path.
pub async fn authorize_project_workspace(
    app: tauri::AppHandle,
    projects: AgentProjectsState,
    challenge: String,
    source: String,
    project_id: String,
) -> Result<RegistrationSelection, String> {
    // The Agent resolves Fred projects itself, from the member's own conversations.
    if source == "fred" {
        return Err("invalid_source".into());
    }
    let bridge = BRIDGE.get().ok_or("authorization_unavailable")?.clone();
    let pending = take_challenge(&bridge.pending, &challenge)?;
    let project = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let dir = resolve_project_dir(&app, &projects, &source, &project_id)?
            .canonicalize()
            .map_err(|_| "project_not_found")?;
        let home = app
            .path()
            .home_dir()
            .map_err(|_| "authorization_unavailable")?;
        if !project_folder_allowed(&dir, &home, &protected_roots(&app)?) {
            return Err("source_overlaps_runtime".into());
        }
        // The id is the workbench's own project id, so the WebView can find this conversation again.
        Ok(json!({"canonical_path": dir, "source": source, "project_id": project_id}))
    })
    .await
    .map_err(|_| "authorization_unavailable")??;
    issue_project_ticket(&bridge, pending, project)
}

/// Source of a ticket for a folder the user picked to relocate a project. The Agent accepts it only
/// for moving an existing project conversation, never for creating one.
const PICKED_FOLDER_SOURCE: &str = "folder";

/// Lets the user pick the new location of a project that moved. Unlike the knowledge picker this
/// records no file access grant: the folder only becomes the conversation's working directory.
pub async fn select_project_folder(
    app: tauri::AppHandle,
    challenge: String,
    default_path: Option<String>,
) -> Result<RegistrationSelection, String> {
    let bridge = BRIDGE.get().ok_or("authorization_unavailable")?.clone();
    let pending = take_challenge(&bridge.pending, &challenge)?;
    let project = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let mut picker = app.dialog().file().set_title("选择项目现在所在的文件夹");
        if let Some(initial) = default_path
            .map(PathBuf::from)
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .filter(|path| path.is_dir())
        {
            picker = picker.set_directory(initial);
        }
        if let Some(window) = app.get_webview_window("main") {
            picker = picker.set_parent(&window);
        }
        let selected = picker.blocking_pick_folder().ok_or("cancelled")?;
        let dir = selected
            .into_path()
            .map_err(|_| "project_not_found")?
            .canonicalize()
            .map_err(|_| "project_not_found")?;
        if !dir.is_dir() {
            return Err("project_not_found".into());
        }
        let home = app
            .path()
            .home_dir()
            .map_err(|_| "authorization_unavailable")?;
        if !project_folder_allowed(&dir, &home, &protected_roots(&app)?) {
            return Err("source_overlaps_runtime".into());
        }
        // Same id the workbench gives a folder, so a moved project is found again where it is now.
        let project_id = file_id(&dir.to_string_lossy());
        Ok(json!({"canonical_path": dir, "source": PICKED_FOLDER_SOURCE, "project_id": project_id}))
    })
    .await
    .map_err(|_| "authorization_unavailable")??;
    issue_project_ticket(&bridge, pending, project)
}

/// Stores a resolved project folder under a fresh one-time ticket, valid for 30 seconds.
fn issue_project_ticket(
    bridge: &Bridge,
    pending: Pending,
    project: Value,
) -> Result<RegistrationSelection, String> {
    let ticket = uuid::Uuid::new_v4().to_string();
    bridge
        .pending
        .lock()
        .map_err(|_| "authorization_unavailable")?
        .insert(
            ticket.clone(),
            Pending {
                project: Some(project),
                expires: Instant::now() + Duration::from_secs(30),
                ..pending
            },
        );
    Ok(RegistrationSelection { ticket })
}

/// Redeems a project ticket once, for the member it was issued to.
fn take_project_ticket(
    pending: &Mutex<HashMap<String, Pending>>,
    ticket: &str,
    tenant: &str,
    member: &str,
) -> Result<Value, String> {
    let value = pending
        .lock()
        .map_err(|_| "authorization_unavailable")?
        .remove(ticket)
        .ok_or("citation_expired")?;
    if value.expires <= Instant::now() || value.tenant != tenant || value.member != member {
        return Err("unauthorized".into());
    }
    value.project.ok_or_else(|| "unauthorized".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_with(
        entries: Vec<(&str, Option<Value>, Option<Value>, Duration)>,
    ) -> Mutex<HashMap<String, Pending>> {
        Mutex::new(
            entries
                .into_iter()
                .map(|(key, resource, project, ttl)| {
                    (
                        key.to_string(),
                        Pending {
                            tenant: "t".into(),
                            member: "m".into(),
                            expires: Instant::now() + ttl,
                            resource,
                            project,
                        },
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn project_tickets_are_one_time_and_bound_to_the_member() {
        let ttl = Duration::from_secs(30);
        let project = json!({"canonical_path": "/work/app", "source": "codex"});
        let pending = pending_with(vec![
            ("ok", None, Some(project.clone()), ttl),
            ("other-member", None, Some(project.clone()), ttl),
            ("expired", None, Some(project.clone()), Duration::ZERO),
        ]);
        assert_eq!(
            take_project_ticket(&pending, "ok", "t", "m").unwrap(),
            project
        );
        assert_eq!(
            take_project_ticket(&pending, "ok", "t", "m").unwrap_err(),
            "citation_expired"
        );
        assert_eq!(
            take_project_ticket(&pending, "other-member", "t", "x").unwrap_err(),
            "unauthorized"
        );
        assert_eq!(
            take_project_ticket(&pending, "other-member", "t", "m").unwrap_err(),
            "citation_expired",
            "a refused attempt still uses the ticket up"
        );
        assert_eq!(
            take_project_ticket(&pending, "expired", "t", "m").unwrap_err(),
            "unauthorized"
        );
    }

    #[test]
    fn project_and_knowledge_tickets_are_not_interchangeable() {
        let ttl = Duration::from_secs(30);
        let pending = pending_with(vec![
            ("challenge", None, None, ttl),
            ("knowledge", Some(json!({})), None, ttl),
            ("project", None, Some(json!({})), ttl),
        ]);
        // An unused challenge and a knowledge ticket redeem no project.
        assert!(take_project_ticket(&pending, "challenge", "t", "m").is_err());
        assert!(take_project_ticket(&pending, "knowledge", "t", "m").is_err());
        // A ticket cannot be turned into another ticket.
        assert!(take_challenge(&pending, "project").is_err());
    }

    #[test]
    fn only_a_fresh_challenge_can_be_authorized() {
        let ttl = Duration::from_secs(30);
        let pending = pending_with(vec![
            ("fresh", None, None, ttl),
            ("expired", None, None, Duration::ZERO),
            ("knowledge", Some(json!({})), None, ttl),
        ]);
        assert!(take_challenge(&pending, "fresh").is_ok());
        assert!(take_challenge(&pending, "fresh").is_err());
        assert!(take_challenge(&pending, "expired").is_err());
        assert!(take_challenge(&pending, "knowledge").is_err());
    }

    #[test]
    fn project_folders_exclude_root_home_and_protected_data() {
        let home = Path::new("/Users/a");
        let protected = vec![
            PathBuf::from("/System"),
            PathBuf::from("/Users/a/Library/Application Support/com.aiteam.desktop"),
        ];
        let allowed = |path: &str| project_folder_allowed(Path::new(path), home, &protected);
        assert!(allowed("/Users/a/Documents/app"));
        assert!(allowed("/Users/a/WorkBuddy/20260101"));
        assert!(allowed("/Systemx"));
        assert!(!allowed("/"));
        assert!(!allowed("/Users"), "holds the home folder");
        assert!(!allowed("/Users/a"), "the home folder");
        assert!(!allowed("/System/Library"), "inside protected data");
        assert!(!allowed("/Users/a/Library"), "holds the app's data folder");
        assert!(!allowed(
            "/Users/a/Library/Application Support/com.aiteam.desktop/agent"
        ));
    }

    #[test]
    fn protected_paths_are_excluded_but_ancestors_are_allowed() {
        let protected = vec![
            PathBuf::from("/System"),
            PathBuf::from("/Users/a/Library/Application Support/com.aiteam.desktop"),
        ];
        assert!(!is_protected(Path::new("/"), &protected));
        assert!(!is_protected(Path::new("/Users/a"), &protected));
        assert!(!is_protected(Path::new("/Users/a/Documents"), &protected));
        assert!(!is_protected(Path::new("/Systemx"), &protected));
        assert!(is_protected(Path::new("/System"), &protected));
        assert!(is_protected(Path::new("/System/Library"), &protected));
        assert!(is_protected(
            Path::new("/Users/a/Library/Application Support/com.aiteam.desktop/auth-vault"),
            &protected
        ));
        assert!(is_protected(
            Path::new("/users/A/library/application support/COM.AITEAM.DESKTOP/x"),
            &protected
        ));
    }

    #[test]
    fn socket_path_fits_macos_sun_path_and_binds_0700_0600() {
        let directory = socket_directory();
        let socket = directory.join("s.sock");
        assert!(
            socket.as_os_str().len() < 100,
            "socket path too long for macOS sun_path: {} ({})",
            socket.display(),
            socket.as_os_str().len()
        );
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener =
            UnixListener::bind(&socket).expect("UnixListener::bind must succeed on macOS TMPDIR");
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        let dir_mode = std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
        let sock_mode = std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        assert_eq!(sock_mode, 0o600);
        drop(listener);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
