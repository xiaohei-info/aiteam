//! Running workbench projects (workbench plan §4). The WebView names a project by source and
//! opaque id; the host resolves its folder again, decides how it runs and opens it in the
//! system browser. Plain sites and single HTML pages are served statically and run no project
//! code. Node and Python projects run as child processes, only after the user has confirmed
//! their commands.
pub mod detect;
pub mod plan;
pub mod process;
pub mod static_server;

use crate::agent_projects::{resolve_project_dir, AgentProjectsState};
use detect::Runner;
use plan::RunContext;
use process::{Phase, ProcessRun, Ready};
use serde::Serialize;
use static_server::{encode_path, StaticServer};
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

/// (source, project id) as the WebView names the project.
type RunKey = (String, String);

enum Run {
    Static {
        server: StaticServer,
        url: String,
    },
    /// Shared so a stop can wait for the process group without holding the run table.
    Process(Arc<ProcessRun>),
}

impl Run {
    fn status(&self) -> RunStatus {
        match self {
            Run::Static { url, .. } => RunStatus {
                running: true,
                phase: Some(Phase::Running),
                url: Some(url.clone()),
                ..RunStatus::stopped()
            },
            Run::Process(run) => {
                let snapshot = run.snapshot();
                RunStatus {
                    running: snapshot.phase.active(),
                    phase: Some(snapshot.phase),
                    url: snapshot.url,
                    exit_code: snapshot.exit_code,
                    url_timed_out: snapshot.url_timed_out,
                    logs: snapshot.logs,
                }
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct ProjectRunnerState(Arc<Mutex<HashMap<RunKey, Run>>>);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RunStatus {
    pub running: bool,
    /// `None` until the project is started in this app session.
    pub phase: Option<Phase>,
    pub url: Option<String>,
    pub exit_code: Option<i32>,
    /// The start command printed no address within 30 seconds; the log tells more.
    pub url_timed_out: bool,
    /// The last 500 lines of output.
    pub logs: Vec<String>,
}

impl RunStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            phase: None,
            url: None,
            exit_code: None,
            url_timed_out: false,
            logs: Vec::new(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StartOutcome {
    /// A code project runs only once the user confirms these commands: start again with
    /// `fingerprint` as the consent.
    NeedsConsent {
        commands: Vec<String>,
        cwd: String,
        fingerprint: String,
    },
    Started(RunStatus),
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
        _ => Err("not_runnable".into()),
    }
}

/// A loopback port free right now, for the dev server to listen on.
fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| "run_failed".into())
}

impl ProjectRunnerState {
    fn runs(&self) -> MutexGuard<'_, HashMap<RunKey, Run>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts (or reuses) the project's static server and returns the page address.
    fn start_static(
        &self,
        key: RunKey,
        root: &Path,
        runner: &Runner,
        file_id: Option<&str>,
    ) -> Result<RunStatus, String> {
        let (serve, page) = static_target(root, runner, file_id)?;
        let serve = serve.canonicalize().map_err(|_| "project_not_found")?;
        let mut runs = self.runs();
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
        Ok(runs
            .get(&key)
            .map(Run::status)
            .unwrap_or_else(RunStatus::stopped))
    }

    /// Runs a Node or Python project once its commands are confirmed; `consent` is the
    /// fingerprint of the commands the user confirmed. A running project is reused.
    fn start_code(
        &self,
        key: RunKey,
        root: &Path,
        runner: &Runner,
        context: &RunContext,
        consent: Option<&str>,
        ready: Ready,
    ) -> Result<StartOutcome, String> {
        let run_dir = plan::run_dir(&context.data_dir, &key.0, &key.1);
        let consent_key = format!("{}:{}", key.0, key.1);
        let described = plan::describe(runner, root, &run_dir, &consent_key)?;
        // Held to the end: one start per project at a time, and consent writes are serialized.
        let mut runs = self.runs();
        if let Some(status) = runs
            .get(&key)
            .map(Run::status)
            .filter(|status| status.running)
        {
            return Ok(StartOutcome::Started(status));
        }
        if !plan::consented(&context.data_dir, &consent_key, &described.fingerprint) {
            if consent != Some(described.fingerprint.as_str()) {
                return Ok(StartOutcome::NeedsConsent {
                    commands: described.commands,
                    cwd: root.display().to_string(),
                    fingerprint: described.fingerprint,
                });
            }
            plan::grant(&context.data_dir, &consent_key, &described.fingerprint)?;
        }
        let port = free_port()?;
        let (steps, prefix) = plan::steps(runner, root, &run_dir, context, port)?;
        let run = Run::Process(Arc::new(ProcessRun::start(
            steps,
            root.to_path_buf(),
            plan::child_env(&prefix, port),
            &run_dir.join("run.log"),
            ready,
        )?));
        let status = run.status();
        runs.insert(key, run);
        Ok(StartOutcome::Started(status))
    }

    /// Stops the project; a process run keeps its log until the project starts again.
    fn stop(&self, key: &RunKey) -> RunStatus {
        let process = {
            let mut runs = self.runs();
            match runs.get(key) {
                Some(Run::Process(run)) => Some(run.clone()),
                // Dropping the server closes its port.
                Some(Run::Static { .. }) => runs.remove(key).and(None),
                None => None,
            }
        };
        match process {
            Some(run) => {
                run.stop();
                Run::Process(run).status()
            }
            None => RunStatus::stopped(),
        }
    }

    fn status(&self, key: &RunKey) -> RunStatus {
        self.runs()
            .get(key)
            .map(Run::status)
            .unwrap_or_else(RunStatus::stopped)
    }

    /// Ends every run, in parallel; called when the app exits.
    pub fn stop_all(&self) {
        let runs = std::mem::take(&mut *self.runs());
        let stopping: Vec<_> = runs
            .into_values()
            .map(|run| std::thread::spawn(move || drop(run)))
            .collect();
        for handle in stopping {
            let _ = handle.join();
        }
    }
}

/// Where run state lives and which runtimes run the projects.
fn run_context(app: &tauri::AppHandle) -> Result<RunContext, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "data_dir_unavailable")?;
    // The bundled Agent, found the way `agent::setup` finds it.
    let agent = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent")
    } else {
        app.path()
            .resource_dir()
            .map_err(|_| "node_unavailable")?
            .join("agent")
    };
    let runtime = agent.join("runtime");
    Ok(RunContext {
        data_dir,
        node: runtime.join(if cfg!(windows) { "node.exe" } else { "node" }),
        npm_cli: runtime.join("npm").join("bin").join("npm-cli.js"),
        python: plan::find_python(),
    })
}

