//! Workbench: projects AI agents built on this machine — Fred (this app's own Agent), Codex,
//! Claude Code, the Claude desktop app and WorkBuddy.
//!
//! A project is a folder an agent created, not one the user already had. Codex and Claude Code
//! sessions contribute the outermost folder created after the session started that holds a file
//! they wrote, unless it sits inside an existing repository or package. WorkBuddy contributes its
//! per-task folders, Cowork its `outputs/`, and Fred the managed workspaces the local Agent API
//! names by key. The WebView addresses a project by source and opaque id and a file by opaque
//! id, never by path. Nothing here leaves the machine.

mod discovery;
mod fred;
mod listing;
mod sessions;
#[cfg(test)]
mod tests;

use discovery::*;
use fred::*;
pub(crate) use listing::*;
use sessions::*;

use serde::Serialize;

use serde_json::Value;

use std::cmp::Reverse;

use std::collections::{HashMap, HashSet};

use std::fs::File;

use std::io::{BufRead, BufReader};

use std::path::{Component, Path, PathBuf};

use std::sync::{Arc, Mutex};

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

const MAX_SESSIONS_PER_SOURCE: usize = 300;

const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

// Codex event types sit near the start of each line; scanning a bounded prefix keeps
// hundreds of MB of tool output from being JSON-parsed.
const LINE_PREFIX_SCAN_BYTES: usize = 512;

const MAX_TITLE_CHARS: usize = 80;

const MAX_DESCRIPTION_CHARS: usize = 300;

const MAX_WRITES_PER_SESSION: usize = 1_000;

const MAX_PROJECT_FILES: usize = 2_000;

/// Directory entries visited per project, bounding the scan of a huge folder.
const MAX_PROJECT_ENTRIES: usize = 20_000;

const MAX_PROJECT_DEPTH: usize = 12;

/// Larger text files are not returned for preview.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

const MAX_ID_LEN: usize = 128;

/// Claude desktop session records also hold system prompts and tool settings.
const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

/// Fred workspaces listed at most; the newest come first, so the oldest are left out.
const MAX_FRED_WORKSPACES: usize = 1_000;

/// Folders created shortly before a session's first record still belong to it.
const CREATION_GRACE_MS: i64 = 2 * 60 * 1000;

/// Claude Code's file tools; Claude desktop Code tab sessions record the same ones.
const CLAUDE_FILE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit"];

const CODEX_MARKERS: &[&str] = &[
    "\"session_meta\"",
    "\"turn_context\"",
    "\"UserMessage\"",
    "\"user_message\"",
    "\"FileChange\"",
];

/// Claude Code wraps slash commands, their output and shell-mode input in tags; none are requests.
const CLAUDE_NON_PROMPTS: &[&str] = &[
    "<command-name>",
    "<command-message>",
    "<local-command-",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "[Request interrupted",
];

/// A folder holding one of these before the session started is a project the user already had.
const PROJECT_MARKERS: &[&str] = &[".git", "package.json", "pyproject.toml"];

/// Dependency and build-cache folders: installed, not written by the agent.
pub(crate) const IGNORED_DIRS: &[&str] = &["node_modules", "__pycache__", "venv"];

/// Build output next to a `package.json`: generated from the sources, not written by the agent.
const BUILD_OUTPUT_DIR: &str = "dist";

/// Name parts that suggest credentials, matching the Agent's artifact capture rules.
const SENSITIVE_NAME_PARTS: &[&str] = &[
    "env",
    "secret",
    "secrets",
    "credential",
    "credentials",
    "passwd",
    "token",
    "private",
    "apikey",
    "accesskey",
];

/// Key and certificate stores, whatever they are called.
const SENSITIVE_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "jks", "keystore", "ppk"];

const CODE_EXTENSIONS: &[&str] = &[
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte", "css", "scss", "less", "json",
    "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "py", "ipynb", "rb", "go", "rs",
    "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "r", "sql", "sh",
    "bash", "zsh", "ps1", "bat", "cmd",
];

