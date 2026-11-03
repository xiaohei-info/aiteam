//! Running workbench projects (workbench plan §4). The WebView names a project by source and
//! opaque id; the host resolves its folder again, decides how it runs and opens it in the
//! system browser. Plain sites and single HTML pages are served statically and run no project
//! code; Node and Python projects need the process runner.
pub mod detect;
pub mod static_server;

use crate::agent_projects::{resolve_project_dir, AgentProjectsState};
use detect::Runner;
use serde::Serialize;
use static_server::{encode_path, StaticServer};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

/// (source, project id) as the WebView names the project.
type RunKey = (String, String);

enum Run {
    Static { server: StaticServer, url: String },
}

#[derive(Clone, Default)]
pub struct ProjectRunnerState(Arc<Mutex<HashMap<RunKey, Run>>>);

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RunStatus {
    pub running: bool,
    pub url: Option<String>,
}

impl RunStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            url: None,
        }
    }
}

/// The folder to serve and the page to open in it for a statically served project.
fn static_target(
    root: &Path,
    runner: &Runner,
    file_id: Option<&str>,
) -> Result<(PathBuf, String), String> {
    match runner {
        Runner::Static { dir } => Ok((root.join(dir), String::new())),
        Runner::Html { files } => {
            let id = file_id.ok_or("file_required")?;
            let file = files
                .iter()
                .find(|file| file.id == id)
                .ok_or("file_not_found")?;
            Ok((root.to_path_buf(), encode_path(&file.path)))
        }
        Runner::Node { .. } | Runner::Python { .. } => Err("runner_unavailable".into()),
        Runner::None => Err("not_runnable".into()),
    }
}

impl ProjectRunnerState {
    /// Starts (or reuses) the project's static server and returns the page address.
    fn start(&self, key: RunKey, root: &Path, file_id: Option<&str>) -> Result<RunStatus, String> {
        let (serve, page) = static_target(root, &detect::detect(root), file_id)?;
        let serve = serve.canonicalize().map_err(|_| "project_not_found")?;
        let mut runs = self.0.lock().map_err(|_| "run_failed")?;
        let port = match runs.get(&key) {
            Some(Run::Static { server, .. }) if server.root() == serve => server.port(),
            _ => {
                let server = StaticServer::start(&serve)?;
                let port = server.port();
                runs.insert(
                    key.clone(),
                    Run::Static {
                        server,
                        url: String::new(),
                    },
                );
                port
            }
        };
        let address = format!("http://127.0.0.1:{port}/{page}");
        if let Some(Run::Static { url, .. }) = runs.get_mut(&key) {
            url.clone_from(&address);
        }
        Ok(RunStatus {
            running: true,
            url: Some(address),
        })
    }

    fn stop(&self, key: &RunKey) -> Result<RunStatus, String> {
        // Dropping the server closes its port.
        self.0.lock().map_err(|_| "run_failed")?.remove(key);
        Ok(RunStatus::stopped())
    }

    fn status(&self, key: &RunKey) -> Result<RunStatus, String> {
        let runs = self.0.lock().map_err(|_| "run_failed")?;
        Ok(match runs.get(key) {
            Some(Run::Static { url, .. }) => RunStatus {
                running: true,
                url: Some(url.clone()),
            },
            None => RunStatus::stopped(),
        })
    }
}

/// Opens a loopback address of a running project in the system browser.
fn open_in_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("http://127.0.0.1:") {
        return Err("open_failed".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|_| "open_failed".into())
}

#[tauri::command]
pub async fn detect_project_runner(
    app: tauri::AppHandle,
    projects: tauri::State<'_, AgentProjectsState>,
    source: String,
    project_id: String,
) -> Result<Runner, String> {
    let projects = projects.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_project_dir(&app, &projects, &source, &project_id)?;
        Ok(detect::detect(&root))
    })
    .await
    .map_err(|_| "scan_failed".to_string())?
}