/// Opens a loopback address of a running project in the system browser.
fn open_in_browser(url: &str) -> Result<(), String> {
    if !url.starts_with("http://127.0.0.1:") && !url.starts_with("http://localhost:") {
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

/// Runs the project and opens it in the system browser. `file_id` picks the page of a project
/// made of single HTML pages; `consent` is the fingerprint of the confirmed commands of a code
/// project.
#[tauri::command]
pub async fn start_project(
    app: tauri::AppHandle,
    projects: tauri::State<'_, AgentProjectsState>,
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
    file_id: Option<String>,
    consent: Option<String>,
) -> Result<StartOutcome, String> {
    let (projects, runs) = (projects.inner().clone(), runs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_project_dir(&app, &projects, &source, &project_id)?;
        let runner = detect::detect(&root);
        let key = (source, project_id);
        let outcome = match runner {
            Runner::Node { .. } | Runner::Python { .. } => {
                let opener: Ready = Box::new(|url| {
                    let _ = open_in_browser(&url);
                });
                runs.start_code(
                    key,
                    &root,
                    &runner,
                    &run_context(&app)?,
                    consent.as_deref(),
                    opener,
                )?
            }
            _ => {
                StartOutcome::Started(runs.start_static(key, &root, &runner, file_id.as_deref())?)
            }
        };
        // A fresh code run opens itself once it prints its address; anything already
        // serving opens now.
        if let StartOutcome::Started(RunStatus {
            phase: Some(Phase::Running),
            url: Some(url),
            ..
        }) = &outcome
        {
            open_in_browser(url)?;
        }
        Ok(outcome)
    })
    .await
    .map_err(|_| "run_failed".to_string())?
}

#[tauri::command]
pub async fn stop_project(
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
) -> Result<RunStatus, String> {
    let runs = runs.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runs.stop(&(source, project_id)))
        .await
        .map_err(|_| "run_failed".to_string())
}

