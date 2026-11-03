//! Workbench: projects AI agents built on this machine — Fred (this app's own Agent), Codex,
//! Claude Code, the Claude desktop app and WorkBuddy.
//!
//! A project is a folder an agent created, not one the user already had. Codex and Claude Code
//! sessions contribute the outermost folder created after the session started that holds a file
//! they wrote, unless it sits inside an existing repository or package. WorkBuddy contributes its
//! per-task folders, Cowork its `outputs/`, and Fred the managed workspaces the local Agent API
//! names by key. The WebView addresses a project by source and opaque id and a file by opaque
//! id, never by path. Nothing here leaves the machine.
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
const MAX_FRED_KEYS: usize = 1_000;
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
const IGNORED_DIRS: &[&str] = &["node_modules", "__pycache__", "venv"];

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

#[derive(Debug, Serialize)]
pub struct ProjectFileContent {
    pub name: String,
    pub path: String,
    pub format: FileFormat,
    pub size: u64,
    /// `None` for images, documents and binary files.
    pub content: Option<String>,
}

/// What one session file says, before display overrides such as app-given titles.
#[derive(Debug, Default)]
struct SessionRecord {
    id: String,
    title: Option<String>,
    first_prompt: Option<String>,
    employee_name: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    created_at: Option<i64>,
    /// Absolute paths the session wrote, each with the model that wrote it.
    writes: Vec<(String, Option<String>)>,
}

impl SessionRecord {
    fn note_prompt(&mut self, text: &str) {
        let text = text.trim();
        if self.first_prompt.is_none() && !text.is_empty() {
            self.first_prompt = Some(truncate_chars(text, MAX_DESCRIPTION_CHARS));
        }
    }

    fn note_write(&mut self, path: &str, model: Option<String>) {
        if self.writes.len() >= MAX_WRITES_PER_SESSION {
            return;
        }
        if let Some(path) = absolute_path(path, self.cwd.as_deref()) {
            self.writes.push((path, model));
        }
    }
}

struct CacheEntry {
    modified: Option<SystemTime>,
    len: u64,
    session: Option<SessionRecord>,
}

#[derive(Default)]
struct Cache {
    sessions: HashMap<PathBuf, CacheEntry>,
    /// Project folders by (source, project id) from the latest scan.
    index: HashMap<(AgentSource, String), PathBuf>,
}

#[derive(Clone, Default)]
pub struct AgentProjectsState(Arc<Mutex<Cache>>);

struct Roots {
    home: PathBuf,
    codex: PathBuf,
    claude: PathBuf,
    /// Claude desktop app data folder.
    claude_app: Option<PathBuf>,
    /// Claude desktop Cowork sessions.
    cowork: Option<PathBuf>,
    workbuddy: PathBuf,
    /// Parent of WorkBuddy's per-task folders.
    workbuddy_tasks: PathBuf,
}

/// An absolute directory named by an environment variable.
fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

#[cfg(target_os = "macos")]
fn claude_app_dir(home: &Path) -> Option<PathBuf> {
    Some(home.join("Library/Application Support/Claude"))
}

#[cfg(target_os = "windows")]
fn claude_app_dir(_home: &Path) -> Option<PathBuf> {
    env_dir("APPDATA").map(|dir| dir.join("Claude"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn claude_app_dir(home: &Path) -> Option<PathBuf> {
    Some(
        env_dir("XDG_CONFIG_HOME")
            .unwrap_or_else(|| home.join(".config"))
            .join("Claude"),
    )
}

impl Roots {
    fn resolve() -> Result<Self, String> {
        let home = env_dir("HOME").ok_or("home_unavailable")?;
        let claude_app = claude_app_dir(&home);
        Ok(Self {
            codex: env_dir("CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            claude: env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
            cowork: env_dir("COWORK_SESSIONS_DIR").or_else(|| {
                claude_app
                    .as_ref()
                    .map(|dir| dir.join("local-agent-mode-sessions"))
            }),
            claude_app,
            workbuddy: home.join(".workbuddy"),
            workbuddy_tasks: home.join("WorkBuddy"),
            home,
        })
    }

    /// (directory, max nested directory depth) pairs holding session files.
    fn session_dirs(&self, source: AgentSource) -> Vec<(PathBuf, usize)> {
        match source {
            // sessions/YYYY/MM/DD/rollout-*.jsonl
            AgentSource::Codex => vec![
                (self.codex.join("sessions"), 3),
                (self.codex.join("archived_sessions"), 3),
            ],
            // projects/<encoded-workspace>/<session-id>.jsonl; subagents sit one level deeper.
            AgentSource::Claude => vec![(self.claude.join("projects"), 1)],
            AgentSource::Workbuddy => vec![(self.workbuddy.join("projects"), 1)],
            // Cowork transcripts are found by `collect_cowork`; the Code tab's live with Claude
            // Code's; Fred is not scanned.
            AgentSource::ClaudeDesktop | AgentSource::Fred => Vec::new(),
        }
    }
}

struct Candidate {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
}

fn accepts_file(source: AgentSource, name: &str) -> bool {
    match source {
        AgentSource::Codex => name.starts_with("rollout-") && name.ends_with(".jsonl"),
        _ => name.ends_with(".jsonl"),
    }
}

/// Subdirectories of `dir`; symlinks are not followed.
fn subdirectories(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect()
}

fn name_starts_with(path: &Path, prefix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(prefix))
}

/// Cowork runs Claude Code with a private config folder per session:
/// `<root>/<org>/<account>/[agent/]local_<id>/.claude/projects/<slug>/<cli-session>.jsonl`.
fn collect_cowork(root: &Path, out: &mut Vec<Candidate>) {
    for org in subdirectories(root) {
        for account in subdirectories(&org) {
            for parent in [account.join("agent"), account] {
                for storage in subdirectories(&parent) {
                    if name_starts_with(&storage, "local_") {
                        let projects = storage.join(".claude").join("projects");
                        collect_files(AgentSource::ClaudeDesktop, &projects, 1, out);
                    }
                }
            }
        }
    }
}

/// The Cowork storage folder `local_<id>/` holding a transcript, if it is one.
fn cowork_storage(transcript: &Path) -> Option<&Path> {
    let projects = transcript.parent()?.parent()?;
    let config = projects.parent()?;
    let storage = config.parent()?;
    (projects.file_name()? == "projects"
        && config.file_name()? == ".claude"
        && name_starts_with(storage, "local_"))
    .then_some(storage)
}

/// A small regular file as text; symlinks are not followed.
pub(crate) fn read_small(path: &Path, max: u64) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    String::from_utf8(std::fs::read(path).ok()?).ok()
}

/// Claude desktop lists its sessions through records naming the Claude Code transcript
/// (`cliSessionId`): the Code tab's at `claude-code-sessions/<account>/<org>/local_<id>.json`,
/// Cowork's at `local-agent-mode-sessions/<org>/<account>/[agent/]local_<id>.json`. Collects the
/// transcript ids and the titles the app shows.
fn read_desktop_sessions(
    root: &Path,
    ids: &mut HashSet<String>,
    titles: &mut HashMap<String, String>,
) {
    for first in subdirectories(root) {
        for second in subdirectories(&first) {
            for dir in [second.join("agent"), second] {
                for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                    let path = entry.path();
                    if !name_starts_with(&path, "local_")
                        || path.extension().and_then(|ext| ext.to_str()) != Some("json")
                    {
                        continue;
                    }
                    let Some(record) = read_small(&path, MAX_RECORD_BYTES)
                        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    else {
                        continue;
                    };
                    let Some(id) = str_field(&record, "cliSessionId").filter(|id| valid_id(id))
                    else {
                        continue;
                    };
                    if let Some(title) = str_field(&record, "title") {
                        titles.insert(id.clone(), title);
                    }
                    ids.insert(id);
                }
            }
        }
    }
}

fn collect_files(source: AgentSource, dir: &Path, depth: usize, out: &mut Vec<Candidate>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // DirEntry::metadata does not follow symlinks, so links out of the root are skipped.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth > 0 {
                collect_files(source, &entry.path(), depth - 1, out);
            }
        } else if meta.is_file()
            && entry
                .file_name()
                .to_str()
                .is_some_and(|name| accepts_file(source, name))
        {
            out.push(Candidate {
                path: entry.path(),
                modified: meta.modified().ok(),
                len: meta.len(),
            });
        }
    }
}

