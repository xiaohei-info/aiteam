//! Running workbench projects (workbench plan §4). The WebView names a project by source and
//! opaque id; the host resolves its folder again, decides how it runs and opens it in the
//! system browser. Plain sites and single HTML pages are served statically and run no project
//! code. Node and Python projects run as child processes, only after the user has confirmed
//! their commands.
pub mod detect;
pub mod plan;
pub mod process;
pub mod static_server;

use crate::agent_projects::{file_id, resolve_project_dir, AgentProjectsState};
use detect::{RunUnit, Runner};
use plan::{DependencySource, RunContext};
use process::{Phase, ProcessRun, Ready};
use serde::Serialize;
use static_server::{encode_path, StaticServer};
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::Manager;

/// (source, project id, unit folder) as the WebView names what runs; the folder is empty for
/// the project folder itself.
type RunKey = (String, String, String);

/// The folder and runner of the unit `dir` of the project at `root`. Only a folder the host
/// itself detected as a unit is accepted, so `dir` cannot point anywhere else.
fn unit_at(root: &Path, dir: &str) -> Result<(PathBuf, Runner), String> {
    let unit = detect::detect_units(root)
        .into_iter()
        .find(|unit| unit.dir == dir)
        .ok_or("not_runnable")?;
    Ok((root.join(&unit.dir), unit.runner))
}

/// Run state folder name and consent key of a unit; a project's own unit keeps the names it
/// had before units existed.
fn unit_names(key: &RunKey) -> (String, String) {
    let (source, id, dir) = key;
    if dir.is_empty() {
        (id.clone(), format!("{source}:{id}"))
    } else {
        (
            format!("{id}-{}", file_id(dir)),
            format!("{source}:{id}/{dir}"),
        )
    }
}

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
        let (run_name, consent_key) = unit_names(&key);
        let run_dir = plan::run_dir(&context.data_dir, &key.0, &run_name);
        let described = plan::describe(runner, root, &run_dir, &consent_key, &context.source)?;
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
            &run_dir,
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
        node: runtime.join(if cfg!(windows) { "node.exe" } else { "node" }),
        npm_cli: runtime.join("npm").join("bin").join("npm-cli.js"),
        python: plan::find_python(),
        source: plan::load_source(&data_dir),
        data_dir,
    })
}

/// Ends, in the background, the projects an earlier instance left running when it was killed.
/// Only macOS takes the single-instance lock (in `agent::setup`) that makes this safe.
#[cfg(target_os = "macos")]
pub fn end_leftovers(app: &tauri::AppHandle) {
    if let Ok(data_dir) = app_data_dir(app) {
        std::thread::spawn(move || process::end_leftovers(&plan::runs_root(&data_dir)));
    }
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "data_dir_unavailable".into())
}

/// Where code projects download their dependencies from; the China mirrors by default.
#[tauri::command]
pub fn get_dependency_source(app: tauri::AppHandle) -> Result<DependencySource, String> {
    Ok(plan::load_source(&app_data_dir(&app)?))
}

/// Saves the download source. A changed source changes the install commands, so each code
/// project asks for consent again.
#[tauri::command]
pub fn set_dependency_source(
    app: tauri::AppHandle,
    source: DependencySource,
) -> Result<DependencySource, String> {
    plan::save_source(&app_data_dir(&app)?, source)
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
) -> Result<Vec<RunUnit>, String> {
    let projects = projects.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_project_dir(&app, &projects, &source, &project_id)?;
        Ok(detect::detect_units(&root))
    })
    .await
    .map_err(|_| "scan_failed".to_string())?
}

/// Runs a unit of the project (`dir`, empty or absent for the project folder) and opens it in
/// the system browser. `file_id` picks the page of a unit made of single HTML pages; `consent`
/// is the fingerprint of the confirmed commands of a code project.
// Each argument is one field of the WebView's invoke payload; a struct would only nest them.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_project(
    app: tauri::AppHandle,
    projects: tauri::State<'_, AgentProjectsState>,
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
    dir: Option<String>,
    file_id: Option<String>,
    consent: Option<String>,
) -> Result<StartOutcome, String> {
    let (projects, runs) = (projects.inner().clone(), runs.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let dir = dir.unwrap_or_default();
        let project = resolve_project_dir(&app, &projects, &source, &project_id)?;
        let (root, runner) = unit_at(&project, &dir)?;
        let key = (source, project_id, dir);
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
    dir: Option<String>,
) -> Result<RunStatus, String> {
    let runs = runs.inner().clone();
    let key = (source, project_id, dir.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || runs.stop(&key))
        .await
        .map_err(|_| "run_failed".to_string())
}

#[tauri::command]
pub fn project_run_status(
    runs: tauri::State<'_, ProjectRunnerState>,
    source: String,
    project_id: String,
    dir: Option<String>,
) -> RunStatus {
    runs.status(&(source, project_id, dir.unwrap_or_default()))
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
        ("codex".into(), id.into(), String::new())
    }

    #[test]
    fn units_are_found_only_where_the_host_detected_them() {
        let root = project(
            "units",
            &[
                ("game/index.html", "<p>g</p>"),
                ("site/dist/index.html", "<p>s</p>"),
                ("notes.md", "x"),
            ],
        );
        let (folder, runner) = unit_at(&root, "site").unwrap();
        assert_eq!(folder, root.join("site"));
        assert_eq!(runner, Runner::Static { dir: "dist".into() });
        for dir in ["", "..", "../units", "game/..", "notes.md", "missing"] {
            assert_eq!(unit_at(&root, dir).unwrap_err(), "not_runnable", "{dir}");
        }
        // Each unit runs on its own and keeps its own run state.
        let runs = ProjectRunnerState::default();
        let unit = |dir: &str| {
            (
                "fred".to_string(),
                "conversation-1".to_string(),
                dir.to_string(),
            )
        };
        for dir in ["game", "site"] {
            let (folder, runner) = unit_at(&root, dir).unwrap();
            runs.start_static(unit(dir), &folder, &runner, None)
                .unwrap();
        }
        let game = runs.status(&unit("game")).url.unwrap();
        assert!(get(&game).ends_with("<p>g</p>"));
        assert!(get(&runs.status(&unit("site")).url.unwrap()).ends_with("<p>s</p>"));
        runs.stop(&unit("game"));
        assert!(!runs.status(&unit("game")).running);
        assert!(runs.status(&unit("site")).running);
        runs.stop_all();
        // A project's own unit keeps the names it had before units.
        assert_eq!(unit_names(&key("p")), ("p".into(), "codex:p".into()));
        let (name, consent) = unit_names(&unit("site"));
        assert!(name.starts_with("conversation-1-") && name.len() == "conversation-1-".len() + 16);
        assert_eq!(consent, "fred:conversation-1/site");
        std::fs::remove_dir_all(&root).unwrap();
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
            source: DependencySource::System,
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
            [
                "npm install --no-audit --no-fund --fetch-retries=5 --fetch-timeout=120000",
                "npm run dev"
            ]
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