#[tauri::command]
pub fn project_run_status(
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
) -> RunStatus {
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

    fn serve(
        runs: &ProjectRunnerState,
        id: &str,
        root: &Path,
        file: Option<&str>,
    ) -> Result<RunStatus, String> {
        runs.start_static(key(id), root, &detect::detect(root), file)
    }

    #[test]
    fn built_sites_are_served_from_their_folder_and_reused() {
        let root = project(
            "site",
            &[("dist/index.html", "<p>built</p>"), ("src/main.ts", "x")],
        );
        let runs = ProjectRunnerState::default();
        let first = serve(&runs, "a", &root, None).unwrap();
        assert_eq!(first.phase, Some(Phase::Running));
        let url = first.url.clone().unwrap();
        assert!(url.ends_with('/'), "{url}");
        assert!(get(&url).ends_with("<p>built</p>"));
        // The source folder is outside the served folder.
        assert!(get(&format!("{url}../src/main.ts")).starts_with("HTTP/1.1 404"));
        assert_eq!(serve(&runs, "a", &root, None).unwrap(), first);
        assert_eq!(runs.status(&key("a")), first);

        assert_eq!(runs.stop(&key("a")), RunStatus::stopped());
        assert_eq!(runs.status(&key("a")), RunStatus::stopped());
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
        assert_eq!(serve(&runs, "p", &root, None).unwrap_err(), "file_required");
        assert_eq!(
            serve(&runs, "p", &root, Some("0000000000000000")).unwrap_err(),
            "file_not_found"
        );
        let daily = files.iter().find(|file| file.path == "日报.html").unwrap();
        let weekly = files.iter().find(|file| file.path != "日报.html").unwrap();
        let first = serve(&runs, "p", &root, Some(&daily.id)).unwrap();
        let second = serve(&runs, "p", &root, Some(&weekly.id)).unwrap();
        let (first, second) = (first.url.unwrap(), second.url.unwrap());
        assert!(get(&first).ends_with("<p>daily</p>"));
        assert!(get(&second).ends_with("<p>weekly</p>"));
        let port = |url: &str| url.split('/').nth(2).unwrap().to_string();
        assert_eq!(port(&first), port(&second));
        assert_eq!(runs.status(&key("p")).url, Some(second));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn plain_folders_are_not_runnable() {
        let docs = project("docs", &[("notes.md", "x")]);
        let runs = ProjectRunnerState::default();
        assert_eq!(serve(&runs, "d", &docs, None).unwrap_err(), "not_runnable");
        assert_eq!(runs.status(&key("d")), RunStatus::stopped());
        assert!(open_in_browser("https://example.com").is_err());
        assert!(open_in_browser("http://example.com:80/").is_err());
        std::fs::remove_dir_all(&docs).unwrap();
    }

    /// Stands in for npm: `install` creates node_modules, `run` serves until stopped.
    #[cfg(unix)]
    const FAKE_NPM: &str = r#"case "$1" in
  install) mkdir node_modules && echo "added 1 package" ;;
  run) echo "  Local:   http://127.0.0.1:$PORT/"; echo "host=$HOST aiteam=${AITEAM_TOKEN:-none}"; exec sleep 30 ;;
esac
"#;

    #[cfg(unix)]
    fn wait_for(
        runs: &ProjectRunnerState,
        key: &RunKey,
        done: impl Fn(&RunStatus) -> bool,
    ) -> RunStatus {
        for _ in 0..200 {
            let status = runs.status(key);
            if done(&status) {
                return status;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("timed out: {:?}", runs.status(key));
    }

    #[cfg(unix)]
    #[test]
    fn code_projects_run_after_consent_until_stopped() {
        let data = project("code-data", &[("runtime/npm/bin/npm-cli.js", FAKE_NPM)]);
        let root = project("code", &[("package.json", r#"{"scripts":{"dev":"vite"}}"#)]);
        let context = RunContext {
            data_dir: data.clone(),
            node: "/bin/sh".into(),
            npm_cli: data.join("runtime/npm/bin/npm-cli.js"),
            python: None,
        };
        let runner = detect::detect(&root);
        let runs = ProjectRunnerState::default();
        let opened = Arc::new(Mutex::new(Vec::new()));
        let ready = || -> Ready {
            let opened = opened.clone();
            Box::new(move |url| opened.lock().unwrap().push(url))
        };
        let start = |consent: Option<&str>| {
            runs.start_code(key("c"), &root, &runner, &context, consent, ready())
                .unwrap()
        };

        let StartOutcome::NeedsConsent {
            commands,
            cwd,
            fingerprint,
        } = start(None)
        else {
            panic!("a code project must ask first");
        };
        assert_eq!(
            commands,
            ["npm install --no-audit --no-fund", "npm run dev"]
        );
        assert_eq!(cwd, root.display().to_string());
        assert!(matches!(
            start(Some("stale")),
            StartOutcome::NeedsConsent { .. }
        ));
        assert_eq!(runs.status(&key("c")), RunStatus::stopped());

        let StartOutcome::Started(first) = start(Some(&fingerprint)) else {
            panic!("consent should start the run");
        };
        assert!(first.running);
        let status = wait_for(&runs, &key("c"), |status| {
            status.phase == Some(Phase::Running)
        });
        let url = status.url.clone().unwrap();
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        assert_eq!(*opened.lock().unwrap(), std::slice::from_ref(&url));
        assert!(status
            .logs
            .iter()
            .any(|line| line == "host=127.0.0.1 aiteam=none"));
        assert!(root.join("node_modules").is_dir());
        // Consent is remembered and a running project is reused.
        let StartOutcome::Started(again) = start(None) else {
            panic!("consent should be remembered");
        };
        assert_eq!(again.url, Some(url));

        let stopped = runs.stop(&key("c"));
        assert_eq!(stopped.phase, Some(Phase::Stopped));
        assert!(!stopped.running && !stopped.logs.is_empty());
        // Installed dependencies are not installed again.
        assert!(matches!(start(None), StartOutcome::Started(_)));
        let status = wait_for(&runs, &key("c"), |status| {
            status.phase == Some(Phase::Running)
        });
        assert_eq!(status.logs[0], "$ npm run dev");

        runs.stop_all();
        assert_eq!(runs.status(&key("c")), RunStatus::stopped());
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&data).unwrap();
    }
}