/// Runs the project and opens it in the system browser; `file_id` picks the page of a project
/// made of single HTML pages.
#[tauri::command]
pub async fn start_project(
    app: tauri::AppHandle,
    projects: tauri::State<'_, AgentProjectsState>,
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
    file_id: Option<String>,
) -> Result<RunStatus, String> {
    let (projects, runs) = (projects.inner().clone(), runs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_project_dir(&app, &projects, &source, &project_id)?;
        let status = runs.start((source, project_id), &root, file_id.as_deref())?;
        if let Some(url) = &status.url {
            open_in_browser(url)?;
        }
        Ok(status)
    })
    .await
    .map_err(|_| "run_failed".to_string())?
}

#[tauri::command]
pub fn stop_project(
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
) -> Result<RunStatus, String> {
    runs.stop(&(source, project_id))
}

#[tauri::command]
pub fn project_run_status(
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
) -> Result<RunStatus, String> {
    runs.status(&(source, project_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn project(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aiteam-runner-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn get(url: &str) -> String {
        let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
        let (port, path) = rest.split_once('/').unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap())).unwrap();
        write!(
            stream,
            "GET /{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn key(id: &str) -> RunKey {
        ("codex".into(), id.into())
    }

    #[test]
    fn built_sites_are_served_from_their_folder_and_reused() {
        let root = project(
            "site",
            &[("dist/index.html", "<p>built</p>"), ("src/main.ts", "x")],
        );
        let runs = ProjectRunnerState::default();
        let first = runs.start(key("a"), &root, None).unwrap();
        let url = first.url.clone().unwrap();
        assert!(url.ends_with('/'), "{url}");
        assert!(get(&url).ends_with("<p>built</p>"));
        // The source folder is outside the served folder.
        assert!(get(&format!("{url}../src/main.ts")).starts_with("HTTP/1.1 404"));
        assert_eq!(runs.start(key("a"), &root, None).unwrap(), first);
        assert_eq!(runs.status(&key("a")).unwrap(), first);

        assert_eq!(runs.stop(&key("a")).unwrap(), RunStatus::stopped());
        assert_eq!(runs.status(&key("a")).unwrap(), RunStatus::stopped());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn single_pages_open_the_chosen_file_on_one_server() {
        let root = project(
            "pages",
            &[
                ("日报.html", "<p>daily</p>"),
                ("report/weekly.html", "<p>weekly</p>"),
            ],
        );
        let runs = ProjectRunnerState::default();
        let Runner::Html { files } = detect::detect(&root) else {
            panic!("expected single pages");
        };
        assert_eq!(
            runs.start(key("p"), &root, None).unwrap_err(),
            "file_required"
        );
        assert_eq!(
            runs.start(key("p"), &root, Some("0000000000000000"))
                .unwrap_err(),
            "file_not_found"
        );
        let daily = files.iter().find(|file| file.path == "日报.html").unwrap();
        let weekly = files.iter().find(|file| file.path != "日报.html").unwrap();
        let first = runs.start(key("p"), &root, Some(&daily.id)).unwrap();
        let second = runs.start(key("p"), &root, Some(&weekly.id)).unwrap();
        let (first, second) = (first.url.unwrap(), second.url.unwrap());
        assert!(get(&first).ends_with("<p>daily</p>"));
        assert!(get(&second).ends_with("<p>weekly</p>"));
        let port = |url: &str| url.split('/').nth(2).unwrap().to_string();
        assert_eq!(port(&first), port(&second));
        assert_eq!(runs.status(&key("p")).unwrap().url, Some(second));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn code_projects_and_plain_folders_are_not_served() {
        let node = project("node", &[("package.json", r#"{"scripts":{"dev":"vite"}}"#)]);
        let docs = project("docs", &[("notes.md", "x")]);
        let runs = ProjectRunnerState::default();
        assert_eq!(
            runs.start(key("n"), &node, None).unwrap_err(),
            "runner_unavailable"
        );
        assert_eq!(
            runs.start(key("d"), &docs, None).unwrap_err(),
            "not_runnable"
        );
        assert_eq!(runs.status(&key("n")).unwrap(), RunStatus::stopped());
        assert!(open_in_browser("https://example.com").is_err());
        std::fs::remove_dir_all(&node).unwrap();
        std::fs::remove_dir_all(&docs).unwrap();
    }
}