const README_NAMES: &[&str] = &["readme.md", "readme.markdown", "readme.txt", "readme"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSource {
    /// This app's own Agent; its folders are listed by `list_fred_workspace_files`.
    Fred,
    Codex,
    /// Claude Code CLI.
    Claude,
    /// Claude desktop app: Cowork sessions and the Code tab's Claude Code sessions.
    ClaudeDesktop,
    Workbuddy,
}

impl AgentSource {
    /// Sources found by scanning this machine.
    const SCANNED: [AgentSource; 4] = [
        AgentSource::Codex,
        AgentSource::Claude,
        AgentSource::ClaudeDesktop,
        AgentSource::Workbuddy,
    ];

    fn parse(value: &str) -> Option<Self> {
        match value {
            "fred" => Some(Self::Fred),
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            "claude_desktop" => Some(Self::ClaudeDesktop),
            "workbuddy" => Some(Self::Workbuddy),
            _ => None,
        }
    }

    fn default_employee(self) -> &'static str {
        match self {
            Self::Fred => "Fred",
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::ClaudeDesktop => "Claude",
            Self::Workbuddy => "WorkBuddy",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Markdown,
    Text,
    Html,
    Csv,
    Svg,
    /// Source code and configuration, shown as text.
    Code,
    /// Images, Office documents and PDF: opened with the system app, no text content.
    Image,
    Document,
    /// Unknown extension: returned as text only when it decodes as text.
    Other,
}

impl FileFormat {
    fn of(path: &Path) -> Self {
        let Some(extension) = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
        else {
            return Self::Other;
        };
        match extension.as_str() {
            "md" | "markdown" => Self::Markdown,
            "txt" | "log" => Self::Text,
            "html" | "htm" => Self::Html,
            "csv" => Self::Csv,
            "svg" => Self::Svg,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" => Self::Image,
            "docx" | "doc" | "pptx" | "ppt" | "xlsx" | "xls" | "pdf" => Self::Document,
            other if CODE_EXTENSIONS.contains(&other) => Self::Code,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectFile {
    pub id: String,
    /// Relative to the project folder, `/`-separated.
    pub path: String,
    pub format: FileFormat,
    pub size: u64,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct ProjectSummary {
    pub source: AgentSource,
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub employee_name: String,
    /// The model of the latest session that wrote into the project.
    pub model: Option<String>,
    pub models: Vec<String>,
    /// The folder, shortened to `~/…`.
    pub location: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub file_count: usize,
    /// More files than are listed.
    pub truncated: bool,
    pub files: Vec<ProjectFile>,
}

#[derive(Debug, Serialize)]
pub struct SourceStatus {
    pub source: AgentSource,
    pub available: bool,
    pub project_count: usize,
    /// More sessions than are read.
    pub truncated: bool,
    /// Some sessions were skipped because the file system does not record folder creation times.
    pub creation_time_unavailable: bool,
}

#[derive(Debug, Serialize)]
pub struct ProjectList {
    pub sources: Vec<SourceStatus>,
    pub projects: Vec<ProjectSummary>,
}

/// One Fred workspace; the WebView joins it with the conversation from the Agent API.
#[derive(Debug, Serialize)]
pub struct FredWorkspace {
    pub workspace_key: String,
    /// From `package.json` or `pyproject.toml`.
    pub name: Option<String>,
    /// The README's first paragraph.
    pub description: Option<String>,
    pub updated_at: Option<i64>,
    pub file_count: usize,
    pub truncated: bool,
    pub files: Vec<ProjectFile>,
}

/// The Fred workspaces listed, and whether some were left out (`MAX_FRED_WORKSPACES`).
#[derive(Debug, Serialize)]
pub struct FredWorkspaceList {
    pub workspaces: Vec<FredWorkspace>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct ProjectFileContent {
    pub name: String,
    pub path: String,
    pub format: FileFormat,
    pub size: u64,
    /// `None` for images, documents and binary files.
    pub content: Option<String>,
}

#[derive(Clone, Default)]
pub struct AgentProjectsState(Arc<Mutex<Cache>>);

impl AgentProjectsState {
    fn list(&self) -> Result<ProjectList, String> {
        let roots = Roots::resolve()?;
        let mut cache = self.0.lock().map_err(|_| "scan_failed")?;
        let (sources, projects) = cache.refresh(&roots);
        Ok(ProjectList { sources, projects })
    }

    /// The folder of a listed project; `fred_root` holds Fred's workspaces.
    fn resolve(&self, source: AgentSource, id: &str, fred_root: &Path) -> Result<PathBuf, String> {
        if source == AgentSource::Fred {
            return fred_workspace(fred_root, id)?.ok_or_else(|| "project_not_found".into());
        }
        let roots = Roots::resolve()?;
        let mut cache = self.0.lock().map_err(|_| "scan_failed")?;
        let key = (source, id.to_string());
        if !cache.index.contains_key(&key) {
            cache.refresh(&roots);
        }
        let dir = cache.index.get(&key).cloned().ok_or("project_not_found")?;
        if !std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            return Err("project_not_found".into());
        }
        Ok(dir)
    }
}

/// The folder of a listed project, resolved again by the host from the WebView's source and
/// opaque id. Blocking: it may rescan the sessions.
pub(crate) fn resolve_project_dir(
    app: &tauri::AppHandle,
    state: &AgentProjectsState,
    source: &str,
    project_id: &str,
) -> Result<PathBuf, String> {
    let source = parse_target(source, project_id, None)?;
    state.resolve(source, project_id, &fred_workspace_root(app)?)
}

fn parse_target(
    source: &str,
    project_id: &str,
    file_id: Option<&str>,
) -> Result<AgentSource, String> {
    let source = AgentSource::parse(source).ok_or("invalid_source")?;
    let valid = if source == AgentSource::Fred {
        valid_workspace_key(project_id)
    } else {
        valid_file_id(project_id)
    };
    if !valid {
        return Err("invalid_project_id".into());
    }
    if file_id.is_some_and(|id| !valid_file_id(id)) {
        return Err("invalid_file_id".into());
    }
    Ok(source)
}

#[tauri::command]
pub async fn list_agent_projects(
    state: tauri::State<'_, AgentProjectsState>,
) -> Result<ProjectList, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list())
        .await
        .map_err(|_| "scan_failed".to_string())?
}

/// Files of Fred workspaces the local Agent API listed for the signed-in member.
#[tauri::command]
pub async fn list_fred_workspace_files(
    app: tauri::AppHandle,
    workspace_keys: Vec<String>,
) -> Result<FredWorkspaceList, String> {
    let root = fred_workspace_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_fred_workspaces(&root, &workspace_keys))
        .await
        .map_err(|_| "scan_failed".to_string())?
}

#[tauri::command]
pub async fn read_project_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentProjectsState>,
    source: String,
    project_id: String,
    file_id: String,
) -> Result<ProjectFileContent, String> {
    let source = parse_target(&source, &project_id, Some(&file_id))?;
    let fred_root = fred_workspace_root(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = state.resolve(source, &project_id, &fred_root)?;
        read_project_file_at(&root, &file_id)
    })
    .await
    .map_err(|_| "scan_failed".to_string())?
}

/// Absolute path of a Fred-managed conversation folder, for display in the permissions panel.
/// The WebView names it only by `workspace_key`; a missing or linked folder is `project_not_found`.
pub(super) fn fred_workspace_display_path(root: &Path, key: &str) -> Result<String, String> {
    fred_workspace(root, key)?
        .map(|dir| dir.to_string_lossy().into_owned())
        .ok_or_else(|| "project_not_found".to_string())
}

#[tauri::command]
pub async fn fred_workspace_path(
    app: tauri::AppHandle,
    workspace_key: String,
) -> Result<String, String> {
    let root = fred_workspace_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || fred_workspace_display_path(&root, &workspace_key))
        .await
        .map_err(|_| "scan_failed".to_string())?
}

/// Opens a project file (or the folder without `file_id`) with the system app, or reveals it.
#[tauri::command]
pub async fn open_project_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AgentProjectsState>,
    source: String,
    project_id: String,
    file_id: Option<String>,
    reveal: bool,
) -> Result<(), String> {
    let source = parse_target(&source, &project_id, file_id.as_deref())?;
    let fred_root = fred_workspace_root(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = state.resolve(source, &project_id, &fred_root)?;
        open_project_path(&root, file_id.as_deref(), reveal)
    })
    .await
    .map_err(|_| "scan_failed".to_string())?
}