fn is_sensitive_stem(stem: &str) -> bool {
    let joined = ["api", "access"]
        .iter()
        .fold(stem.to_string(), |text, prefix| {
            text.replace(&format!("{prefix}_key"), &format!("{prefix}key"))
                .replace(&format!("{prefix}-key"), &format!("{prefix}key"))
        });
    joined
        .split(['.', '_', '-', ' '])
        .any(|part| SENSITIVE_NAME_PARTS.contains(&part))
}

pub(crate) fn is_sensitive_file(name: &str) -> bool {
    let path = Path::new(name);
    let lower = |part: Option<&std::ffi::OsStr>| {
        part.and_then(|part| part.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default()
    };
    is_sensitive_stem(&lower(path.file_stem()))
        || SENSITIVE_EXTENSIONS.contains(&lower(path.extension()).as_str())
}

/// Records normally hold absolute paths; relative ones resolve against the session folder.
fn absolute_path(path: &str, cwd: Option<&str>) -> Option<String> {
    if Path::new(path).is_absolute() {
        return Some(path.to_string());
    }
    let joined = Path::new(cwd?).join(path);
    if joined.is_absolute() {
        joined.to_str().map(str::to_string)
    } else {
        None
    }
}

/// Opaque, stable id for a path (64-bit FNV-1a), so the WebView never sends paths.
fn file_id(path: &str) -> String {
    let hash = path.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}

fn valid_file_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Fred's managed workspace folder name: `conversation-<24 hex>`.
fn valid_workspace_key(key: &str) -> bool {
    key.strip_prefix("conversation-").is_some_and(|hex| {
        hex.len() == 24
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn millis(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", &value[..index]),
        None => value.to_string(),
    }
}

fn title_from_prompt(prompt: &str) -> Option<String> {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(truncate_chars(line, MAX_TITLE_CHARS))
}

fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Concatenates `text` of content items whose `type` equals `kind`.
fn join_text(content: &Value, kind: &str) -> String {
    let Some(items) = content.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter(|item| item["type"].as_str() == Some(kind))
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn for_each_line<R: BufRead>(mut reader: R, mut handle: impl FnMut(&[u8]) -> bool) {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buffer.len() > MAX_LINE_BYTES {
            continue;
        }
        if !handle(&buffer) {
            break;
        }
    }
}

fn line_head(line: &[u8]) -> &str {
    let head = &line[..line.len().min(LINE_PREFIX_SCAN_BYTES)];
    match std::str::from_utf8(head) {
        Ok(text) => text,
        // The prefix may end inside a multi-byte character.
        Err(error) => std::str::from_utf8(&head[..error.valid_up_to()]).unwrap_or_default(),
    }
}

fn is_codex_subagent(meta: &Value) -> bool {
    meta["thread_source"].as_str() == Some("subagent") || meta["source"].get("subagent").is_some()
}

/// Codex rollout: the files of completed FileChange items, their models and the first prompt.
/// Subagent threads belong to their parent and are skipped.
fn parse_codex<R: BufRead>(reader: R) -> Option<SessionRecord> {
    let mut session = SessionRecord::default();
    let mut subagent = false;
    for_each_line(reader, |line| {
        let head = line_head(line);
        if !CODEX_MARKERS.iter().any(|marker| head.contains(marker)) {
            return true;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        let payload = &value["payload"];
        match value["type"].as_str() {
            Some("session_meta") => {
                if is_codex_subagent(payload) {
                    subagent = true;
                    return false;
                }
                if session.id.is_empty() {
                    session.id = str_field(payload, "id")
                        .or_else(|| str_field(payload, "session_id"))
                        .unwrap_or_default();
                    session.created_at =
                        payload["timestamp"].as_str().and_then(parse_rfc3339_millis);
                    session.cwd = str_field(payload, "cwd");
                }
            }
            Some("turn_context") => {
                if let Some(model) = str_field(payload, "model") {
                    session.model = Some(model);
                }
            }
            Some("event_msg") => {
                let item = &payload["item"];
                match (payload["type"].as_str(), item["type"].as_str()) {
                    (Some("item_completed"), Some("UserMessage")) => {
                        session.note_prompt(&join_text(&item["content"], "text"));
                    }
                    // Older rollouts record the prompt as a user_message event.
                    (Some("user_message"), _) => {
                        session.note_prompt(payload["message"].as_str().unwrap_or_default());
                    }
                    (Some("item_completed"), Some("FileChange"))
                        if item["status"].as_str() == Some("completed") =>
                    {
                        for (path, change) in item["changes"].as_object().into_iter().flatten() {
                            if change["type"].as_str() == Some("delete") {
                                continue;
                            }
                            let target = change["move_path"].as_str().unwrap_or(path);
                            let model = session.model.clone();
                            session.note_write(target, model);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        true
    });
    session.title = session.first_prompt.as_deref().and_then(title_from_prompt);
    (!subagent).then_some(session)
}

/// WorkBuddy wraps the typed request in `<user_query>`; everything else in a user
/// message is injected context.
fn workbuddy_user_query(text: &str) -> Option<String> {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    let mut queries = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let Some(end) = after.find(CLOSE) else { break };
        queries.push(after[..end].trim());
        rest = &after[end + CLOSE.len()..];
    }
    let query = if queries.is_empty() {
        strip_system_reminders(text)
    } else {
        queries.join("\n\n")
    };
    let query = query.trim();
    (!query.is_empty()).then(|| query.to_string())
}

fn strip_system_reminders(text: &str) -> String {
    const OPEN: &str = "<system-reminder";
    const CLOSE: &str = "</system-reminder>";
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        output.push_str(&rest[..start]);
        match rest[start..].find(CLOSE) {
            Some(end) => rest = &rest[start + end + CLOSE.len()..],
            None => return output,
        }
    }
    output.push_str(rest);
    output
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let Some(hex) = bytes
                .get(index + 1..index + 3)
                .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))
            {
                let text = std::str::from_utf8(hex).unwrap_or_default();
                if let Ok(byte) = u8::from_str_radix(text, 16) {
                    output.push(byte);
                    index += 3;
                    continue;
                }
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

/// WorkBuddy expert ("buddy") name from W3C baggage, e.g. `buddyId=,buddyName=…`.
fn workbuddy_buddy_name(value: &Value) -> Option<String> {
    let baggage = value["_meta"]["baggage"].as_str()?;
    baggage
        .split(',')
        .find_map(|item| item.trim().strip_prefix("buddyName="))
        .map(|name| percent_decode(name).trim().to_string())
        .filter(|name| !name.is_empty())
}

/// The trimmed text between `<tag>` and `</tag>`.
fn tag_text<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&format!("</{tag}>"))?;
    Some(text[start..end].trim())
}

fn claude_prompt(text: &str) -> Option<String> {
    let text = strip_system_reminders(text);
    // A slash command's request is its arguments.
    let text = tag_text(&text, "command-args").unwrap_or(text.trim());
    (!text.is_empty() && !CLAUDE_NON_PROMPTS.iter().any(|tag| text.starts_with(tag)))
        .then(|| text.to_string())
}

/// Claude Code transcript, which the Claude desktop app also writes: files of file tools whose
/// result arrived without an error, the models that wrote them, the title and first prompt.
fn parse_claude<R: BufRead>(reader: R) -> SessionRecord {
    let mut session = SessionRecord::default();
    // Tool use id -> (file path, model) until its result arrives.
    let mut pending: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut summary: Option<String> = None;

    for_each_line(reader, |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        if session.id.is_empty() {
            session.id = str_field(&value, "sessionId").unwrap_or_default();
        }
        if session.cwd.is_none() {
            session.cwd = str_field(&value, "cwd");
        }
        if session.created_at.is_none() {
            session.created_at = value["timestamp"].as_str().and_then(parse_rfc3339_millis);
        }
        let message = &value["message"];
        match value["type"].as_str() {
            // Set by the user with `/rename`.
            Some("custom-title") => {
                custom_title = str_field(&value, "customTitle").or(custom_title.take());
            }
            Some("ai-title") => ai_title = str_field(&value, "aiTitle").or(ai_title.take()),
            // Older Claude Code versions summarise the session instead.
            Some("summary") if summary.is_none() => summary = str_field(&value, "summary"),
            Some("assistant") => {
                if let Some(model) =
                    str_field(message, "model").filter(|model| model != "<synthetic>")
                {
                    session.model = Some(model);
                }
                for item in message["content"].as_array().into_iter().flatten() {
                    let name = item["name"].as_str().unwrap_or_default();
                    if item["type"].as_str() != Some("tool_use")
                        || !CLAUDE_FILE_TOOLS.contains(&name)
                    {
                        continue;
                    }
                    if let (Some(id), Some(path)) = (
                        str_field(item, "id"),
                        str_field(&item["input"], "file_path"),
                    ) {
                        pending.insert(id, (path, session.model.clone()));
                    }
                }
            }
            Some("user") if value["isMeta"].as_bool() != Some(true) => {
                let mut texts = Vec::new();
                match &message["content"] {
                    Value::String(text) => texts.push(text.as_str()),
                    Value::Array(items) => {
                        for item in items {
                            match item["type"].as_str() {
                                Some("text") => texts.extend(item["text"].as_str()),
                                Some("tool_result") => {
                                    let Some((path, model)) = item["tool_use_id"]
                                        .as_str()
                                        .and_then(|id| pending.remove(id))
                                    else {
                                        continue;
                                    };
                                    if item["is_error"].as_bool() != Some(true) {
                                        session.note_write(&path, model);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                // Subagent turns kept in the transcript and the summary written by `/compact`
                // are not the user's requests.
                if value["isSidechain"].as_bool() != Some(true)
                    && value["isCompactSummary"].as_bool() != Some(true)
                {
                    if let Some(text) = claude_prompt(&texts.join("\n")) {
                        session.note_prompt(&text);
                    }
                }
            }
            _ => {}
        }
        true
    });
    session.title = custom_title
        .or(ai_title)
        .or(summary)
        .map(|title| truncate_chars(&title, MAX_TITLE_CHARS))
        .or_else(|| session.first_prompt.as_deref().and_then(title_from_prompt));
    session
}

/// WorkBuddy session: its task folder (`cwd`), title, first request, expert and model. The
/// files are found in the task folder, so tool calls are not read.
fn parse_workbuddy<R: BufRead>(reader: R) -> SessionRecord {
    let mut session = SessionRecord::default();
    let mut ai_title: Option<String> = None;
    for_each_line(reader, |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        if session.id.is_empty() {
            session.id = str_field(&value, "sessionId").unwrap_or_default();
        }
        if session.cwd.is_none() {
            session.cwd = str_field(&value, "cwd");
        }
        if session.created_at.is_none() {
            session.created_at = value["timestamp"].as_i64();
        }
        if session.employee_name.is_none() {
            session.employee_name = workbuddy_buddy_name(&value);
        }
        match (value["type"].as_str(), value["role"].as_str()) {
            (Some("ai-title"), _) => ai_title = str_field(&value, "aiTitle").or(ai_title.take()),
            // Mode switches and reminders arrive as user messages without a query.
            (Some("message"), Some("user")) => {
                if let Some(query) =
                    workbuddy_user_query(&join_text(&value["content"], "input_text"))
                {
                    session.note_prompt(&query);
                }
            }
            (Some("message"), Some("assistant")) => {
                if let Some(model) = str_field(&value["providerData"], "model") {
                    session.model = Some(model);
                }
            }
            _ => {}
        }
        true
    });
    session.title = ai_title
        .map(|title| truncate_chars(&title, MAX_TITLE_CHARS))
        .or_else(|| session.first_prompt.as_deref().and_then(title_from_prompt));
    session
}

/// Codex and Claude Code sessions that wrote nothing cannot have made a project.
fn parse_file(source: AgentSource, path: &Path) -> Option<SessionRecord> {
    let reader = BufReader::with_capacity(256 * 1024, File::open(path).ok()?);
    let mut session = match source {
        AgentSource::Codex => parse_codex(reader)?,
        AgentSource::Claude | AgentSource::ClaudeDesktop => parse_claude(reader),
        AgentSource::Workbuddy => parse_workbuddy(reader),
        AgentSource::Fred => return None,
    };
    // Rollouts are named by time; other transcripts are named by session id.
    if session.id.is_empty() && source != AgentSource::Codex {
        session.id = path.file_stem()?.to_str()?.to_string();
    }
    let wrote = !session.writes.is_empty() || cowork_storage(path).is_some();
    let needs_writes = matches!(source, AgentSource::Codex | AgentSource::Claude);
    (valid_id(&session.id) && (wrote || !needs_writes)).then_some(session)
}

/// Thread names from a Codex `session_index.jsonl`; later lines supersede earlier ones.
fn read_thread_names(path: &Path, titles: &mut HashMap<String, String>) {
    let Ok(file) = File::open(path) else {
        return;
    };
    for_each_line(BufReader::new(file), |line| {
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            if let (Some(id), Some(name)) =
                (str_field(&value, "id"), str_field(&value, "thread_name"))
            {
                titles.insert(id, name);
            }
        }
        true
    });
}

/// WorkBuddy gives each task its own `~/WorkBuddy/YYYY-MM-DD-HH-MM-SS` folder.
fn is_workbuddy_task_folder(dir: &Path, task_root: &Path) -> bool {
    dir.parent() == Some(task_root)
        && dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.len() == 19
                    && name.bytes().enumerate().all(|(index, byte)| match index {
                        4 | 7 | 10 | 13 | 16 => byte == b'-',
                        _ => byte.is_ascii_digit(),
                    })
            })
}

/// When a path came into being, as far as the file system tells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Birth {
    Missing,
    At(i64),
    /// The path exists but the file system does not record creation times.
    Unknown,
}

fn birth_time(path: &Path) -> Birth {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Birth::Missing,
        // Unreadable entries and symlinks are treated as the user's own, older ones.
        Err(_) => Birth::At(i64::MIN),
        Ok(meta) if meta.file_type().is_symlink() => Birth::At(i64::MIN),
        Ok(meta) => meta
            .created()
            .ok()
            .and_then(millis)
            .map_or(Birth::Unknown, Birth::At),
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CreationTimeUnavailable;

/// The project a session made by writing `file`: the outermost folder under the home folder
/// created after the session started (less `CREATION_GRACE_MS`). Folders the user already had,
/// hidden folders, `~/Library`, and new folders inside an existing repository or package are not
/// projects.
fn project_root(
    file: &Path,
    start: i64,
    home: &Path,
    birth: &mut impl FnMut(&Path) -> Birth,
) -> Result<Option<PathBuf>, CreationTimeUnavailable> {
    let Ok(relative) = file.strip_prefix(home) else {
        return Ok(None);
    };
    let plain = relative.components().all(|component| match component {
        Component::Normal(part) => !part.to_string_lossy().starts_with('.'),
        _ => false,
    });
    let first = relative.components().next();
    if !plain || first.is_some_and(|part| part.as_os_str() == "Library") {
        return Ok(None);
    }
    let threshold = start.saturating_sub(CREATION_GRACE_MS);
    // Folders deleted since the session hold nothing to show; start from the deepest one left.
    let mut dir = file.parent();
    while let Some(current) = dir.filter(|current| *current != home) {
        if birth(current) != Birth::Missing {
            break;
        }
        dir = current.parent();
    }
    let mut root = None;
    while let Some(current) = dir.filter(|current| *current != home && current.starts_with(home)) {
        match birth(current) {
            Birth::At(time) if time >= threshold => {
                root = Some(current);
                dir = current.parent();
            }
            Birth::Unknown => return Err(CreationTimeUnavailable),
            _ => break,
        }
    }
    let Some(root) = root else {
        return Ok(None);
    };
    for ancestor in root.ancestors().skip(1).take_while(|dir| *dir != home) {
        for marker in PROJECT_MARKERS {
            match birth(&ancestor.join(marker)) {
                Birth::Missing => {}
                Birth::At(time) if time >= threshold => {}
                _ => return Ok(None),
            }
        }
    }
    Ok(Some(root.to_path_buf()))
}

/// Distinct project folders of a session's writes.
fn session_project_roots(
    session: &SessionRecord,
    home: &Path,
    birth: &mut impl FnMut(&Path) -> Birth,
) -> Result<Vec<PathBuf>, CreationTimeUnavailable> {
    let Some(start) = session.created_at else {
        return Ok(Vec::new());
    };
    let mut roots: Vec<PathBuf> = Vec::new();
    for (path, _) in &session.writes {
        if let Some(root) = project_root(Path::new(path), start, home, birth)? {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    Ok(roots)
}

/// Folders inside another listed folder belong to it.
fn drop_nested(mut dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    // Component order puts every folder before the folders inside it.
    dirs.sort();
    let mut kept: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !kept.iter().any(|parent| dir.starts_with(parent)) {
            kept.push(dir);
        }
    }
    kept
}

struct Listing {
    files: Vec<ProjectFile>,
    truncated: bool,
}

impl Listing {
    fn updated_at(&self) -> Option<i64> {
        self.files.iter().filter_map(|file| file.modified_at).max()
    }
}

/// `path` relative to `root`, `/`-separated; `None` for anything but plain UTF-8 names.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let parts = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The project's files in path order: non-empty regular files outside hidden, dependency and
/// cache folders, without credential-like names. Symlinks are not followed.
/// The project's listed files, as the workbench shows them.
pub(crate) fn project_files(root: &Path) -> Vec<ProjectFile> {
    list_project(root, MAX_PROJECT_FILES).files
}

fn list_project(root: &Path, limit: usize) -> Listing {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut budget = MAX_PROJECT_ENTRIES;
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    'walk: while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        let mut subdirs = Vec::new();
        for entry in entries {
            if budget == 0 {
                truncated = true;
                break 'walk;
            }
            budget -= 1;
            let name = entry.file_name();
            let Some(name) = name.to_str().filter(|name| !name.starts_with('.')) else {
                continue;
            };
            // DirEntry::file_type does not follow symlinks.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if IGNORED_DIRS.contains(&name) {
                    continue;
                }
                if depth >= MAX_PROJECT_DEPTH {
                    truncated = true;
                } else {
                    subdirs.push(entry.path());
                }
            } else if kind.is_file() && !is_sensitive_file(name) {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() == 0 {
                    continue;
                }
                let path = entry.path();
                let Some(relative) = relative_path(root, &path) else {
                    continue;
                };
                if files.len() >= limit {
                    truncated = true;
                    break 'walk;
                }
                files.push(ProjectFile {
                    id: file_id(&relative),
                    format: FileFormat::of(&path),
                    path: relative,
                    size: meta.len(),
                    modified_at: meta.modified().ok().and_then(millis),
                });
            }
        }
        stack.extend(subdirs.into_iter().rev().map(|dir| (dir, depth + 1)));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Listing { files, truncated }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ProjectInfo {
    name: Option<String>,
    description: Option<String>,
}

fn package_name(text: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    str_field(&value, "name").map(|name| truncate_chars(&name, MAX_TITLE_CHARS))
}

/// `name` of `[project]` or `[tool.poetry]` in a `pyproject.toml`.
fn pyproject_name(text: &str) -> Option<String> {
    let mut section = "";
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            section = line;
            continue;
        }
        if section != "[project]" && section != "[tool.poetry]" {
            continue;
        }
        let Some(value) = line
            .strip_prefix("name")
            .and_then(|rest| rest.trim_start().strip_prefix('='))
            .map(str::trim)
        else {
            continue;
        };
        let Some(quote) = value
            .chars()
            .next()
            .filter(|quote| matches!(quote, '"' | '\''))
        else {
            continue;
        };
        let inner = &value[1..];
        if let Some(name) = inner.find(quote).map(|end| inner[..end].trim()) {
            if !name.is_empty() {
                return Some(truncate_chars(name, MAX_TITLE_CHARS));
            }
        }
    }
    None
}

/// The first prose paragraph of a README, skipping headings, badges, HTML and code.
fn readme_summary(text: &str) -> Option<String> {
    let text = text.replace("\r\n", "\n");
    for paragraph in text.split("\n\n") {
        let lines: Vec<&str> = paragraph
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let Some(first) = lines.first() else { continue };
        if first.starts_with("```") {
            continue;
        }
        let prose: Vec<&str> = lines
            .iter()
            .filter(|line| {
                !["#", "![", "[![", "<", "---", "===", "```"]
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
            })
            .map(|line| line.trim_start_matches('>').trim())
            .filter(|line| !line.is_empty())
            .collect();
        if !prose.is_empty() {
            return Some(truncate_chars(&prose.join(" "), MAX_DESCRIPTION_CHARS));
        }
    }
    None
}

fn readme_file(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .find(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| README_NAMES.contains(&name.to_ascii_lowercase().as_str()))
        })
        .map(|entry| entry.path())
}

fn project_info(dir: &Path) -> ProjectInfo {
    let read = |name: &str| read_small(&dir.join(name), MAX_MANIFEST_BYTES);
    ProjectInfo {
        name: read("package.json")
            .and_then(|text| package_name(&text))
            .or_else(|| read("pyproject.toml").and_then(|text| pyproject_name(&text))),
        description: readme_file(dir)
            .and_then(|path| read_small(&path, MAX_MANIFEST_BYTES))
            .and_then(|text| readme_summary(&text)),
    }
}

/// What the sessions that made one project say about it; the earliest session names it.
struct Found {
    source: AgentSource,
    created_at: Option<i64>,
    title: Option<String>,
    first_prompt: Option<String>,
    employee_name: Option<String>,
    model: Option<String>,
    models: Vec<String>,
    seeded: bool,
}

impl Found {
    fn new(source: AgentSource) -> Self {
        Self {
            source,
            created_at: None,
            title: None,
            first_prompt: None,
            employee_name: None,
            model: None,
            models: Vec::new(),
            seeded: false,
        }
    }

    fn merge(
        &mut self,
        source: AgentSource,
        session: &SessionRecord,
        title: Option<String>,
        dir: &Path,
    ) {
        let earlier = !self.seeded
            || match (session.created_at, self.created_at) {
                (Some(new), Some(old)) => new < old,
                (Some(_), None) => true,
                _ => false,
            };
        if earlier {
            self.seeded = true;
            self.source = source;
            self.created_at = session.created_at;
            self.title = title;
            self.first_prompt = session.first_prompt.clone();
            self.employee_name = session.employee_name.clone();
        }
        let mut models: Vec<&String> = session
            .writes
            .iter()
            .filter(|(path, _)| Path::new(path).starts_with(dir))
            .filter_map(|(_, model)| model.as_ref())
            .collect();
        if models.is_empty() {
            models.extend(&session.model);
        }
        for model in models {
            if !self.models.contains(model) {
                self.models.push(model.clone());
            }
            self.model = Some(model.clone());
        }
    }
}

impl Cache {
    fn refresh(&mut self, roots: &Roots) -> (Vec<SourceStatus>, Vec<ProjectSummary>) {
        let mut titles = HashMap::new();
        read_thread_names(&roots.codex.join("session_index.jsonl"), &mut titles);
        // Claude Code transcripts the desktop app lists belong to the app.
        let mut desktop = HashSet::new();
        let code_tab = roots
            .claude_app
            .as_ref()
            .map(|dir| dir.join("claude-code-sessions"));
        for dir in code_tab.iter().chain(&roots.cowork) {
            read_desktop_sessions(dir, &mut desktop, &mut titles);
        }

        let mut sessions = HashMap::new();
        let mut parsed: Vec<(AgentSource, PathBuf)> = Vec::new();
        let mut statuses = Vec::new();
        for source in AgentSource::SCANNED {
            let mut available = false;
            let mut candidates = Vec::new();
            for (dir, depth) in roots.session_dirs(source) {
                if dir.is_dir() {
                    available = true;
                    collect_files(source, &dir, depth, &mut candidates);
                }
            }
            match source {
                AgentSource::ClaudeDesktop => {
                    available = roots
                        .claude_app
                        .iter()
                        .chain(&roots.cowork)
                        .any(|dir| dir.is_dir());
                    if let Some(cowork) = roots.cowork.as_deref().filter(|dir| dir.is_dir()) {
                        collect_cowork(cowork, &mut candidates);
                    }
                }
                AgentSource::Workbuddy => available |= roots.workbuddy_tasks.is_dir(),
                _ => {}
            }
            candidates.sort_by_key(|candidate| Reverse(candidate.modified));
            let truncated = candidates.len() > MAX_SESSIONS_PER_SOURCE;
            candidates.truncate(MAX_SESSIONS_PER_SOURCE);
            for candidate in candidates {
                let entry = match self.sessions.remove(&candidate.path) {
                    Some(entry)
                        if entry.modified == candidate.modified && entry.len == candidate.len =>
                    {
                        entry
                    }
                    _ => CacheEntry {
                        modified: candidate.modified,
                        len: candidate.len,
                        session: parse_file(source, &candidate.path),
                    },
                };
                if entry.session.is_some() {
                    parsed.push((source, candidate.path.clone()));
                }
                sessions.insert(candidate.path, entry);
            }
            statuses.push(SourceStatus {
                source,
                available,
                project_count: 0,
                truncated,
                creation_time_unavailable: false,
            });
        }
        self.sessions = sessions;

        let mut births: HashMap<PathBuf, Birth> = HashMap::new();
        let mut birth = |path: &Path| {
            *births
                .entry(path.to_path_buf())
                .or_insert_with(|| birth_time(path))
        };
        let mut found: HashMap<PathBuf, Found> = HashMap::new();
        for (scanned, path) in &parsed {
            let Some(session) = self
                .sessions
                .get(path)
                .and_then(|entry| entry.session.as_ref())
            else {
                continue;
            };
            let source = if *scanned == AgentSource::Claude && desktop.contains(&session.id) {
                AgentSource::ClaudeDesktop
            } else {
                *scanned
            };
            let dirs = if source == AgentSource::Workbuddy {
                session
                    .cwd
                    .as_deref()
                    .map(Path::new)
                    .filter(|dir| is_workbuddy_task_folder(dir, &roots.workbuddy_tasks))
                    .map(Path::to_path_buf)
                    .into_iter()
                    .collect()
            } else if let Some(storage) = cowork_storage(path) {
                // Cowork keeps its deliverables in the session's `outputs/`, however saved.
                vec![storage.join("outputs")]
            } else {
                match session_project_roots(session, &roots.home, &mut birth) {
                    Ok(dirs) => dirs,
                    Err(CreationTimeUnavailable) => {
                        if let Some(status) = statuses.iter_mut().find(|s| s.source == source) {
                            status.creation_time_unavailable = true;
                        }
                        continue;
                    }
                }
            };
            let title = match source {
                AgentSource::Workbuddy => None,
                _ => titles
                    .get(&session.id)
                    .and_then(|name| title_from_prompt(name)),
            }
            .or_else(|| session.title.clone());
            for dir in dirs {
                found
                    .entry(dir.clone())
                    .or_insert_with(|| Found::new(source))
                    .merge(source, session, title.clone(), &dir);
            }
        }
        // A WorkBuddy task folder still holds the task's work after its session record is gone.
        for dir in subdirectories(&roots.workbuddy_tasks) {
            if is_workbuddy_task_folder(&dir, &roots.workbuddy_tasks) {
                found
                    .entry(dir)
                    .or_insert_with(|| Found::new(AgentSource::Workbuddy));
            }
        }

        let mut projects = Vec::new();
        let mut index = HashMap::new();
        for dir in drop_nested(found.keys().cloned().collect()) {
            let found = &found[&dir];
            let listing = list_project(&dir, MAX_PROJECT_FILES);
            if listing.files.is_empty() {
                continue;
            }
            let info = project_info(&dir);
            let id = file_id(&dir.to_string_lossy());
            let folder_name = dir
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            projects.push(ProjectSummary {
                source: found.source,
                id: id.clone(),
                name: info
                    .name
                    .or_else(|| found.title.clone())
                    .unwrap_or(folder_name),
                description: info.description.or_else(|| found.first_prompt.clone()),
                employee_name: found
                    .employee_name
                    .clone()
                    .unwrap_or_else(|| found.source.default_employee().into()),
                model: found.model.clone(),
                models: found.models.clone(),
                location: display_path(&dir, &roots.home),
                created_at: found.created_at,
                updated_at: listing.updated_at().or(found.created_at),
                file_count: listing.files.len(),
                truncated: listing.truncated,
                files: listing.files,
            });
            index.insert((found.source, id), dir);
        }
        projects.sort_by_key(|project| Reverse(project.updated_at));
        for status in &mut statuses {
            status.project_count = projects
                .iter()
                .filter(|project| project.source == status.source)
                .count();
        }
        self.index = index;
        (statuses, projects)
    }
}

/// Fred's managed workspace folder for `key`, if it exists as a real folder.
fn fred_workspace(root: &Path, key: &str) -> Result<Option<PathBuf>, String> {
    if !valid_workspace_key(key) {
        return Err("invalid_workspace_key".into());
    }
    let dir = root.join(key);
    Ok(std::fs::symlink_metadata(&dir)
        .is_ok_and(|meta| meta.is_dir())
        .then_some(dir))
}

fn list_fred_workspaces(root: &Path, keys: &[String]) -> Result<Vec<FredWorkspace>, String> {
    if keys.len() > MAX_FRED_KEYS {
        return Err("too_many_workspaces".into());
    }
    let mut seen = HashSet::new();
    let mut workspaces = Vec::new();
    for key in keys {
        let Some(dir) = fred_workspace(root, key)? else {
            continue;
        };
        if !seen.insert(key.as_str()) {
            continue;
        }
        let listing = list_project(&dir, MAX_PROJECT_FILES);
        let info = project_info(&dir);
        workspaces.push(FredWorkspace {
            workspace_key: key.clone(),
            name: info.name,
            description: info.description,
            updated_at: listing.updated_at(),
            file_count: listing.files.len(),
            truncated: listing.truncated,
            files: listing.files,
        });
    }
    Ok(workspaces)
}

/// The listed file with `file_id` in the project folder, found by listing it again.
fn find_project_file(root: &Path, file_id: &str) -> Result<(PathBuf, ProjectFile), String> {
    let file = list_project(root, MAX_PROJECT_FILES)
        .files
        .into_iter()
        .find(|file| file.id == file_id)
        .ok_or("file_not_found")?;
    Ok((root.join(&file.path), file))
}

fn read_project_file_at(root: &Path, file_id: &str) -> Result<ProjectFileContent, String> {
    let (path, file) = find_project_file(root, file_id)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|_| "file_missing")?;
    if !meta.is_file() {
        return Err("file_missing".into());
    }
    let mut format = file.format;
    let content = match format {
        FileFormat::Image | FileFormat::Document => None,
        FileFormat::Other if meta.len() > MAX_PREVIEW_BYTES => None,
        _ if meta.len() > MAX_PREVIEW_BYTES => return Err("file_too_large".into()),
        FileFormat::Other => {
            let bytes = std::fs::read(&path).map_err(|_| "file_unreadable")?;
            // Unknown extensions are shown only when they are text.
            let text = String::from_utf8(bytes)
                .ok()
                .filter(|text| !text.contains('\0'));
            if text.is_some() {
                format = FileFormat::Text;
            }
            text
        }
        _ => {
            let bytes = std::fs::read(&path).map_err(|_| "file_unreadable")?;
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
    };
    let name = file
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&file.path)
        .to_string();
    Ok(ProjectFileContent {
        name,
        path: file.path,
        format,
        size: meta.len(),
        content,
    })
}

#[cfg(target_os = "macos")]
fn system_open_command(path: &Path, reveal: bool) -> std::process::Command {
    let mut command = std::process::Command::new("open");
    if reveal {
        command.arg("-R");
    }
    command.arg(path);
    command
}

#[cfg(target_os = "windows")]
fn system_open_command(path: &Path, reveal: bool) -> std::process::Command {
    let mut command = std::process::Command::new("explorer");
    if reveal {
        command.arg("/select,");
    }
    command.arg(path);
    command
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_open_command(path: &Path, reveal: bool) -> std::process::Command {
    let mut command = std::process::Command::new("xdg-open");
    command.arg(if reveal {
        path.parent().unwrap_or(path)
    } else {
        path
    });
    command
}

/// Opens the file, or the project folder without `file_id`, with the system app; `reveal`
/// shows it in Finder / Explorer instead.
fn open_project_path(root: &Path, file_id: Option<&str>, reveal: bool) -> Result<(), String> {
    let path = match file_id {
        Some(id) => find_project_file(root, id)?.0,
        None => root.to_path_buf(),
    };
    if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file() || meta.is_dir()) {
        return Err("file_missing".into());
    }
    system_open_command(&path, reveal)
        .spawn()
        .map(|_| ())
        .map_err(|_| "open_failed".into())
}

/// Fred's managed workspaces: `<app data>/agent-data/workspaces`, as the bundled Agent uses.
fn fred_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("agent-data").join("workspaces"))
        .map_err(|_| "data_dir_unavailable".into())
}

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
) -> Result<Vec<FredWorkspace>, String> {
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

/// Milliseconds since the epoch for `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`.
fn parse_rfc3339_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |start: usize, end: usize| -> Option<i64> {
        let text = value.get(start..end)?;
        text.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| text.parse().ok())?
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let mut index = 19;
    let mut fraction_millis = 0;
    if bytes.get(index) == Some(&b'.') {
        let start = index + 1;
        index = start;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        let digits: String = value[start..index]
            .chars()
            .chain(std::iter::repeat('0'))
            .take(3)
            .collect();
        fraction_millis = digits.parse::<i64>().ok()?;
    }
    let offset_minutes = match bytes.get(index)? {
        b'Z' | b'z' if index + 1 == bytes.len() => 0,
        sign @ (b'+' | b'-') if index + 6 == bytes.len() && bytes[index + 3] == b':' => {
            let total = number(index + 1, index + 3)? * 60 + number(index + 4, index + 6)?;
            if *sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = ((days * 24 + hour) * 60 + minute) * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + fraction_millis)
}

// Howard Hinnant's days_from_civil: proleptic Gregorian date to days since 1970-01-01.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    const START: i64 = 1_800_000_000_000;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aiteam-projects-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn lines(values: &[Value]) -> Cursor<Vec<u8>> {
        let mut text = String::new();
        for value in values {
            text.push_str(&value.to_string());
            text.push('\n');
        }
        Cursor::new(text.into_bytes())
    }

    fn fake_births(entries: &[(&str, Birth)]) -> impl FnMut(&Path) -> Birth {
        let births: HashMap<PathBuf, Birth> = entries
            .iter()
            .map(|(path, birth)| (PathBuf::from(path), *birth))
            .collect();
        move |path: &Path| births.get(path).copied().unwrap_or(Birth::Missing)
    }

    fn root_of(file: &str, births: &mut impl FnMut(&Path) -> Birth) -> Option<String> {
        project_root(Path::new(file), START, Path::new("/h"), births)
            .unwrap()
            .map(|root| root.display().to_string())
    }

    #[test]
    fn project_root_is_the_outermost_folder_created_after_the_session_started() {
        let old = Birth::At(START - 86_400_000);
        let new = Birth::At(START + 1_000);
        let mut births = fake_births(&[
            ("/h/game", new),
            ("/h/game/js", new),
            ("/h/Desktop", old),
            ("/h/early", Birth::At(START - 60_000)),
            ("/h/stale", Birth::At(START - 180_000)),
            ("/h/gone", new),
        ]);
        assert_eq!(
            root_of("/h/game/js/app.js", &mut births).as_deref(),
            Some("/h/game")
        );
        assert_eq!(
            root_of("/h/game/index.html", &mut births).as_deref(),
            Some("/h/game")
        );
        // Written into a folder the user already had, or straight into home.
        assert_eq!(root_of("/h/Desktop/page.html", &mut births), None);
        assert_eq!(root_of("/h/notes.md", &mut births), None);
        // Folders made shortly before the first record still count.
        assert_eq!(
            root_of("/h/early/a.py", &mut births).as_deref(),
            Some("/h/early")
        );
        assert_eq!(root_of("/h/stale/a.py", &mut births), None);
        // Deeper folders deleted since the session do not hide the one left.
        assert_eq!(
            root_of("/h/gone/deeper/a.txt", &mut births).as_deref(),
            Some("/h/gone")
        );
    }

    #[test]
    fn project_root_skips_existing_projects_hidden_and_outside_folders() {
        let old = Birth::At(START - 86_400_000);
        let new = Birth::At(START + 1_000);
        let mut births = fake_births(&[
            ("/h/repo", old),
            ("/h/repo/.git", old),
            ("/h/repo/src", old),
            ("/h/repo/src/api", new),
            ("/h/work", old),
            ("/h/work/package.json", Birth::At(START + 5_000)),
            ("/h/work/app", new),
            ("/h/.codex/out", new),
            ("/h/Library/x", new),
            ("/other/new", new),
        ]);
        // A new folder inside a repository the user already had belongs to that repository.
        assert_eq!(root_of("/h/repo/src/api/client.ts", &mut births), None);
        // A marker the session created itself does not make the parent the user's.
        assert_eq!(
            root_of("/h/work/app/main.py", &mut births).as_deref(),
            Some("/h/work/app")
        );
        assert_eq!(root_of("/h/.codex/out/a.md", &mut births), None);
        assert_eq!(root_of("/h/Library/x/a.md", &mut births), None);
        assert_eq!(root_of("/other/new/a.md", &mut births), None);
        assert_eq!(root_of("/h/game/../repo/a.md", &mut births), None);

        let mut unknown = fake_births(&[("/h/x", Birth::Unknown)]);
        assert_eq!(
            project_root(Path::new("/h/x/a.md"), START, Path::new("/h"), &mut unknown),
            Err(CreationTimeUnavailable)
        );
    }

    #[test]
    fn nested_project_folders_merge_into_the_outer_one() {
        let dirs = vec![
            PathBuf::from("/h/a/b"),
            PathBuf::from("/h/a-b"),
            PathBuf::from("/h/a"),
            PathBuf::from("/h/c"),
        ];
        assert_eq!(
            drop_nested(dirs),
            [
                PathBuf::from("/h/a"),
                PathBuf::from("/h/a-b"),
                PathBuf::from("/h/c")
            ]
        );
    }

    #[test]
    fn project_listing_skips_hidden_dependency_empty_sensitive_and_linked_files() {
        let root = temp_root("listing");
        let outside = temp_root("listing-outside");
        for (name, text) in [
            ("index.html", "<h1>hi</h1>"),
            ("js/app.js", "console.log(1)"),
            ("empty.txt", ""),
            (".env", "TOKEN=1"),
            (".git/config", "[core]"),
            ("node_modules/pkg/index.js", "x"),
            ("__pycache__/a.pyc", "x"),
            ("venv/bin/python", "x"),
            ("secrets.json", "{}"),
            ("server.pem", "-----BEGIN"),
        ] {
            write(&root.join(name), text);
        }
        write(&outside.join("real.txt"), "outside");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.join("real.txt"), root.join("link.txt")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("linked-dir")).unwrap();
        }

        let listing = list_project(&root, MAX_PROJECT_FILES);
        let paths: Vec<_> = listing
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, ["index.html", "js/app.js"]);
        assert!(!listing.truncated);
        assert_eq!(listing.files[0].format, FileFormat::Html);
        assert_eq!(listing.files[1].format, FileFormat::Code);
        assert_eq!(listing.files[1].id, file_id("js/app.js"));

        let limited = list_project(&root, 1);
        assert_eq!(limited.files.len(), 1);
        assert!(limited.truncated);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn project_info_reads_package_names_and_the_readme_summary() {
        assert_eq!(
            package_name(r#"{"name": "snake-game"}"#).as_deref(),
            Some("snake-game")
        );
        assert_eq!(package_name("not json"), None);
        let pyproject = "[build-system]\nname = \"wrong\"\n\n[project]\nname = 'sales-dashboard'\n";
        assert_eq!(
            pyproject_name(pyproject).as_deref(),
            Some("sales-dashboard")
        );
        assert_eq!(
            pyproject_name("[tool.poetry]\nname=\"poem\"").as_deref(),
            Some("poem")
        );
        let readme = "# 贪吃蛇\n\n[![ci](x)](y)\n\n```bash\nnpm i\n```\n\n一个在浏览器里玩的\n贪吃蛇小游戏。\n\n## 运行";
        assert_eq!(
            readme_summary(readme).as_deref(),
            Some("一个在浏览器里玩的 贪吃蛇小游戏。")
        );
        assert_eq!(
            readme_summary("# Title\nIntro line"),
            Some("Intro line".into())
        );
        assert_eq!(readme_summary("# Only a heading"), None);

        let root = temp_root("info");
        write(&root.join("package.json"), r#"{"name":"vite-app"}"#);
        write(&root.join("README.md"), "A Vite app.");
        assert_eq!(
            project_info(&root),
            ProjectInfo {
                name: Some("vite-app".into()),
                description: Some("A Vite app.".into())
            }
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn codex_meta(extra: Value) -> Value {
        let mut payload =
            json!({ "id": "thread-1", "timestamp": "2026-10-01T10:00:00Z", "cwd": "/Users/me" });
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({ "type": "session_meta", "payload": payload })
    }

    fn codex_change(status: &str, changes: Value) -> Value {
        json!({ "type": "event_msg", "timestamp": "2026-10-01T10:05:00Z", "payload": {
            "type": "item_completed", "turn_id": "t1",
            "item": { "type": "FileChange", "status": status, "changes": changes } } })
    }

    #[test]
    fn codex_records_written_files_models_and_the_first_prompt() {
        let session = parse_codex(lines(&[
            codex_meta(json!({})),
            json!({ "type": "turn_context", "payload": { "model": "gpt-5.5" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "turn_id": "t1", "message": "做一个贪吃蛇小游戏\n要能暂停" } }),
            codex_change("completed", json!({
                "game/index.html": { "type": "add", "content": "<html>" },
                "/Users/me/game/old.js": { "type": "update", "unified_diff": "", "move_path": "/Users/me/game/main.js" },
                "/Users/me/game/tmp.txt": { "type": "delete" },
            })),
            codex_change("failed", json!({ "/Users/me/game/broken.js": { "type": "add", "content": "x" } })),
        ]))
        .unwrap();
        assert_eq!(session.id, "thread-1");
        assert_eq!(
            session.created_at,
            parse_rfc3339_millis("2026-10-01T10:00:00Z")
        );
        assert_eq!(session.title.as_deref(), Some("做一个贪吃蛇小游戏"));
        let mut writes: Vec<_> = session
            .writes
            .iter()
            .map(|(path, model)| (path.as_str(), model.as_deref()))
            .collect();
        writes.sort();
        assert_eq!(
            writes,
            [
                ("/Users/me/game/index.html", Some("gpt-5.5")),
                ("/Users/me/game/main.js", Some("gpt-5.5"))
            ]
        );
        assert!(
            parse_codex(lines(&[codex_meta(json!({ "thread_source": "subagent" }))])).is_none()
        );
    }

    fn claude_line(kind: &str, message: Value) -> Value {
        json!({ "type": kind, "sessionId": "c1", "cwd": "/Users/me/app",
            "timestamp": "2026-10-01T10:00:00Z", "message": message })
    }

    #[test]
    fn claude_records_only_file_tools_that_succeeded() {
        let session = parse_claude(lines(&[
            claude_line("user", json!({ "content": "做个落地页" })),
            claude_line(
                "assistant",
                json!({ "model": "claude-opus-5-5", "content": [
                { "type": "tool_use", "id": "w1", "name": "Write", "input": { "file_path": "site/index.html", "content": "x" } },
                { "type": "tool_use", "id": "w2", "name": "Write", "input": { "file_path": "/Users/me/app/site/bad.html", "content": "x" } },
                { "type": "tool_use", "id": "b1", "name": "Bash", "input": { "command": "ls" } }] }),
            ),
            claude_line(
                "user",
                json!({ "content": [
                { "type": "tool_result", "tool_use_id": "w1" },
                { "type": "tool_result", "tool_use_id": "w2", "is_error": true },
                { "type": "tool_result", "tool_use_id": "b1" }] }),
            ),
            json!({ "type": "ai-title", "aiTitle": "落地页" }),
        ]));
        assert_eq!(session.id, "c1");
        assert_eq!(session.title.as_deref(), Some("落地页"));
        assert_eq!(session.first_prompt.as_deref(), Some("做个落地页"));
        assert_eq!(
            session.writes,
            [(
                "/Users/me/app/site/index.html".to_string(),
                Some("claude-opus-5-5".to_string())
            )]
        );
    }

    fn creation_times_supported(dir: &Path) -> bool {
        let supported = std::fs::metadata(dir)
            .and_then(|meta| meta.created())
            .is_ok();
        if !supported {
            eprintln!("skipped: this file system does not record creation times");
        }
        supported
    }

    #[test]
    fn scan_finds_projects_from_every_source_on_disk() {
        let home = temp_root("scan");
        if !creation_times_supported(&home) {
            std::fs::remove_dir_all(&home).unwrap();
            return;
        }
        let at = |path: &str| home.join(path).display().to_string();
        let app = home.join("Library/Application Support/Claude");
        let cowork = app.join("local-agent-mode-sessions");

        // Codex: a new game folder becomes a project; a file written straight into home does not,
        // and nor does a session that started after the folder existed.
        write(&home.join("game/index.html"), "<canvas></canvas>");
        write(&home.join("game/js/app.js"), "start()");
        write(&home.join("game/README.md"), "# Snake\n\n浏览器贪吃蛇。");
        write(&home.join("notes.md"), "notes");
        write(&home.join("repo/src/new.py"), "print(1)");
        let rollout = |meta_time: &str, files: &[String]| {
            let changes: serde_json::Map<String, Value> = files
                .iter()
                .map(|file| (file.clone(), json!({ "type": "add", "content": "x" })))
                .collect();
            let bytes = lines(&[
                json!({ "type": "session_meta", "payload": { "id": "codex-1", "timestamp": meta_time, "cwd": home } }),
                json!({ "type": "turn_context", "payload": { "model": "deepseek-v4" } }),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "写个贪吃蛇" } }),
                codex_change("completed", Value::Object(changes)),
            ])
            .into_inner();
            String::from_utf8(bytes).unwrap()
        };
        write(
            &home.join(".codex/sessions/2026/10/01/rollout-1.jsonl"),
            &rollout(
                "2026-10-01T10:00:00Z",
                &[at("game/index.html"), at("game/js/app.js"), at("notes.md")],
            ),
        );
        write(
            &home.join(".codex/sessions/2100/01/01/rollout-2.jsonl"),
            &rollout("2100-01-01T00:00:00Z", &[at("repo/src/new.py")]),
        );
        write(
            &home.join(".codex/session_index.jsonl"),
            &json!({ "id": "codex-1", "thread_name": "贪吃蛇小游戏" }).to_string(),
        );

        // Claude Code, a session the desktop Code tab lists, and a Cowork session.
        let transcript = |id: &str, file: String| {
            let bytes = lines(&[
                json!({ "type": "user", "sessionId": id, "cwd": home, "timestamp": "2026-10-01T10:00:00Z", "message": { "content": "做网页" } }),
                json!({ "type": "assistant", "sessionId": id, "message": { "model": "claude-opus-5-5", "content": [
                    { "type": "tool_use", "id": "w", "name": "Write", "input": { "file_path": file, "content": "x" } }] } }),
                json!({ "type": "user", "sessionId": id, "message": { "content": [{ "type": "tool_result", "tool_use_id": "w" }] } }),
            ])
            .into_inner();
            String::from_utf8(bytes).unwrap()
        };
        write(&home.join("site/index.html"), "<p>site</p>");
        write(&home.join("tab/page.html"), "<p>tab</p>");
        write(
            &home.join(".claude/projects/-home/s-cli.jsonl"),
            &transcript("s-cli", at("site/index.html")),
        );
        write(
            &home.join(".claude/projects/-home/s-tab.jsonl"),
            &transcript("s-tab", at("tab/page.html")),
        );
        write(
            &app.join("claude-code-sessions/acct/org/local_1.json"),
            &json!({ "cliSessionId": "s-tab", "title": "桌面端网页" }).to_string(),
        );
        let storage = cowork.join("org/acct/agent/local_2");
        write(
            &cowork.join("org/acct/agent/local_2.json"),
            &json!({ "cliSessionId": "s-cowork", "title": "Cowork 周报" }).to_string(),
        );
        write(
            &storage.join(".claude/projects/-sessions-owl/s-cowork.jsonl"),
            &transcript("s-cowork", "/sessions/owl/mnt/outputs/周报.md".into()),
        );
        write(&storage.join("outputs/周报.md"), "周报");

        // WorkBuddy: task folders only, named by their session when it is still there.
        let task = home.join("WorkBuddy/2026-10-28-21-36-00");
        write(&task.join("app.py"), "import streamlit");
        write(&home.join("WorkBuddy/2026-10-29-08-00-00/empty.txt"), "");
        write(&home.join("WorkBuddy/Claw/notes.md"), "not a task folder");
        write(
            &home.join(".workbuddy/projects/p/wb-1.jsonl"),
            &[
                json!({ "type": "message", "role": "user", "sessionId": "wb-1", "cwd": task, "timestamp": 1_790_000_000_000_i64,
                    "_meta": { "baggage": "buddyId=1,buddyName=%E6%95%B0%E6%8D%AE%E5%B8%88" },
                    "content": [{ "type": "input_text", "text": "<user_query>做销售看板</user_query>" }] }),
                json!({ "type": "ai-title", "aiTitle": "销售看板" }),
            ]
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
        );

        let roots = Roots {
            home: home.clone(),
            codex: home.join(".codex"),
            claude: home.join(".claude"),
            claude_app: Some(app),
            cowork: Some(cowork),
            workbuddy: home.join(".workbuddy"),
            workbuddy_tasks: home.join("WorkBuddy"),
        };
        let mut cache = Cache::default();
        let (statuses, projects) = cache.refresh(&roots);
        let mut found: Vec<_> = projects
            .iter()
            .map(|project| {
                (
                    project.source,
                    project.location.as_str(),
                    project.name.as_str(),
                    project.employee_name.as_str(),
                )
            })
            .collect();
        found.sort();
        assert_eq!(
            found,
            [
                (AgentSource::Codex, "~/game", "贪吃蛇小游戏", "Codex"),
                (AgentSource::Claude, "~/site", "做网页", "Claude Code"),
                (AgentSource::ClaudeDesktop, "~/Library/Application Support/Claude/local-agent-mode-sessions/org/acct/agent/local_2/outputs", "Cowork 周报", "Claude"),
                (AgentSource::ClaudeDesktop, "~/tab", "桌面端网页", "Claude"),
                (AgentSource::Workbuddy, "~/WorkBuddy/2026-10-28-21-36-00", "销售看板", "数据师"),
            ]
        );
        let game = projects
            .iter()
            .find(|project| project.location == "~/game")
            .unwrap();
        assert_eq!(game.description.as_deref(), Some("浏览器贪吃蛇。"));
        assert_eq!(game.models, ["deepseek-v4"]);
        assert_eq!(game.file_count, 3);
        let count = |source| {
            statuses
                .iter()
                .find(|status| status.source == source)
                .unwrap()
                .project_count
        };
        assert_eq!(count(AgentSource::ClaudeDesktop), 2);
        assert!(statuses
            .iter()
            .all(|status| status.available && !status.creation_time_unavailable));

        // Files are read and addressed by opaque ids only.
        let readme = game
            .files
            .iter()
            .find(|file| file.path == "README.md")
            .unwrap();
        let root = cache.index[&(AgentSource::Codex, game.id.clone())].clone();
        assert_eq!(root, home.join("game"));
        let content = read_project_file_at(&root, &readme.id).unwrap();
        assert_eq!(
            content.content.as_deref(),
            Some("# Snake\n\n浏览器贪吃蛇。")
        );
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn project_files_are_previewed_by_format_and_size() {
        let root = temp_root("read");
        write(&root.join("notes.md"), "# 标题");
        write(&root.join("Makefile"), "run:\n\tpython app.py\n");
        std::fs::write(root.join("data.bin"), [0_u8, 159, 146, 150]).unwrap();
        std::fs::write(root.join("logo.png"), [137_u8, 80, 78, 71]).unwrap();
        write(
            &root.join("big.md"),
            &"x".repeat(MAX_PREVIEW_BYTES as usize + 1),
        );
        let read = |path: &str| read_project_file_at(&root, &file_id(path));

        let notes = read("notes.md").unwrap();
        assert_eq!(
            (notes.format, notes.content.as_deref()),
            (FileFormat::Markdown, Some("# 标题"))
        );
        let makefile = read("Makefile").unwrap();
        assert_eq!(makefile.format, FileFormat::Text);
        assert!(makefile
            .content
            .is_some_and(|text| text.contains("python app.py")));
        let binary = read("data.bin").unwrap();
        assert_eq!((binary.format, binary.content), (FileFormat::Other, None));
        assert_eq!(read("logo.png").unwrap().content, None);
        assert_eq!(read("big.md").unwrap_err(), "file_too_large");
        assert_eq!(read("missing.md").unwrap_err(), "file_not_found");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn fred_workspaces_are_addressed_by_validated_keys_only() {
        let root = temp_root("fred");
        let key = format!("conversation-{}", "a1".repeat(12));
        let empty = format!("conversation-{}", "b2".repeat(12));
        write(&root.join(&key).join("index.html"), "<p>fred</p>");
        write(
            &root.join(&key).join("package.json"),
            r#"{"name":"fred-game"}"#,
        );
        std::fs::create_dir_all(root.join(&empty)).unwrap();
        let outside = temp_root("fred-outside");
        write(&outside.join("secret.html"), "x");
        let linked = format!("conversation-{}", "c3".repeat(12));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join(&linked)).unwrap();

        let keys = [
            key.clone(),
            key.clone(),
            empty.clone(),
            linked.clone(),
            format!("conversation-{}", "d4".repeat(12)),
        ];
        let workspaces = list_fred_workspaces(&root, &keys).unwrap();
        let listed: Vec<_> = workspaces
            .iter()
            .map(|workspace| (workspace.workspace_key.as_str(), workspace.file_count))
            .collect();
        assert_eq!(listed, [(key.as_str(), 2), (empty.as_str(), 0)]);
        assert_eq!(workspaces[0].name.as_deref(), Some("fred-game"));

        for bad in [
            "../x",
            "conversation-ABCDEF",
            "conversation-a1a1",
            &format!("conversation-{}/..", "a1".repeat(12)),
        ] {
            assert_eq!(
                fred_workspace(&root, bad).unwrap_err(),
                "invalid_workspace_key"
            );
        }
        assert_eq!(fred_workspace(&root, &linked).unwrap(), None);
        assert_eq!(
            parse_target("fred", &key, Some("0123456789abcdef")).unwrap(),
            AgentSource::Fred
        );
        assert_eq!(
            parse_target("fred", "0123456789abcdef", None).unwrap_err(),
            "invalid_project_id"
        );
        assert_eq!(
            parse_target("codex", &key, None).unwrap_err(),
            "invalid_project_id"
        );
        assert_eq!(
            parse_target("codex", "0123456789abcdef", Some("../a")).unwrap_err(),
            "invalid_file_id"
        );
        assert_eq!(
            parse_target("trae", "0123456789abcdef", None).unwrap_err(),
            "invalid_source"
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn sources_round_trip_through_their_ids() {
        for source in [AgentSource::Fred].into_iter().chain(AgentSource::SCANNED) {
            let id = serde_json::to_value(source).unwrap();
            assert_eq!(AgentSource::parse(id.as_str().unwrap()), Some(source));
        }
    }

    #[test]
    fn parses_rfc3339_timestamps() {
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_millis("2026-10-01T10:00:00.5+02:00"),
            Some(1_790_841_600_500)
        );
        assert_eq!(parse_rfc3339_millis("2026-13-01T10:00:00Z"), None);
    }
}
