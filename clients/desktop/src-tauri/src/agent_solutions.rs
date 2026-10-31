//! Workbench: solution documents written by local agent sessions — Codex, Claude Code, the Claude
//! desktop app, Qoder CLI, TRAE CLI and WorkBuddy.
//! Only sessions that produced a document (Markdown, text, HTML, CSV, SVG, Office or PDF) are
//! listed, and only each document's final version is returned — never the conversation, code
//! changes or tool output. Roots are fixed under the user's home; the WebView addresses a
//! document by source, session id and an opaque file id, never by path.
use serde::Serialize;
use serde_json::Value;
use std::cmp::Reverse;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SESSIONS_PER_SOURCE: usize = 300;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
// Codex event types sit near the start of each line; scanning a bounded prefix keeps
// hundreds of MB of tool output from being JSON-parsed.
const LINE_PREFIX_SCAN_BYTES: usize = 512;
const MAX_TITLE_CHARS: usize = 80;
const MAX_TASK_CHARS: usize = 600;
const MAX_FILES_PER_SESSION: usize = 100;
/// Larger documents are neither rebuilt from records nor returned for preview.
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ID_LEN: usize = 128;
const WORKSPACE_SCAN_DEPTH: usize = 2;
const MAX_WORKSPACE_ENTRIES: usize = 2_000;
/// Claude desktop session records also hold system prompts and tool settings.
const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;

/// Claude Code's file tools; Qoder CLI and Claude desktop sessions record the same ones.
const CLAUDE_FILE_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit"];

const CODEX_MARKERS: &[&str] = &[
    "\"session_meta\"",
    "\"turn_context\"",
    "\"UserMessage\"",
    "\"user_message\"",
    "\"FileChange\"",
];

/// TRAE CLI may record edits only as `apply_patch` calls and their outputs.
const TRAE_MARKERS: &[&str] = &["apply_patch", "\"history_mutation\"", "_call_output\""];

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

/// Housekeeping documents that live with code rather than being delivered as solutions.
const EXCLUDED_STEMS: &[&str] = &[
    "readme",
    "agents",
    "claude",
    "gemini",
    "changelog",
    "license",
    "contributing",
    "code_of_conduct",
    "security",
    "skill",
];

/// Name parts that suggest credentials, matching the Agent's artifact capture rules.
const SENSITIVE_NAME_PARTS: &[&str] = &[
    "env",
    "secret",
    "secrets",
    "credential",
    "credentials",
    "password",
    "passwd",
    "token",
    "private",
    "apikey",
    "accesskey",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSource {
    Codex,
    /// Claude Code CLI.
    Claude,
    /// Claude desktop app: Cowork sessions and the Code tab's Claude Code sessions.
    ClaudeDesktop,
    /// Qoder CLI.
    Qoder,
    /// TRAE CLI 2.0 (`traex`), a codex-rs fork that writes Codex rollouts.
    Trae,
    Workbuddy,
}

impl AgentSource {
    const ALL: [AgentSource; 6] = [
        AgentSource::Codex,
        AgentSource::Claude,
        AgentSource::ClaudeDesktop,
        AgentSource::Qoder,
        AgentSource::Trae,
        AgentSource::Workbuddy,
    ];

    fn parse(value: &str) -> Option<Self> {
        match value {
            "codex" => Some(Self::Codex),
            "claude" => Some(Self::Claude),
            "claude_desktop" => Some(Self::ClaudeDesktop),
            "qoder" => Some(Self::Qoder),
            "trae" => Some(Self::Trae),
            "workbuddy" => Some(Self::Workbuddy),
            _ => None,
        }
    }

    fn default_employee(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
            Self::ClaudeDesktop => "Claude",
            Self::Qoder => "Qoder",
            Self::Trae => "TRAE",
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
    /// Office documents and PDF: opened with the system app, never previewed inline.
    Document,
}

impl FileFormat {
    fn of(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        Some(match extension.as_str() {
            "md" | "markdown" => Self::Markdown,
            "txt" => Self::Text,
            "html" | "htm" => Self::Html,
            "csv" => Self::Csv,
            "svg" => Self::Svg,
            "docx" | "doc" | "pptx" | "ppt" | "xlsx" | "xls" | "pdf" => Self::Document,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Created,
    Updated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentOrigin {
    /// The file as it is on disk now.
    Disk,
    /// Rebuilt from the session record because the file no longer exists.
    Record,
}

#[derive(Clone, Debug, Serialize)]
pub struct SolutionFile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub format: FileFormat,
    pub kind: ChangeKind,
    pub exists: bool,
    pub changed_at: Option<i64>,
    /// The request of the turn that last changed the file.
    pub task: Option<String>,
    /// The model that last changed the file.
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SolutionSummary {
    pub source: AgentSource,
    pub id: String,
    pub title: String,
    pub employee_name: String,
    pub workspace: Option<String>,
    /// The model the session used last.
    pub model: Option<String>,
    /// Models that wrote the listed documents, falling back to `model`.
    pub models: Vec<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    /// Most recently changed first.
    pub files: Vec<SolutionFile>,
}

#[derive(Debug, Serialize)]
pub struct SolutionFileContent {
    pub name: String,
    pub path: String,
    pub format: FileFormat,
    pub origin: ContentOrigin,
    /// `None` for Office/PDF documents.
    pub content: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SourceStatus {
    pub source: AgentSource,
    pub available: bool,
    pub solution_count: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct SolutionList {
    pub sources: Vec<SourceStatus>,
    pub solutions: Vec<SolutionSummary>,
}

/// What a session did to one document, replayed in record order.
#[derive(Debug)]
struct RecordedFile {
    path: String,
    format: FileFormat,
    kind: ChangeKind,
    deleted: bool,
    /// Final text rebuilt from the record; `None` when a change could not be replayed,
    /// e.g. an edit to a file whose earlier content the session never saw.
    content: Option<String>,
    /// Whether `content` was rebuilt; kept after the cache drops the text itself.
    recorded: bool,
    changed_at: Option<i64>,
    task: Option<String>,
    model: Option<String>,
}

/// When a document changed, the request being worked on and the model that made the change.
#[derive(Clone, Copy, Default)]
struct Change<'a> {
    at: Option<i64>,
    task: Option<&'a str>,
    model: Option<&'a str>,
}

#[derive(Default)]
struct FileTracker {
    files: Vec<RecordedFile>,
    by_path: HashMap<String, usize>,
}

impl FileTracker {
    fn entry(&mut self, path: &str, kind: ChangeKind, change: Change) -> Option<&mut RecordedFile> {
        let index = match self.by_path.get(path) {
            Some(&index) => index,
            None => {
                let format = solution_format(path)?;
                if self.files.len() >= MAX_FILES_PER_SESSION {
                    return None;
                }
                self.by_path.insert(path.to_string(), self.files.len());
                self.files.push(RecordedFile {
                    path: path.to_string(),
                    format,
                    kind,
                    deleted: false,
                    content: None,
                    recorded: false,
                    changed_at: None,
                    task: None,
                    model: None,
                });
                self.files.len() - 1
            }
        };
        let file = &mut self.files[index];
        file.changed_at = change.at.or(file.changed_at);
        if let Some(task) = change.task.map(str::trim).filter(|task| !task.is_empty()) {
            file.task = Some(truncate_chars(task, MAX_TASK_CHARS));
        }
        if let Some(model) = change.model {
            file.model = Some(model.to_string());
        }
        Some(file)
    }

    fn write(&mut self, path: &str, content: Option<&str>, kind: ChangeKind, change: Change) {
        if let Some(file) = self.entry(path, kind, change) {
            file.deleted = false;
            file.content = content
                .filter(|text| text.len() <= MAX_DOCUMENT_BYTES)
                .map(str::to_string);
        }
    }

    /// Applies an edit to the replayed content, or to `original` — the file's content before the
    /// edit — when the record carries it.
    fn edit(
        &mut self,
        path: &str,
        original: Option<&str>,
        change: Change,
        apply: impl FnOnce(String) -> Option<String>,
    ) {
        if let Some(file) = self.entry(path, ChangeKind::Updated, change) {
            file.deleted = false;
            let base = match original {
                Some(text) => Some(text.to_string()),
                None => file.content.take(),
            };
            file.content = base
                .and_then(apply)
                .filter(|text| text.len() <= MAX_DOCUMENT_BYTES);
        }
    }

    fn delete(&mut self, path: &str, at: Option<i64>) {
        let change = Change {
            at,
            ..Change::default()
        };
        if let Some(file) = self.entry(path, ChangeKind::Updated, change) {
            file.deleted = true;
            file.content = None;
        }
    }

    /// A rename carries the replayed content and the created/updated kind to the new path.
    fn rename(&mut self, from: &str, to: &str, change: Change) {
        let (kind, content) = match self.by_path.get(from) {
            Some(&index) => {
                let file = &mut self.files[index];
                file.deleted = true;
                (file.kind, file.content.take())
            }
            None => (ChangeKind::Updated, None),
        };
        if let Some(file) = self.entry(to, kind, change) {
            file.deleted = false;
            file.content = content;
        }
    }

    /// A document found in the task folder that no recorded tool call wrote.
    fn discover(&mut self, path: &str, change: Change) {
        if !self.by_path.contains_key(path) {
            self.entry(path, ChangeKind::Created, change);
        }
    }

    fn finish(mut self) -> Vec<RecordedFile> {
        for file in &mut self.files {
            file.recorded = file.content.is_some();
        }
        self.files
    }
}

/// One session file's content, before display overrides such as Codex thread names.
#[derive(Debug, Default)]
struct ParsedSession {
    id: String,
    title: Option<String>,
    employee_name: Option<String>,
    workspace: Option<String>,
    model: Option<String>,
    created_at: Option<i64>,
    files: Vec<RecordedFile>,
}

struct CacheEntry {
    modified: Option<SystemTime>,
    len: u64,
    /// Parsed without document text; `None` when the session wrote no documents.
    session: Option<ParsedSession>,
}

#[derive(Default)]
struct Cache {
    files: HashMap<PathBuf, CacheEntry>,
    index: HashMap<(AgentSource, String), PathBuf>,
    /// Names the apps gave sessions, by session id: Codex / TRAE thread names and Claude
    /// desktop Code tab titles.
    titles: HashMap<String, String>,
}

#[derive(Clone, Default)]
pub struct AgentSolutionsState(Arc<Mutex<Cache>>);

struct Roots {
    home: PathBuf,
    codex: PathBuf,
    /// TRAE CLI's home, laid out like Codex's.
    trae: PathBuf,
    claude: PathBuf,
    /// Claude desktop app data folder.
    claude_app: Option<PathBuf>,
    /// Claude desktop Cowork sessions.
    cowork: Option<PathBuf>,
    /// Qoder CLI homes: global and the China build.
    qoder: Vec<PathBuf>,
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
            trae: env_dir("TRAECLI_HOME").unwrap_or_else(|| {
                env_dir("TRAE_HOME")
                    .unwrap_or_else(|| home.join(".trae"))
                    .join("cli")
            }),
            claude: env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude")),
            cowork: env_dir("COWORK_SESSIONS_DIR").or_else(|| {
                claude_app
                    .as_ref()
                    .map(|dir| dir.join("local-agent-mode-sessions"))
            }),
            claude_app,
            qoder: vec![
                env_dir("QODER_CONFIG_DIR").unwrap_or_else(|| home.join(".qoder")),
                home.join(".qoder-cn"),
            ],
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
            AgentSource::Trae => vec![
                (self.trae.join("sessions"), 3),
                (self.trae.join("archived_sessions"), 3),
            ],
            // projects/<encoded-workspace>/<session-id>.jsonl; subagents sit one level deeper.
            AgentSource::Claude => vec![(self.claude.join("projects"), 1)],
            AgentSource::Qoder => self
                .qoder
                .iter()
                .map(|home| (home.join("projects"), 1))
                .collect(),
            AgentSource::Workbuddy => vec![(self.workbuddy.join("projects"), 1)],
            // Cowork transcripts are found by `collect_cowork`; the Code tab's live with Claude Code's.
            AgentSource::ClaudeDesktop => Vec::new(),
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
        AgentSource::Codex | AgentSource::Trae => {
            name.starts_with("rollout-") && name.ends_with(".jsonl")
        }
        _ => name.ends_with(".jsonl"),
    }
}

/// Subdirectories of `dir`; symlinks are not followed.
fn subdirectories(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.metadata().is_ok_and(|meta| meta.is_dir()))
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

/// A small JSON record such as a Claude desktop session listing.
fn read_json_record(path: &Path) -> Option<Value> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_RECORD_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
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
                    let Some(record) = read_json_record(&path) else {
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

/// Claude Code saves plan mode's plans as `~/.claude/plans/<name>.md`.
fn is_claude_plan(path: &Path) -> bool {
    let dir = path.parent();
    dir.and_then(Path::file_name) == Some("plans".as_ref())
        && dir.and_then(Path::parent).and_then(Path::file_name) == Some(".claude".as_ref())
}

/// Absolute, non-hidden document paths (and Claude Code plans) outside dependency folders and
/// housekeeping files.
fn solution_format(path: &str) -> Option<FileFormat> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return None;
    }
    let plan = is_claude_plan(path);
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_str()?;
                if (part.starts_with('.') && !(plan && part == ".claude")) || part == "node_modules"
                {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => {}
            // `.` and `..` would make the recorded path ambiguous.
            Component::CurDir | Component::ParentDir => return None,
        }
    }
    let stem = path.file_stem()?.to_str()?.to_ascii_lowercase();
    if EXCLUDED_STEMS.contains(&stem.as_str()) || is_sensitive_stem(&stem) {
        return None;
    }
    FileFormat::of(path)
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

/// Opaque, stable id for a document path (64-bit FNV-1a), so the WebView never sends paths.
fn file_id(path: &str) -> String {
    let hash = path.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}

fn valid_file_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

fn is_regular_file(path: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
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

fn display_path(path: &str, home: &Path) -> String {
    match Path::new(path).strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.to_string(),
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

/// `@@ -old_start[,old_count] +new_start[,new_count] @@` → (old_start, old_count, new_count).
fn parse_hunk_header(line: &str) -> Option<(usize, usize, usize)> {
    let (ranges, _) = line.strip_prefix("@@ -")?.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |text: &str| -> Option<(usize, usize)> {
        match text.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    };
    let (old_start, old_count) = range(old)?;
    let (_, new_count) = range(new)?;
    Some((old_start, old_count, new_count))
}

/// Applies the hunks of a unified diff as Codex records them. Each hunk is matched at its
/// recorded line first, then by searching forward; any mismatch fails the whole diff.
fn apply_unified_diff(original: &str, diff: &str) -> Option<String> {
    let source: Vec<&str> = original.lines().collect();
    let mut output: Vec<&str> = Vec::with_capacity(source.len());
    let mut cursor = 0;
    let mut lines = diff.lines();
    while let Some(line) = lines.next() {
        // File headers and anything else outside a hunk carry no content.
        let Some((old_start, old_count, new_count)) = parse_hunk_header(line) else {
            continue;
        };
        let (mut old_block, mut new_block) = (Vec::new(), Vec::new());
        while old_block.len() < old_count || new_block.len() < new_count {
            let body = lines.next()?;
            match body.as_bytes().first() {
                Some(b'+') => new_block.push(&body[1..]),
                Some(b'-') => old_block.push(&body[1..]),
                Some(b' ') => {
                    old_block.push(&body[1..]);
                    new_block.push(&body[1..]);
                }
                // Some writers drop the space of an empty context line.
                None => {
                    old_block.push("");
                    new_block.push("");
                }
                Some(b'\\') => {}
                _ => return None,
            }
        }
        if old_block.len() != old_count || new_block.len() != new_count {
            return None;
        }
        // A pure insertion (`-n,0`) goes after line n; otherwise the hunk starts at line n.
        let expected = if old_count == 0 {
            old_start
        } else {
            old_start.saturating_sub(1)
        };
        let fits = |at: usize| {
            at >= cursor
                && at + old_block.len() <= source.len()
                && source[at..at + old_block.len()] == old_block[..]
        };
        let position = if fits(expected) {
            expected
        } else {
            (cursor..=source.len().saturating_sub(old_block.len())).find(|&at| fits(at))?
        };
        output.extend_from_slice(&source[cursor..position]);
        output.extend(new_block);
        cursor = position + old_block.len();
    }
    output.extend_from_slice(&source[cursor..]);
    let mut text = output.join("\n");
    if !text.is_empty() && (original.is_empty() || original.ends_with('\n')) {
        text.push('\n');
    }
    Some(text)
}

fn is_codex_subagent(meta: &Value) -> bool {
    meta["thread_source"].as_str() == Some("subagent") || meta["source"].get("subagent").is_some()
}

fn apply_codex_changes(
    tracker: &mut FileTracker,
    changes: &Value,
    cwd: Option<&str>,
    change: Change,
) {
    let Some(changes) = changes.as_object() else {
        return;
    };
    for (path, file_change) in changes {
        let Some(path) = absolute_path(path, cwd) else {
            continue;
        };
        match file_change["type"].as_str() {
            Some("add") => tracker.write(
                &path,
                file_change["content"].as_str(),
                ChangeKind::Created,
                change,
            ),
            Some("delete") => tracker.delete(&path, change.at),
            Some("update") => {
                let diff = file_change["unified_diff"].as_str().unwrap_or_default();
                tracker.edit(&path, None, change, |text| apply_unified_diff(&text, diff));
                if let Some(target) = file_change["move_path"]
                    .as_str()
                    .and_then(|target| absolute_path(target, cwd))
                    .filter(|target| *target != path)
                {
                    tracker.rename(&path, &target, change);
                }
            }
            _ => {}
        }
    }
}

/// One chunk of an `apply_patch` update: an optional `@@ <line>` anchor, the lines it replaces
/// and their replacement.
#[derive(Default)]
struct PatchChunk<'a> {
    anchor: Option<&'a str>,
    old: Vec<&'a str>,
    new: Vec<&'a str>,
    /// `*** End of File`: the chunk is expected at the end of the file.
    at_end: bool,
}

enum PatchOp<'a> {
    Add(&'a str, String),
    Delete(&'a str),
    Update {
        path: &'a str,
        move_to: Option<&'a str>,
        chunks: Vec<PatchChunk<'a>>,
    },
}

/// Parses Codex's `*** Begin Patch` … `*** End Patch` format; `None` when it is malformed.
fn parse_codex_patch(patch: &str) -> Option<Vec<PatchOp<'_>>> {
    let mut lines = patch
        .lines()
        .skip_while(|line| line.trim() != "*** Begin Patch")
        .skip(1)
        .peekable();
    let mut ops = Vec::new();
    while let Some(line) = lines.next() {
        if line.trim() == "*** End Patch" {
            return Some(ops);
        }
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            let mut content = String::new();
            while let Some(next) = lines.next_if(|next| next.starts_with('+')) {
                content.push_str(&next[1..]);
                content.push('\n');
            }
            ops.push(PatchOp::Add(path.trim(), content));
        } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
            ops.push(PatchOp::Delete(path.trim()));
        } else if let Some(path) = line.strip_prefix("*** Update File: ") {
            let move_to = lines
                .next_if(|next| next.starts_with("*** Move to: "))
                .map(|next| next["*** Move to: ".len()..].trim());
            let mut chunks: Vec<PatchChunk> = Vec::new();
            while let Some(next) =
                lines.next_if(|next| !next.starts_with("*** ") || next.trim() == "*** End of File")
            {
                if next.trim() == "*** End of File" {
                    if let Some(chunk) = chunks.last_mut() {
                        chunk.at_end = true;
                    }
                    continue;
                }
                if let Some(anchor) = next.strip_prefix("@@") {
                    let anchor = anchor.trim();
                    chunks.push(PatchChunk {
                        anchor: (!anchor.is_empty()).then_some(anchor),
                        ..PatchChunk::default()
                    });
                    continue;
                }
                // The first chunk may omit its `@@` line.
                if chunks.is_empty() {
                    chunks.push(PatchChunk::default());
                }
                let chunk = chunks.last_mut()?;
                match next.as_bytes().first() {
                    Some(b'+') => chunk.new.push(&next[1..]),
                    Some(b'-') => chunk.old.push(&next[1..]),
                    Some(b' ') => {
                        chunk.old.push(&next[1..]);
                        chunk.new.push(&next[1..]);
                    }
                    None => {
                        chunk.old.push("");
                        chunk.new.push("");
                    }
                    _ => return None,
                }
            }
            ops.push(PatchOp::Update {
                path: path.trim(),
                move_to,
                chunks,
            });
        } else if !line.trim().is_empty() {
            return None;
        }
    }
    None
}

fn same_line(line: &str) -> &str {
    line
}

/// Finds `pattern` at or after `start` comparing lines exactly, then without trailing and then
/// without surrounding whitespace, as `apply_patch` does. End-of-file chunks try the end first.
fn seek_lines(lines: &[&str], pattern: &[&str], start: usize, at_end: bool) -> Option<usize> {
    let last = lines.len().checked_sub(pattern.len())?;
    let normalizers: [fn(&str) -> &str; 3] = [same_line, str::trim_end, str::trim];
    for normalize in normalizers {
        let fits = |at: usize| {
            lines[at..at + pattern.len()]
                .iter()
                .zip(pattern)
                .all(|(line, expected)| normalize(line) == normalize(expected))
        };
        if at_end && last >= start && fits(last) {
            return Some(last);
        }
        if let Some(at) = (start..=last).find(|&at| fits(at)) {
            return Some(at);
        }
    }
    None
}

/// Applies `apply_patch` update chunks; a chunk that cannot be located fails the whole update.
fn apply_patch_chunks(original: &str, chunks: &[PatchChunk]) -> Option<String> {
    let source: Vec<&str> = original.lines().collect();
    let mut replacements: Vec<(usize, usize, &[&str])> = Vec::new();
    let mut cursor = 0;
    for chunk in chunks {
        if let Some(anchor) = chunk.anchor {
            cursor = seek_lines(&source, &[anchor], cursor, false)? + 1;
        }
        if chunk.old.is_empty() {
            // A pure addition goes at the end of the file.
            replacements.push((source.len(), 0, &chunk.new[..]));
            continue;
        }
        let (mut old, mut new) = (&chunk.old[..], &chunk.new[..]);
        let mut found = seek_lines(&source, old, cursor, chunk.at_end);
        // A trailing empty line can be an artifact of the patch's final newline.
        if found.is_none() && old.last() == Some(&"") {
            old = &old[..old.len() - 1];
            if new.last() == Some(&"") {
                new = &new[..new.len() - 1];
            }
            found = seek_lines(&source, old, cursor, chunk.at_end);
        }
        let at = found?;
        replacements.push((at, old.len(), new));
        cursor = at + old.len();
    }
    replacements.sort_by_key(|(at, _, _)| *at);
    let mut output: Vec<&str> = Vec::with_capacity(source.len());
    let mut cursor = 0;
    for (at, len, new) in replacements {
        if at < cursor {
            return None;
        }
        output.extend_from_slice(&source[cursor..at]);
        output.extend_from_slice(new);
        cursor = at + len;
    }
    output.extend_from_slice(&source[cursor..]);
    let mut text = output.join("\n");
    text.push('\n');
    Some(text)
}

/// Replays the file operations of an `apply_patch` call.
fn apply_codex_patch(tracker: &mut FileTracker, patch: &str, cwd: Option<&str>, change: Change) {
    for op in parse_codex_patch(patch).unwrap_or_default() {
        match op {
            PatchOp::Add(path, content) => {
                if let Some(path) = absolute_path(path, cwd) {
                    tracker.write(&path, Some(&content), ChangeKind::Created, change);
                }
            }
            PatchOp::Delete(path) => {
                if let Some(path) = absolute_path(path, cwd) {
                    tracker.delete(&path, change.at);
                }
            }
            PatchOp::Update {
                path,
                move_to,
                chunks,
            } => {
                let Some(path) = absolute_path(path, cwd) else {
                    continue;
                };
                tracker.edit(&path, None, change, |text| {
                    apply_patch_chunks(&text, &chunks)
                });
                if let Some(target) = move_to
                    .and_then(|target| absolute_path(target, cwd))
                    .filter(|target| *target != path)
                {
                    tracker.rename(&path, &target, change);
                }
            }
        }
    }
}

/// The patch of an `apply_patch` call: a custom tool's input, a function's `input` / `patch`
/// argument, or an exec argv starting with `apply_patch`.
fn apply_patch_text(item: &Value) -> Option<String> {
    let name = item["name"].as_str()?;
    match item["type"].as_str()? {
        "custom_tool_call" if name == "apply_patch" => item["input"].as_str().map(str::to_string),
        "function_call" => {
            let parsed;
            let arguments = match &item["arguments"] {
                Value::String(text) => {
                    parsed = serde_json::from_str::<Value>(text).ok()?;
                    &parsed
                }
                other => other,
            };
            if name == "apply_patch" {
                return str_field(arguments, "input").or_else(|| str_field(arguments, "patch"));
            }
            let argv = arguments["command"].as_array()?;
            (argv.first()?.as_str()? == "apply_patch")
                .then(|| argv.get(1)?.as_str().map(str::to_string))
                .flatten()
        }
        _ => None,
    }
}

/// Whether a tool output reports success: the exec exit code when recorded, otherwise a first
/// line that does not report a failure.
fn tool_output_succeeded(output: &Value) -> bool {
    let text = match output {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => match output["success"].as_bool() {
            Some(success) => return success,
            None => output["content"].as_str().unwrap_or_default().to_string(),
        },
        _ => return false,
    };
    if let Some(code) = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|parsed| parsed["metadata"]["exit_code"].as_i64())
    {
        return code == 0;
    }
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .to_ascii_lowercase();
    // Exec-style output: `Exit code: 0\nWall time: …\nOutput:\n…`.
    if let Some(code) = first.strip_prefix("exit code:") {
        return code.trim() == "0";
    }
    !(first.starts_with("error") || first.contains("failed") || first.contains("rejected"))
}

/// An `apply_patch` call, replayed once its output shows it succeeded.
struct PatchCall {
    patch: String,
    at: Option<i64>,
    task: Option<String>,
    model: Option<String>,
}

#[derive(Default)]
struct PatchCalls {
    pending: HashMap<String, PatchCall>,
    settled: HashSet<String>,
    succeeded: Vec<PatchCall>,
}

impl PatchCalls {
    /// Tracks a response item: an `apply_patch` call or the output that settles one. A call
    /// recorded twice (as a response item and in TRAE's history) is read once, by call id.
    fn record(&mut self, item: &Value, change: Change) {
        let Some(call_id) = str_field(item, "call_id") else {
            return;
        };
        if self.settled.contains(&call_id) {
            return;
        }
        match item["type"].as_str() {
            Some("custom_tool_call_output" | "function_call_output") => {
                if let Some(call) = self.pending.remove(&call_id) {
                    if tool_output_succeeded(&item["output"]) {
                        self.succeeded.push(call);
                    }
                    self.settled.insert(call_id);
                }
            }
            _ => {
                if let Some(patch) = apply_patch_text(item) {
                    self.pending.entry(call_id).or_insert_with(|| PatchCall {
                        patch,
                        at: change.at,
                        task: change.task.map(str::to_string),
                        model: change.model.map(str::to_string),
                    });
                }
            }
        }
    }
}

/// Codex rollout, which TRAE CLI also writes: documents come from completed FileChange items
/// (`add` carries the whole text, `update` a unified diff); a document's task is the prompt of
/// the turn that changed it. With `patch_calls` (TRAE), a rollout without FileChange items falls
/// back to replaying its successful `apply_patch` calls. Subagent threads belong to their parent
/// and are skipped.
fn parse_codex<R: BufRead>(reader: R, patch_calls: bool) -> Option<ParsedSession> {
    let mut session = ParsedSession::default();
    let mut tracker = FileTracker::default();
    // Prompts by turn_id; messages steered into a running turn share its id.
    let mut prompts: HashMap<String, Vec<String>> = HashMap::new();
    let mut last_turn = String::new();
    let mut first_prompt: Option<String> = None;
    let mut subagent = false;
    let mut calls = PatchCalls::default();
    let mut saw_file_change = false;

    for_each_line(reader, |line| {
        let head = line_head(line);
        let wanted = |markers: &[&str]| markers.iter().any(|marker| head.contains(marker));
        if !(wanted(CODEX_MARKERS) || patch_calls && wanted(TRAE_MARKERS)) {
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
                    session.workspace = str_field(payload, "cwd");
                }
            }
            Some("turn_context") => {
                if let Some(model) = str_field(payload, "model") {
                    session.model = Some(model);
                }
            }
            Some("event_msg") => {
                let turn_id = payload["turn_id"].as_str().unwrap_or_default();
                let item = &payload["item"];
                let prompt = match (payload["type"].as_str(), item["type"].as_str()) {
                    (Some("item_completed"), Some("UserMessage")) => {
                        Some(join_text(&item["content"], "text"))
                    }
                    // Older rollouts record the prompt as a user_message event.
                    (Some("user_message"), _) => payload["message"].as_str().map(str::to_string),
                    (Some("item_completed"), Some("FileChange")) => {
                        saw_file_change = true;
                        if item["status"].as_str() == Some("completed") {
                            let task = prompts
                                .get(turn_id)
                                .or_else(|| prompts.get(&last_turn))
                                .map(|parts| parts.join("\n\n"));
                            apply_codex_changes(
                                &mut tracker,
                                &item["changes"],
                                session.workspace.as_deref(),
                                Change {
                                    at: value["timestamp"].as_str().and_then(parse_rfc3339_millis),
                                    task: task.as_deref(),
                                    model: session.model.as_deref(),
                                },
                            );
                        }
                        None
                    }
                    _ => None,
                };
                if let Some(text) = prompt
                    .map(|text| truncate_chars(text.trim(), MAX_TASK_CHARS))
                    .filter(|text| !text.is_empty())
                {
                    if first_prompt.is_none() {
                        first_prompt = Some(text.clone());
                    }
                    // TRAE CLI can record one prompt both as user_message and as a UserMessage item.
                    let slot = prompts.entry(turn_id.to_string()).or_default();
                    if !slot.contains(&text) {
                        slot.push(text);
                    }
                    last_turn = turn_id.to_string();
                }
            }
            Some("response_item") if patch_calls => {
                let task = prompts.get(&last_turn).map(|parts| parts.join("\n\n"));
                let change = Change {
                    at: value["timestamp"].as_str().and_then(parse_rfc3339_millis),
                    task: task.as_deref(),
                    model: session.model.as_deref(),
                };
                calls.record(payload, change);
            }
            // TRAE CLI's own history; a `replace` re-sends history the file already holds.
            Some("history_mutation")
                if patch_calls && payload["operation"].as_str() == Some("append") =>
            {
                let task = prompts.get(&last_turn).map(|parts| parts.join("\n\n"));
                let change = Change {
                    at: value["timestamp"].as_str().and_then(parse_rfc3339_millis),
                    task: task.as_deref(),
                    model: session.model.as_deref(),
                };
                let items = payload["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .chain(Some(&payload["item"]).filter(|item| item.is_object()));
                for item in items {
                    let item = match item["type"].as_str() {
                        Some("response_item") => &item["payload"],
                        _ => item,
                    };
                    calls.record(item, change);
                }
            }
            _ => {}
        }
        true
    });

    if subagent {
        return None;
    }
    if !saw_file_change {
        for call in calls.succeeded {
            let change = Change {
                at: call.at,
                task: call.task.as_deref(),
                model: call.model.as_deref(),
            };
            apply_codex_patch(
                &mut tracker,
                &call.patch,
                session.workspace.as_deref(),
                change,
            );
        }
    }
    session.title = first_prompt.as_deref().and_then(title_from_prompt);
    session.files = tracker.finish();
    Some(session)
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

fn replace_text(text: String, edit: &Value) -> Option<String> {
    let old = edit["old_string"]
        .as_str()
        .filter(|old| !old.is_empty() && text.contains(old))?;
    let new = edit["new_string"].as_str()?;
    Some(if edit["replace_all"].as_bool() == Some(true) {
        text.replace(old, new)
    } else {
        text.replacen(old, new, 1)
    })
}

/// jsdiff hunks as Claude Code records them (`structuredPatch`), as a unified diff.
fn structured_patch_diff(patch: &Value) -> Option<String> {
    let hunks = patch.as_array().filter(|hunks| !hunks.is_empty())?;
    let mut diff = String::new();
    for hunk in hunks {
        let number = |key: &str| hunk[key].as_u64();
        // jsdiff keeps 1-based starts; a unified header writes one less for an empty range.
        let range = |start: &str, count: &str| {
            let count = number(count)?;
            let start = number(start)?;
            Some(format!(
                "{},{count}",
                if count == 0 {
                    start.saturating_sub(1)
                } else {
                    start
                }
            ))
        };
        diff.push_str(&format!(
            "@@ -{} +{} @@\n",
            range("oldStart", "oldLines")?,
            range("newStart", "newLines")?
        ));
        for line in hunk["lines"].as_array()? {
            diff.push_str(line.as_str()?);
            diff.push('\n');
        }
    }
    Some(diff)
}

/// Replays a Claude Code style file tool (Write, Edit, MultiEdit). `result` is Claude Code's own
/// record of the call (`toolUseResult`): the file's content before the call and the exact patch,
/// which stay right even when the user changed the edit before accepting it.
fn apply_file_tool(
    tracker: &mut FileTracker,
    name: &str,
    arguments: &Value,
    cwd: Option<&str>,
    result: Option<&Value>,
    change: Change,
) {
    let Some(path) = arguments["file_path"]
        .as_str()
        .and_then(|path| absolute_path(path, cwd))
    else {
        return;
    };
    let original = result.and_then(|result| result["originalFile"].as_str());
    match name {
        "Write" => {
            let kind = match result.and_then(|result| result["type"].as_str()) {
                Some("update") => ChangeKind::Updated,
                _ => ChangeKind::Created,
            };
            let content = result
                .and_then(|result| result["content"].as_str())
                .or_else(|| arguments["content"].as_str());
            tracker.write(&path, content, kind, change);
        }
        "Edit" | "MultiEdit" => {
            let diff = result.and_then(|result| structured_patch_diff(&result["structuredPatch"]));
            let user_modified =
                result.is_some_and(|result| result["userModified"].as_bool() == Some(true));
            tracker.edit(&path, original, change, |text| {
                if let Some(updated) = diff
                    .as_deref()
                    .and_then(|diff| apply_unified_diff(&text, diff))
                {
                    return Some(updated);
                }
                // The user changed the edit, so its arguments are not what was written.
                if user_modified {
                    return None;
                }
                if name == "Edit" {
                    return replace_text(text, arguments);
                }
                arguments["edits"]
                    .as_array()?
                    .iter()
                    .try_fold(text, replace_text)
            });
        }
        _ => {}
    }
}

/// A file tool call waiting for its result.
struct PendingTool {
    name: String,
    input: Value,
    task: Option<String>,
    model: Option<String>,
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
        .then(|| truncate_chars(text, MAX_TASK_CHARS))
}

/// Claude Code transcript, which Qoder CLI and the Claude desktop app also write. File tools are
/// replayed once their result arrives without an error. `outputs` is a Cowork session's output
/// folder, whose documents belong to the session however they were saved.
fn parse_claude<R: BufRead>(reader: R, outputs: Option<&Path>) -> Option<ParsedSession> {
    let mut session = ParsedSession::default();
    let mut tracker = FileTracker::default();
    let mut pending: HashMap<String, PendingTool> = HashMap::new();
    let mut prompt: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut summary: Option<String> = None;

    for_each_line(reader, |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        let timestamp = value["timestamp"].as_str().and_then(parse_rfc3339_millis);
        if session.id.is_empty() {
            session.id = str_field(&value, "sessionId").unwrap_or_default();
        }
        if session.workspace.is_none() {
            // Qoder announces its workspace in a `workspace-directories` record.
            session.workspace = str_field(&value, "cwd")
                .or_else(|| value["directories"][0].as_str().map(str::to_string));
        }
        if session.created_at.is_none() {
            session.created_at = timestamp;
        }
        let message = &value["message"];
        match value["type"].as_str() {
            // Set by the user with `/rename`.
            Some("custom-title") => {
                if let Some(title) = str_field(&value, "customTitle") {
                    custom_title = Some(title);
                }
            }
            Some("ai-title") => {
                if let Some(title) = str_field(&value, "aiTitle") {
                    ai_title = Some(title);
                }
            }
            // Older Claude Code versions summarise the session instead.
            Some("summary") => {
                if summary.is_none() {
                    summary = str_field(&value, "summary");
                }
            }
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
                    if let Some(id) = str_field(item, "id") {
                        let tool = PendingTool {
                            name: name.to_string(),
                            input: item["input"].clone(),
                            task: prompt.clone(),
                            model: session.model.clone(),
                        };
                        pending.insert(id, tool);
                    }
                }
            }
            Some("user") if value["isMeta"].as_bool() != Some(true) => {
                let mut texts = Vec::new();
                match &message["content"] {
                    Value::String(text) => texts.push(text.as_str()),
                    Value::Array(items) => {
                        // `toolUseResult` describes the line's result, so it is only trusted
                        // when the line holds one.
                        let results = items
                            .iter()
                            .filter(|item| item["type"].as_str() == Some("tool_result"))
                            .count();
                        for item in items {
                            match item["type"].as_str() {
                                Some("text") => texts.extend(item["text"].as_str()),
                                Some("tool_result") => {
                                    let Some(tool) = item["tool_use_id"]
                                        .as_str()
                                        .and_then(|id| pending.remove(id))
                                    else {
                                        continue;
                                    };
                                    if item["is_error"].as_bool() == Some(true) {
                                        continue;
                                    }
                                    // Paths inside a VM-era Cowork sandbox never existed on this
                                    // machine; its deliverables are found in `outputs/`.
                                    let target =
                                        tool.input["file_path"].as_str().unwrap_or_default();
                                    if outputs.is_some() && target.starts_with("/sessions/") {
                                        continue;
                                    }
                                    let result = Some(&value["toolUseResult"]).filter(|result| {
                                        results == 1
                                            && result["filePath"].is_string()
                                            && result["filePath"] == tool.input["file_path"]
                                    });
                                    let change = Change {
                                        at: timestamp,
                                        task: tool.task.as_deref(),
                                        model: tool.model.as_deref(),
                                    };
                                    apply_file_tool(
                                        &mut tracker,
                                        &tool.name,
                                        &tool.input,
                                        session.workspace.as_deref(),
                                        result,
                                        change,
                                    );
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
                        if first_prompt.is_none() {
                            first_prompt = Some(text.clone());
                        }
                        prompt = Some(text);
                    }
                }
            }
            _ => {}
        }
        true
    });

    if let Some(dir) = outputs {
        for (path, modified) in workspace_files(dir) {
            let change = Change {
                at: modified,
                task: first_prompt.as_deref(),
                model: session.model.as_deref(),
            };
            tracker.discover(&path, change);
        }
    }
    if outputs.is_some()
        && session
            .workspace
            .as_deref()
            .is_some_and(|dir| dir.starts_with("/sessions/"))
    {
        session.workspace = outputs.map(|dir| dir.to_string_lossy().into_owned());
    }
    session.title = custom_title
        .or(ai_title)
        .or(summary)
        .map(|title| truncate_chars(&title, MAX_TITLE_CHARS))
        .or_else(|| first_prompt.as_deref().and_then(title_from_prompt));
    session.files = tracker.finish();
    Some(session)
}

/// WorkBuddy gives each task its own `~/WorkBuddy/YYYY-MM-DD-HH-MM-SS` folder, so documents
/// saved there by any means (such as a script building an Office file) belong to the task.
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

/// Regular, non-hidden files under `dir` with their modification time, in path order.
fn workspace_files(dir: &Path) -> Vec<(String, Option<i64>)> {
    fn visit(dir: &Path, depth: usize, budget: &mut usize, out: &mut Vec<(String, Option<i64>)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if *budget == 0 {
                return;
            }
            *budget -= 1;
            if entry
                .file_name()
                .to_str()
                .is_none_or(|name| name.starts_with('.'))
            {
                continue;
            }
            // DirEntry::metadata does not follow symlinks.
            let Ok(meta) = entry.metadata() else { continue };
            let path = entry.path();
            if meta.is_dir() {
                if depth > 0 {
                    visit(&path, depth - 1, budget, out);
                }
            } else if meta.is_file() {
                if let Some(text) = path.to_str() {
                    out.push((text.to_string(), meta.modified().ok().and_then(millis)));
                }
            }
        }
    }
    let mut files = Vec::new();
    let mut budget = MAX_WORKSPACE_ENTRIES;
    visit(dir, WORKSPACE_SCAN_DEPTH, &mut budget, &mut files);
    files.sort();
    files
}

fn parse_workbuddy<R: BufRead>(reader: R, task_root: &Path) -> Option<ParsedSession> {
    let mut session = ParsedSession::default();
    let mut tracker = FileTracker::default();
    let mut prompt: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut ai_title: Option<String> = None;

    for_each_line(reader, |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        let timestamp = value["timestamp"].as_i64();
        if session.id.is_empty() {
            session.id = str_field(&value, "sessionId").unwrap_or_default();
        }
        if session.workspace.is_none() {
            session.workspace = str_field(&value, "cwd");
        }
        if session.created_at.is_none() {
            session.created_at = timestamp;
        }
        if session.employee_name.is_none() {
            session.employee_name = workbuddy_buddy_name(&value);
        }
        match value["type"].as_str() {
            Some("ai-title") => {
                if let Some(title) = str_field(&value, "aiTitle") {
                    ai_title = Some(title);
                }
            }
            Some("message") => match value["role"].as_str() {
                // Mode switches and reminders arrive as user messages without a query.
                Some("user") => {
                    if let Some(query) =
                        workbuddy_user_query(&join_text(&value["content"], "input_text"))
                    {
                        let query = truncate_chars(&query, MAX_TASK_CHARS);
                        if first_prompt.is_none() {
                            first_prompt = Some(query.clone());
                        }
                        prompt = Some(query);
                    }
                }
                Some("assistant") => {
                    if let Some(model) = str_field(&value["providerData"], "model") {
                        session.model = Some(model);
                    }
                }
                _ => {}
            },
            Some("function_call") => {
                let parsed;
                let arguments = match &value["arguments"] {
                    Value::String(text) => {
                        parsed = serde_json::from_str(text).unwrap_or(Value::Null);
                        &parsed
                    }
                    other => other,
                };
                apply_file_tool(
                    &mut tracker,
                    value["name"].as_str().unwrap_or_default(),
                    arguments,
                    session.workspace.as_deref(),
                    None,
                    Change {
                        at: timestamp,
                        task: prompt.as_deref(),
                        model: session.model.as_deref(),
                    },
                );
            }
            _ => {}
        }
        true
    });

    if let Some(dir) = session
        .workspace
        .as_deref()
        .map(Path::new)
        .filter(|dir| is_workbuddy_task_folder(dir, task_root))
    {
        for (path, modified) in workspace_files(dir) {
            tracker.discover(
                &path,
                Change {
                    at: modified,
                    task: first_prompt.as_deref(),
                    model: session.model.as_deref(),
                },
            );
        }
    }
    session.title = ai_title
        .map(|title| truncate_chars(&title, MAX_TITLE_CHARS))
        .or_else(|| first_prompt.as_deref().and_then(title_from_prompt));
    session.files = tracker.finish();
    Some(session)
}

/// Sessions that left no document behind are not solutions.
fn parse_file(source: AgentSource, path: &Path, roots: &Roots) -> Option<ParsedSession> {
    let reader = BufReader::with_capacity(256 * 1024, File::open(path).ok()?);
    let mut session = match source {
        AgentSource::Codex => parse_codex(reader, false)?,
        AgentSource::Trae => parse_codex(reader, true)?,
        AgentSource::Claude | AgentSource::Qoder => parse_claude(reader, None)?,
        // Code tab sessions live with Claude Code's; Cowork ones keep deliverables in `outputs/`.
        AgentSource::ClaudeDesktop => {
            let outputs = cowork_storage(path).map(|storage| storage.join("outputs"));
            parse_claude(reader, outputs.as_deref())?
        }
        AgentSource::Workbuddy => parse_workbuddy(reader, &roots.workbuddy_tasks)?,
    };
    // Rollouts are named by time; other transcripts are named by session id.
    if session.id.is_empty() && !matches!(source, AgentSource::Codex | AgentSource::Trae) {
        session.id = path.file_stem()?.to_str()?.to_string();
    }
    (valid_id(&session.id) && session.files.iter().any(|file| !file.deleted)).then_some(session)
}

/// Document text is re-read on demand, so the long-lived cache holds metadata only.
fn without_contents(mut session: ParsedSession) -> ParsedSession {
    for file in &mut session.files {
        file.content = None;
    }
    session
}

/// Thread names from a Codex / TRAE CLI `session_index.jsonl`; later lines supersede earlier ones.
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

impl Cache {
    fn refresh(&mut self, roots: &Roots) -> Vec<SourceStatus> {
        let mut titles = HashMap::new();
        read_thread_names(&roots.codex.join("session_index.jsonl"), &mut titles);
        read_thread_names(&roots.trae.join("session_index.jsonl"), &mut titles);
        // Claude Code transcripts the desktop app lists belong to the app.
        let mut desktop = HashSet::new();
        let desktop_dirs = [
            roots
                .claude_app
                .as_ref()
                .map(|dir| dir.join("claude-code-sessions")),
            roots.cowork.clone(),
        ];
        for dir in desktop_dirs.iter().flatten() {
            read_desktop_sessions(dir, &mut desktop, &mut titles);
        }
        self.titles = titles;
        let mut files = HashMap::new();
        let mut index = HashMap::new();
        let mut statuses = Vec::new();

        for source in AgentSource::ALL {
            let mut available = false;
            let mut candidates = Vec::new();
            for (dir, depth) in roots.session_dirs(source) {
                if dir.is_dir() {
                    available = true;
                    collect_files(source, &dir, depth, &mut candidates);
                }
            }
            if source == AgentSource::ClaudeDesktop {
                available = roots
                    .claude_app
                    .iter()
                    .chain(&desktop_dirs[1])
                    .any(|dir| dir.is_dir());
                if let Some(cowork) = roots.cowork.as_deref().filter(|dir| dir.is_dir()) {
                    collect_cowork(cowork, &mut candidates);
                }
            }
            candidates.sort_by_key(|candidate| Reverse(candidate.modified));
            let truncated = candidates.len() > MAX_SESSIONS_PER_SOURCE;
            candidates.truncate(MAX_SESSIONS_PER_SOURCE);

            for candidate in candidates {
                let entry = match self.files.remove(&candidate.path) {
                    Some(entry)
                        if entry.modified == candidate.modified && entry.len == candidate.len =>
                    {
                        entry
                    }
                    _ => CacheEntry {
                        modified: candidate.modified,
                        len: candidate.len,
                        session: parse_file(source, &candidate.path, roots).map(without_contents),
                    },
                };
                if let Some(session) = &entry.session {
                    let owner = if source == AgentSource::Claude && desktop.contains(&session.id) {
                        AgentSource::ClaudeDesktop
                    } else {
                        source
                    };
                    // Candidates are newest first, so a copied/archived duplicate keeps the newest file.
                    if let Entry::Vacant(slot) = index.entry((owner, session.id.clone())) {
                        slot.insert(candidate.path.clone());
                    }
                }
                files.insert(candidate.path, entry);
            }
            statuses.push(SourceStatus {
                source,
                available,
                solution_count: 0,
                truncated,
            });
        }

        self.files = files;
        self.index = index;
        statuses
    }

    /// Documents still on disk or fully rebuilt from the record; others cannot be shown.
    fn summary(&self, source: AgentSource, path: &Path, roots: &Roots) -> Option<SolutionSummary> {
        let entry = self.files.get(path)?;
        let session = entry.session.as_ref()?;
        let mut files: Vec<SolutionFile> = session
            .files
            .iter()
            .filter(|file| !file.deleted)
            .filter_map(|file| {
                let exists = is_regular_file(&file.path);
                (exists || file.recorded).then(|| SolutionFile {
                    id: file_id(&file.path),
                    name: file_name(&file.path),
                    path: display_path(&file.path, &roots.home),
                    format: file.format,
                    kind: file.kind,
                    exists,
                    changed_at: file.changed_at,
                    task: file.task.clone(),
                    model: file.model.clone(),
                })
            })
            .collect();
        if files.is_empty() {
            return None;
        }
        files.sort_by_key(|file| Reverse(file.changed_at));
        let mut models: Vec<String> = Vec::new();
        for model in files.iter().filter_map(|file| file.model.as_ref()) {
            if !models.contains(model) {
                models.push(model.clone());
            }
        }
        if models.is_empty() {
            models.extend(session.model.clone());
        }
        let title = match source {
            AgentSource::Workbuddy => None,
            _ => self
                .titles
                .get(&session.id)
                .and_then(|name| title_from_prompt(name)),
        }
        .or_else(|| session.title.clone())
        .unwrap_or_else(|| "未命名会话".into());
        Some(SolutionSummary {
            source,
            id: session.id.clone(),
            title,
            employee_name: session
                .employee_name
                .clone()
                .unwrap_or_else(|| source.default_employee().into()),
            workspace: session
                .workspace
                .as_deref()
                .map(|path| display_path(path, &roots.home)),
            model: session.model.clone(),
            models,
            created_at: session.created_at,
            updated_at: files
                .iter()
                .filter_map(|file| file.changed_at)
                .max()
                .or_else(|| entry.modified.and_then(millis)),
            files,
        })
    }
}

impl AgentSolutionsState {
    fn list(&self) -> Result<SolutionList, String> {
        let roots = Roots::resolve()?;
        let mut cache = self.0.lock().map_err(|_| "scan_failed")?;
        let mut sources = cache.refresh(&roots);
        let mut solutions: Vec<SolutionSummary> = cache
            .index
            .iter()
            .filter_map(|((source, _), path)| cache.summary(*source, path, &roots))
            .collect();
        solutions.sort_by_key(|solution| Reverse(solution.updated_at));
        for status in &mut sources {
            status.solution_count = solutions
                .iter()
                .filter(|solution| solution.source == status.source)
                .count();
        }
        Ok(SolutionList { sources, solutions })
    }

    /// Re-parses the one session file (the cache holds no document text) and finds the document.
    fn find_file(
        &self,
        source: AgentSource,
        id: &str,
        target: &str,
    ) -> Result<(RecordedFile, Roots), String> {
        let roots = Roots::resolve()?;
        let session_path = {
            let mut cache = self.0.lock().map_err(|_| "scan_failed")?;
            let key = (source, id.to_string());
            if !cache.index.contains_key(&key) {
                cache.refresh(&roots);
            }
            cache.index.get(&key).cloned().ok_or("solution_not_found")?
        };
        let session = parse_file(source, &session_path, &roots).ok_or("solution_not_found")?;
        let file = session
            .files
            .into_iter()
            .find(|file| !file.deleted && file_id(&file.path) == target)
            .ok_or("file_not_found")?;
        Ok((file, roots))
    }

    fn read_file(
        &self,
        source: AgentSource,
        id: &str,
        target: &str,
    ) -> Result<SolutionFileContent, String> {
        let (file, roots) = self.find_file(source, id, target)?;
        let (origin, content) = match std::fs::symlink_metadata(&file.path) {
            Ok(meta) if meta.is_file() => {
                if file.format == FileFormat::Document {
                    (ContentOrigin::Disk, None)
                } else if meta.len() > MAX_DOCUMENT_BYTES as u64 {
                    return Err("file_too_large".into());
                } else {
                    let bytes = std::fs::read(&file.path).map_err(|_| "file_unreadable")?;
                    (
                        ContentOrigin::Disk,
                        Some(String::from_utf8_lossy(&bytes).into_owned()),
                    )
                }
            }
            _ => (
                ContentOrigin::Record,
                Some(file.content.ok_or("file_missing")?),
            ),
        };
        Ok(SolutionFileContent {
            name: file_name(&file.path),
            path: display_path(&file.path, &roots.home),
            format: file.format,
            origin,
            content,
        })
    }

    fn open_file(
        &self,
        source: AgentSource,
        id: &str,
        target: &str,
        reveal: bool,
    ) -> Result<(), String> {
        let (file, _) = self.find_file(source, id, target)?;
        if !is_regular_file(&file.path) {
            return Err("file_missing".into());
        }
        system_open_command(Path::new(&file.path), reveal)
            .spawn()
            .map(|_| ())
            .map_err(|_| "open_failed".into())
    }
}

fn parse_target(source: &str, id: &str, file_id: &str) -> Result<AgentSource, String> {
    let source = AgentSource::parse(source).ok_or("invalid_source")?;
    if !valid_id(id) {
        return Err("invalid_id".into());
    }
    if !valid_file_id(file_id) {
        return Err("invalid_file_id".into());
    }
    Ok(source)
}

#[tauri::command]
pub async fn list_agent_solutions(
    state: tauri::State<'_, AgentSolutionsState>,
) -> Result<SolutionList, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.list())
        .await
        .map_err(|_| "scan_failed".to_string())?
}

#[tauri::command]
pub async fn read_agent_solution_file(
    state: tauri::State<'_, AgentSolutionsState>,
    source: String,
    id: String,
    file_id: String,
) -> Result<SolutionFileContent, String> {
    let source = parse_target(&source, &id, &file_id)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.read_file(source, &id, &file_id))
        .await
        .map_err(|_| "scan_failed".to_string())?
}

/// Opens the document with its default app, or reveals it in Finder / Explorer.
#[tauri::command]
pub async fn open_agent_solution_file(
    state: tauri::State<'_, AgentSolutionsState>,
    source: String,
    id: String,
    file_id: String,
    reveal: bool,
) -> Result<(), String> {
    let source = parse_target(&source, &id, &file_id)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.open_file(source, &id, &file_id, reveal))
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

    fn lines(values: &[Value]) -> Cursor<Vec<u8>> {
        let text = values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        Cursor::new(text.into_bytes())
    }

    fn codex(reader: Cursor<Vec<u8>>) -> Option<ParsedSession> {
        parse_codex(reader, false)
    }

    fn codex_meta(extra: Value) -> Value {
        let mut payload = json!({
            "id": "01a0d0f7-b71a-7d83-85df-6ab1226c8d60",
            "timestamp": "2026-09-24T01:11:30.352Z",
            "cwd": "/Users/me/project",
            "source": "cli",
            "thread_source": "user",
        });
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({ "timestamp": "2026-09-24T01:13:47.286Z", "type": "session_meta", "payload": payload })
    }

    fn codex_user(turn: &str, text: &str) -> Value {
        json!({
            "timestamp": "2026-09-24T01:13:47.375Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": turn,
                "item": { "type": "UserMessage", "content": [{ "type": "text", "text": text }] },
            },
        })
    }

    fn codex_change(turn: &str, at: &str, status: &str, changes: Value) -> Value {
        json!({
            "timestamp": at,
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": turn,
                "item": { "type": "FileChange", "id": "call", "status": status, "changes": changes },
            },
        })
    }

    fn file<'a>(session: &'a ParsedSession, path: &str) -> &'a RecordedFile {
        session
            .files
            .iter()
            .find(|file| file.path == path)
            .unwrap_or_else(|| panic!("{path} not tracked"))
    }

    #[test]
    fn codex_replays_document_changes_and_ignores_code() {
        let session = codex(lines(&[
            codex_meta(json!({})),
            json!({ "type": "turn_context", "payload": { "model": "gpt-6" } }),
            codex_user("t1", "写一份登录改造方案"),
            codex_change("t1", "2026-09-24T01:20:00Z", "completed", json!({
                "/Users/me/project/docs/login-plan.md": { "type": "add", "content": "# 方案\n\n步骤一\n步骤三\n" },
                "/Users/me/project/src/login.ts": { "type": "add", "content": "export {}\n" },
                "/Users/me/project/README.md": { "type": "update", "unified_diff": "@@ -1 +1 @@\n-a\n+b\n", "move_path": null },
            })),
            codex_user("t2", "补上步骤二，并改名"),
            codex_change("t2", "2026-09-24T01:30:00Z", "completed", json!({
                "docs/login-plan.md": {
                    "type": "update",
                    "unified_diff": "@@ -3,2 +3,3 @@\n 步骤一\n+步骤二\n 步骤三\n",
                    "move_path": "/Users/me/project/docs/login-final.md",
                },
            })),
            // Failed patches never touched the file.
            codex_change("t2", "2026-09-24T01:31:00Z", "failed", json!({
                "/Users/me/project/docs/login-final.md": { "type": "delete", "content": "" },
            })),
            codex_user("t3", "清理草稿"),
            codex_change("t3", "2026-09-24T01:40:00Z", "completed", json!({
                "/Users/me/project/docs/draft.md": { "type": "add", "content": "draft" },
            })),
            codex_change("t3", "2026-09-24T01:41:00Z", "completed", json!({
                "/Users/me/project/docs/draft.md": { "type": "delete", "content": "draft" },
            })),
            codex_user("t4", "更新已有的设计文档"),
            codex_change("t4", "2026-09-24T01:50:00Z", "completed", json!({
                "/Users/me/project/docs/design.md": { "type": "update", "unified_diff": "@@ -1 +1 @@\n-a\n+b\n", "move_path": null },
            })),
        ]))
        .unwrap();

        assert_eq!(session.model.as_deref(), Some("gpt-6"));
        assert_eq!(session.title.as_deref(), Some("写一份登录改造方案"));
        let paths: Vec<_> = session
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(
            paths,
            [
                "/Users/me/project/docs/login-plan.md",
                "/Users/me/project/docs/login-final.md",
                "/Users/me/project/docs/draft.md",
                "/Users/me/project/docs/design.md",
            ]
        );

        assert!(file(&session, "/Users/me/project/docs/login-plan.md").deleted);
        let renamed = file(&session, "/Users/me/project/docs/login-final.md");
        assert!(!renamed.deleted);
        assert_eq!(renamed.kind, ChangeKind::Created);
        assert_eq!(renamed.format, FileFormat::Markdown);
        assert_eq!(
            renamed.content.as_deref(),
            Some("# 方案\n\n步骤一\n步骤二\n步骤三\n")
        );
        assert!(renamed.recorded);
        assert_eq!(renamed.task.as_deref(), Some("补上步骤二，并改名"));
        assert_eq!(
            renamed.changed_at,
            parse_rfc3339_millis("2026-09-24T01:30:00Z")
        );

        assert!(file(&session, "/Users/me/project/docs/draft.md").deleted);
        // An update to a document the session never saw in full cannot be rebuilt.
        let design = file(&session, "/Users/me/project/docs/design.md");
        assert_eq!(design.kind, ChangeKind::Updated);
        assert_eq!(design.content, None);
        assert!(!design.recorded);
    }

    #[test]
    fn codex_joins_steered_prompts_and_supports_legacy_user_message() {
        let session = codex(lines(&[
            codex_meta(json!({})),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "legacy prompt" } }),
            codex_user("t1", "first"),
            codex_user("t1", "steer"),
            codex_change("t1", "2026-09-24T01:20:00Z", "completed", json!({
                "/Users/me/project/notes.txt": { "type": "add", "content": "x" },
            })),
        ]))
        .unwrap();
        assert_eq!(session.title.as_deref(), Some("legacy prompt"));
        assert_eq!(session.files[0].task.as_deref(), Some("first\n\nsteer"));
        assert_eq!(session.files[0].format, FileFormat::Text);
    }

    #[test]
    fn codex_skips_subagent_threads() {
        let by_thread_source = codex_meta(json!({ "thread_source": "subagent" }));
        let by_source = codex_meta(json!({ "source": { "subagent": { "thread_spawn": {} } } }));
        for meta in [by_thread_source, by_source] {
            assert!(codex(lines(&[
                meta,
                codex_change(
                    "t",
                    "2026-09-24T01:20:00Z",
                    "completed",
                    json!({
                        "/Users/me/project/plan.md": { "type": "add", "content": "x" },
                    })
                ),
            ]))
            .is_none());
        }
    }

    #[test]
    fn unified_diffs_apply_hunks_in_order() {
        let original = "a\nb\nc\nd\ne\n";
        assert_eq!(
            apply_unified_diff(
                original,
                "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -4,0 +5,1 @@\n+d2\n"
            )
            .as_deref(),
            Some("A\nb\nc\nd\nd2\ne\n")
        );
        // Stale line numbers are recovered by searching forward for the context.
        assert_eq!(
            apply_unified_diff(original, "@@ -1,2 +1,1 @@\n d\n-e\n").as_deref(),
            Some("a\nb\nc\nd\n")
        );
        assert_eq!(
            apply_unified_diff("x", "@@ -1 +1,2 @@\n x\n+y\n\\ No newline at end of file\n")
                .as_deref(),
            Some("x\ny")
        );
        assert_eq!(apply_unified_diff(original, "@@ -1 +1 @@\n-z\n+y\n"), None);
        assert_eq!(apply_unified_diff(original, "@@ -1,2 +1,2 @@\n-a\n"), None);
    }

    #[test]
    fn workbuddy_replays_file_tools_with_the_current_query() {
        let reminder = "<system-reminder data-role=\"user-context\">\nWorkspace Folder: /x\n</system-reminder>\n";
        let write = |path: &str, content: &str, at: i64| {
            json!({ "type": "function_call", "name": "Write", "timestamp": at,
                "arguments": json!({ "file_path": path, "content": content }).to_string() })
        };
        let session = parse_workbuddy(
            lines(&[
                json!({ "type": "session-meta", "sessionId": "4f8efe36-036e", "timestamp": 100 }),
                json!({ "type": "message", "role": "user", "timestamp": 110, "cwd": "/Users/me/Code/app",
                    "content": [{ "type": "input_text", "text": format!("{reminder}<user_query>写一份 BLE 后台方案</user_query>") }] }),
                json!({ "type": "ai-title", "aiTitle": "BLE 后台方案",
                    "_meta": { "baggage": "buddyId=1,buddyName=%E5%B0%8F%E7%A0%9A,codebuddy.session_id=x" } }),
                json!({ "type": "message", "role": "assistant", "timestamp": 120,
                    "providerData": { "model": "deepseek-v4.1-flash" },
                    "content": [{ "type": "output_text", "text": "我先写方案。" }] }),
                write("/Users/me/Code/app/docs/ble.md", "# BLE\n旧结论\n", 121),
                write("/Users/me/Code/app/src/ble.swift", "import CoreBluetooth\n", 122),
                // A mode switch without a query keeps the current request.
                json!({ "type": "message", "role": "user", "timestamp": 130,
                    "content": [{ "type": "input_text", "text": reminder }] }),
                json!({ "type": "message", "role": "user", "timestamp": 140,
                    "content": [{ "type": "input_text", "text": "<user_query>改一下结论</user_query>" }] }),
                json!({ "type": "function_call", "name": "Edit", "timestamp": 141, "arguments": json!({
                    "file_path": "/Users/me/Code/app/docs/ble.md", "old_string": "旧结论", "new_string": "新结论" }).to_string() }),
                json!({ "type": "function_call", "name": "MultiEdit", "timestamp": 142, "arguments": {
                    "file_path": "/Users/me/Code/app/docs/ble.md",
                    "edits": [{ "old_string": "# BLE", "new_string": "# BLE 方案" }, { "old_string": "x", "new_string": "y", "replace_all": true }] } }),
                json!({ "type": "function_call", "name": "Edit", "timestamp": 143, "arguments": json!({
                    "file_path": "/Users/me/Code/app/docs/old.md", "old_string": "a", "new_string": "b" }).to_string() }),
            ]),
            Path::new("/Users/me/WorkBuddy"),
        )
        .unwrap();

        assert_eq!(session.id, "4f8efe36-036e");
        assert_eq!(session.title.as_deref(), Some("BLE 后台方案"));
        assert_eq!(session.employee_name.as_deref(), Some("小砚"));
        assert_eq!(session.workspace.as_deref(), Some("/Users/me/Code/app"));
        assert_eq!(session.model.as_deref(), Some("deepseek-v4.1-flash"));
        assert_eq!(session.created_at, Some(100));
        assert_eq!(session.files.len(), 2);

        // The second MultiEdit step does not match, so the replay is abandoned rather than guessed.
        let ble = file(&session, "/Users/me/Code/app/docs/ble.md");
        assert_eq!(ble.kind, ChangeKind::Created);
        assert_eq!(ble.content, None);
        assert_eq!(ble.task.as_deref(), Some("改一下结论"));
        assert_eq!(ble.changed_at, Some(142));
        assert_eq!(
            file(&session, "/Users/me/Code/app/docs/old.md").kind,
            ChangeKind::Updated
        );

        assert_eq!(
            replace_text(
                "a-a".into(),
                &json!({ "old_string": "a", "new_string": "b", "replace_all": true })
            )
            .as_deref(),
            Some("b-b")
        );
        assert_eq!(
            replace_text(
                "# BLE\n旧结论\n".into(),
                &json!({ "old_string": "旧结论", "new_string": "新结论" })
            )
            .as_deref(),
            Some("# BLE\n新结论\n")
        );
    }

    #[test]
    fn workbuddy_task_folders_contribute_saved_documents() {
        let root = std::env::temp_dir().join(format!(
            "aiteam-workbench-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let task = root.join("2026-10-27-16-16-58");
        std::fs::create_dir_all(task.join("output/deep/deeper")).unwrap();
        std::fs::create_dir_all(task.join(".workbuddy/memory")).unwrap();
        for name in [
            "方案.docx",
            "汇报.pptx",
            "build.py",
            ".hidden.md",
            "output/预算.xlsx",
            "output/deep/deeper/too-deep.md",
            ".workbuddy/memory/2026-10-27.md",
        ] {
            std::fs::write(task.join(name), "x").unwrap();
        }
        let workspace = task.to_str().unwrap().to_string();
        let session = parse_workbuddy(
            lines(&[
                json!({ "type": "message", "role": "user", "sessionId": "s1", "timestamp": 1, "cwd": workspace,
                    "content": [{ "type": "input_text", "text": "<user_query>做一份预算和汇报</user_query>" }] }),
                json!({ "type": "function_call", "name": "Write", "timestamp": 2, "arguments": json!({
                    "file_path": format!("{workspace}/方案.docx"), "content": "x" }).to_string() }),
            ]),
            &root,
        )
        .unwrap();
        let names: Vec<_> = session
            .files
            .iter()
            .map(|file| file_name(&file.path))
            .collect();
        // Hidden entries, code and anything deeper than two folders are skipped.
        assert_eq!(names, ["方案.docx", "预算.xlsx", "汇报.pptx"]);
        assert!(session
            .files
            .iter()
            .all(|file| file.format == FileFormat::Document));
        assert_eq!(session.files[1].task.as_deref(), Some("做一份预算和汇报"));
        assert!(session.files[1].changed_at.is_some());

        assert!(is_workbuddy_task_folder(&task, &root));
        assert!(!is_workbuddy_task_folder(&root.join("Claw"), &root));
        assert!(!is_workbuddy_task_folder(&task.join("output"), &root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_absolute_document_paths_are_solutions() {
        assert_eq!(
            solution_format("/Users/me/docs/方案.MD"),
            Some(FileFormat::Markdown)
        );
        assert_eq!(solution_format("/tmp/report.html"), Some(FileFormat::Html));
        assert_eq!(solution_format("/tmp/data.csv"), Some(FileFormat::Csv));
        assert_eq!(solution_format("/tmp/logo.svg"), Some(FileFormat::Svg));
        assert_eq!(solution_format("/tmp/汇报.pdf"), Some(FileFormat::Document));
        assert_eq!(
            solution_format("/Users/me/.claude/plans/toasty-fairy.md"),
            Some(FileFormat::Markdown)
        );
        // Only whole name parts count: a tokenizer design is not a token file.
        assert_eq!(
            solution_format("/tmp/tokenizer-design.md"),
            Some(FileFormat::Markdown)
        );
        for rejected in [
            "docs/plan.md",
            "/Users/me/app/src/main.ts",
            "/Users/me/app/README.md",
            "/Users/me/app/AGENTS.md",
            "/Users/me/app/CHANGELOG.markdown",
            "/Users/me/.codex/memories/plan.md",
            "/Users/me/.claude/notes/plan.md",
            "/Users/me/.claude/plans/old/plan.md",
            "/Users/me/.cache/.claude/plans/plan.md",
            "/Users/me/app/node_modules/pkg/guide.md",
            "/Users/me/app/../secret/plan.md",
            "/Users/me/app/plan",
            "/Users/me/app/prod.env.txt",
            "/Users/me/app/db_password.md",
            "/Users/me/app/API-Key notes.md",
            "/Users/me/app/access_key.csv",
        ] {
            assert_eq!(solution_format(rejected), None, "{rejected}");
        }
        assert_eq!(
            absolute_path("docs/a.md", Some("/Users/me/app")).as_deref(),
            Some("/Users/me/app/docs/a.md")
        );
        assert_eq!(absolute_path("docs/a.md", None), None);
    }

    #[test]
    fn file_ids_are_opaque_and_validated() {
        let id = file_id("/Users/me/docs/plan.md");
        assert_eq!(id.len(), 16);
        assert!(valid_file_id(&id));
        assert_eq!(id, file_id("/Users/me/docs/plan.md"));
        assert_ne!(id, file_id("/Users/me/docs/plan2.md"));
        for invalid in ["", "../x", "/Users/me/docs/plan.md", "0123456789abcdeg"] {
            assert!(!valid_file_id(invalid), "{invalid}");
        }
        assert_eq!(
            parse_target("codex", "abc", &id).ok(),
            Some(AgentSource::Codex)
        );
        assert_eq!(
            parse_target("codex", "abc", "/etc/passwd").unwrap_err(),
            "invalid_file_id"
        );
        assert_eq!(
            parse_target("../codex", "abc", &id).unwrap_err(),
            "invalid_source"
        );
    }

    #[test]
    fn workbuddy_without_query_markup_strips_reminders() {
        assert_eq!(
            workbuddy_user_query("<system-reminder a=\"b\">ctx</system-reminder>\n  hello  ")
                .as_deref(),
            Some("hello")
        );
        assert_eq!(
            workbuddy_user_query("<system-reminder>only</system-reminder>"),
            None
        );
    }

    #[test]
    fn parses_rfc3339_timestamps() {
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_millis("2026-09-24T01:13:47.286Z"),
            Some(1_790_212_427_286)
        );
        assert_eq!(
            parse_rfc3339_millis("2026-09-24T09:13:47.286123+08:00"),
            Some(1_790_212_427_286)
        );
        assert_eq!(
            parse_rfc3339_millis("2000-02-29T12:00:00-01:30"),
            Some(951_831_000_000)
        );
        for invalid in [
            "",
            "2026-09-24",
            "2026-13-01T00:00:00Z",
            "2026-09-24T01:13:47",
            "2026-09-24T01:13:47.Z",
        ] {
            assert_eq!(parse_rfc3339_millis(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn rejects_ids_that_could_address_paths() {
        assert!(valid_id("01a0d0f7-b71a-7d83-85df-6ab1226c8d60"));
        for invalid in [
            "",
            "../x",
            "a/b",
            "a.jsonl",
            "%2e%2e",
            &"a".repeat(MAX_ID_LEN + 1),
        ] {
            assert!(!valid_id(invalid), "{invalid}");
        }
        assert_eq!(AgentSource::parse("codex"), Some(AgentSource::Codex));
        assert_eq!(AgentSource::parse("../codex"), None);
    }

    #[test]
    fn shortens_home_paths_and_long_text() {
        let home = Path::new("/Users/me");
        assert_eq!(display_path("/Users/me/WorkBuddy/a", home), "~/WorkBuddy/a");
        assert_eq!(display_path("/Users/me", home), "~");
        assert_eq!(display_path("/Users/meow/x", home), "/Users/meow/x");
        assert_eq!(truncate_chars("你好世界", 2), "你好…");
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(percent_decode("a%2Cb%zz%E5%B0%8F"), "a,b%zz小");
    }

    #[test]
    fn sources_round_trip_through_their_ids() {
        for source in AgentSource::ALL {
            let id = serde_json::to_value(source).unwrap();
            assert_eq!(AgentSource::parse(id.as_str().unwrap()), Some(source));
        }
        assert_eq!(
            AgentSource::parse("claude_desktop"),
            Some(AgentSource::ClaudeDesktop)
        );
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aiteam-workbench-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn with_fields(mut base: Value, extra: Value) -> Value {
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    fn claude_user(extra: Value, content: Value) -> Value {
        with_fields(
            json!({ "type": "user", "sessionId": "c1", "cwd": "/Users/me/app",
                "timestamp": "2026-10-01T10:00:00Z", "isSidechain": false,
                "message": { "role": "user", "content": content } }),
            extra,
        )
    }

    fn claude_prompt_line(text: &str) -> Value {
        claude_user(json!({}), json!(text))
    }

    fn claude_tool_use(model: &str, calls: &[(&str, &str, Value)]) -> Value {
        let content: Vec<Value> = calls
            .iter()
            .map(|(id, name, input)| json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
            .collect();
        json!({ "type": "assistant", "sessionId": "c1", "timestamp": "2026-10-01T10:01:00Z",
            "message": { "role": "assistant", "model": model, "content": content } })
    }

    fn claude_result(ids: &[&str], is_error: bool, result: Value) -> Value {
        let content: Vec<Value> = ids
            .iter()
            .map(|id| json!({ "type": "tool_result", "tool_use_id": id, "is_error": is_error, "content": "ok" }))
            .collect();
        claude_user(
            json!({ "timestamp": "2026-10-01T10:02:00Z", "toolUseResult": result }),
            json!(content),
        )
    }

    #[test]
    fn claude_replays_file_tools_from_their_results() {
        let doc = "/Users/me/app/docs/迁移方案.md";
        let plan = "/Users/me/app/plan.md";
        let session = parse_claude(
            lines(&[
                claude_prompt_line("<system-reminder>ctx</system-reminder>\n写一份迁移方案"),
                claude_tool_use(
                    "deepseek-v4-flash",
                    &[("t1", "Write", json!({ "file_path": doc, "content": "# 方案\n第一步\n" }))],
                ),
                claude_result(
                    &["t1"],
                    false,
                    json!({ "type": "create", "filePath": doc, "content": "# 方案\n第一步\n",
                        "structuredPatch": [], "originalFile": null }),
                ),
                // A slash command's request is its arguments; command output and meta lines are not requests.
                claude_prompt_line(
                    "<command-message>plan</command-message>\n<command-name>/plan</command-name>\n<command-args>补充回滚步骤</command-args>",
                ),
                claude_prompt_line("<local-command-stdout>ok</local-command-stdout>"),
                claude_user(json!({ "isMeta": true }), json!("meta noise")),
                claude_user(json!({ "isCompactSummary": true }), json!("compact summary")),
                // The recorded patch wins over the call's arguments.
                claude_tool_use(
                    "glm-5.3",
                    &[("t2", "Edit", json!({ "file_path": doc, "old_string": "第一步", "new_string": "IGNORED" }))],
                ),
                claude_result(
                    &["t2"],
                    false,
                    json!({ "filePath": doc, "originalFile": null, "structuredPatch": [{
                        "oldStart": 2, "oldLines": 1, "newStart": 2, "newLines": 2,
                        "lines": ["-第一步", "+第一步：备份", "+第二步：回滚"] }] }),
                ),
                // A document the session never read is rebuilt from the content the result carries.
                claude_tool_use(
                    "glm-5.3",
                    &[("t3", "Edit", json!({ "file_path": plan, "old_string": "b", "new_string": "c" }))],
                ),
                claude_result(
                    &["t3"],
                    false,
                    json!({ "filePath": plan, "originalFile": "a\nb\n", "structuredPatch": [{
                        "oldStart": 2, "oldLines": 1, "newStart": 2, "newLines": 1, "lines": ["-b", "+c"] }] }),
                ),
                // Failed calls and code leave nothing.
                claude_tool_use(
                    "glm-5.3",
                    &[("t4", "Write", json!({ "file_path": "/Users/me/app/failed.md", "content": "x" }))],
                ),
                claude_result(&["t4"], true, json!("Error: permission denied")),
                claude_tool_use(
                    "glm-5.3",
                    &[("t5", "Write", json!({ "file_path": "/Users/me/app/src/main.ts", "content": "x" }))],
                ),
                claude_result(&["t5"], false, json!({})),
                // A subagent's prompt is not the user's.
                claude_user(json!({ "isSidechain": true }), json!("子任务提示")),
                json!({ "type": "assistant", "sessionId": "c1",
                    "message": { "model": "<synthetic>", "content": [{ "type": "text", "text": "No response requested." }] } }),
                json!({ "type": "ai-title", "sessionId": "c1", "aiTitle": "迁移方案讨论" }),
                json!({ "type": "custom-title", "sessionId": "c1", "customTitle": "我的方案" }),
            ]),
            None,
        )
        .unwrap();
        assert_eq!(session.id, "c1");
        assert_eq!(session.workspace.as_deref(), Some("/Users/me/app"));
        assert_eq!(session.model.as_deref(), Some("glm-5.3"));
        assert_eq!(session.title.as_deref(), Some("我的方案"));
        assert_eq!(session.files.len(), 2);

        let doc = file(&session, doc);
        assert_eq!(doc.kind, ChangeKind::Created);
        assert_eq!(
            doc.content.as_deref(),
            Some("# 方案\n第一步：备份\n第二步：回滚\n")
        );
        assert_eq!(doc.task.as_deref(), Some("补充回滚步骤"));
        assert_eq!(doc.model.as_deref(), Some("glm-5.3"));

        let plan = file(&session, plan);
        assert_eq!(plan.kind, ChangeKind::Updated);
        assert_eq!(plan.content.as_deref(), Some("a\nc\n"));
    }

    #[test]
    fn qoder_transcripts_replay_tool_arguments() {
        let line = |value: Value| with_fields(value, json!({ "sessionId": "q1" }));
        let api = "/Users/me/q/api.md";
        let session = parse_claude(
            lines(&[
                line(json!({ "type": "workspace-directories", "directories": ["/Users/me/q"] })),
                line(json!({ "type": "user", "message": { "role": "user", "content": "整理接口文档" } })),
                claude_tool_use(
                    "qoder-auto",
                    &[("q1", "Write", json!({ "file_path": api, "content": "GET /a\nGET /b\n" }))],
                ),
                line(json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "q1" }] } })),
                // Relative paths resolve against the workspace.
                claude_tool_use(
                    "qoder-auto",
                    &[("q2", "Edit", json!({ "file_path": "api.md", "old_string": "GET /b", "new_string": "POST /b" }))],
                ),
                line(json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "q2" }] } })),
                claude_tool_use(
                    "qoder-auto",
                    &[("q3", "MultiEdit", json!({ "file_path": api, "edits": [
                        { "old_string": "GET /a", "new_string": "GET /a?x=1" },
                        { "old_string": "POST", "new_string": "PUT", "replace_all": true },
                    ] }))],
                ),
                line(json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "q3" }] } })),
                // A line with two results cannot say which one `toolUseResult` describes.
                claude_tool_use(
                    "qoder-auto",
                    &[
                        ("q4", "Write", json!({ "file_path": "/Users/me/q/notes.md", "content": "甲" })),
                        ("q5", "Write", json!({ "file_path": "/Users/me/q/outline.md", "content": "乙" })),
                    ],
                ),
                claude_result(
                    &["q4", "q5"],
                    false,
                    json!({ "type": "create", "filePath": "/Users/me/q/notes.md", "content": "WRONG" }),
                ),
            ]),
            None,
        )
        .unwrap();
        assert_eq!(session.id, "q1");
        assert_eq!(session.workspace.as_deref(), Some("/Users/me/q"));
        assert_eq!(session.title.as_deref(), Some("整理接口文档"));
        assert_eq!(
            file(&session, api).content.as_deref(),
            Some("GET /a?x=1\nPUT /b\n")
        );
        assert_eq!(
            file(&session, "/Users/me/q/notes.md").content.as_deref(),
            Some("甲")
        );
        assert_eq!(
            file(&session, "/Users/me/q/outline.md").task.as_deref(),
            Some("整理接口文档")
        );
    }

    #[test]
    fn structured_patches_become_unified_diffs() {
        let hunks = json!([
            { "oldStart": 1, "oldLines": 0, "newStart": 1, "newLines": 1, "lines": ["+top"] },
            { "oldStart": 2, "oldLines": 1, "newStart": 3, "newLines": 0, "lines": ["-b"] },
        ]);
        let diff = structured_patch_diff(&hunks).unwrap();
        assert_eq!(diff, "@@ -0,0 +1,1 @@\n+top\n@@ -2,1 +2,0 @@\n-b\n");
        assert_eq!(
            apply_unified_diff("a\nb\nc\n", &diff).as_deref(),
            Some("top\na\nc\n")
        );
        assert_eq!(structured_patch_diff(&json!([])), None);
        assert_eq!(structured_patch_diff(&json!(null)), None);
    }

    #[test]
    fn apply_patch_updates_follow_anchors_and_file_ends() {
        let patch = "*** Begin Patch\n\
            *** Add File: docs/new.md\n+# New\n+body\n\
            *** Update File: docs/a.md\n\
            @@ fn b\n-x\n+y\n\
            @@\n-end  \n+end2\n*** End of File\n\
            *** Update File: docs/b.md\n*** Move to: docs/c.md\n@@\n-old\n+new\n\
            *** Delete File: docs/gone.md\n\
            *** End Patch\n";
        let ops = parse_codex_patch(patch).unwrap();
        assert_eq!(ops.len(), 4);
        let PatchOp::Update { chunks, .. } = &ops[1] else {
            panic!("expected an update");
        };
        // The anchor picks the second `x`; trailing whitespace is tolerated.
        assert_eq!(
            apply_patch_chunks("fn a\nx\nfn b\nx\nend\n", chunks).as_deref(),
            Some("fn a\nx\nfn b\ny\nend2\n")
        );
        assert_eq!(apply_patch_chunks("fn a\nz\n", chunks), None);
        assert!(parse_codex_patch("*** Begin Patch\n*** Bogus\n*** End Patch").is_none());
        assert!(parse_codex_patch("*** Begin Patch\n*** Add File: a.md\n+x").is_none());

        let mut tracker = FileTracker::default();
        tracker.write(
            "/w/docs/a.md",
            Some("fn b\nx\nend\n"),
            ChangeKind::Created,
            Change::default(),
        );
        tracker.write(
            "/w/docs/b.md",
            Some("old\n"),
            ChangeKind::Created,
            Change::default(),
        );
        tracker.write(
            "/w/docs/gone.md",
            Some("bye\n"),
            ChangeKind::Created,
            Change::default(),
        );
        apply_codex_patch(&mut tracker, patch, Some("/w"), Change::default());
        let files = tracker.finish();
        let live = |path: &str| files.iter().find(|file| file.path == path && !file.deleted);
        assert_eq!(
            live("/w/docs/new.md").unwrap().content.as_deref(),
            Some("# New\nbody\n")
        );
        assert_eq!(
            live("/w/docs/a.md").unwrap().content.as_deref(),
            Some("fn b\ny\nend2\n")
        );
        assert_eq!(
            live("/w/docs/c.md").unwrap().content.as_deref(),
            Some("new\n")
        );
        assert!(live("/w/docs/b.md").is_none());
        assert!(live("/w/docs/gone.md").is_none());
    }

    #[test]
    fn trae_replays_successful_apply_patch_calls_once() {
        let add = "*** Begin Patch\n*** Add File: docs/deploy.md\n+# 部署\n+步骤一\n*** End Patch";
        let update = "*** Begin Patch\n*** Update File: docs/deploy.md\n@@\n # 部署\n-步骤一\n+步骤一：备份\n+步骤二\n*** End Patch";
        let failed = "*** Begin Patch\n*** Add File: docs/failed.md\n+x\n*** End Patch";
        let replaced = "*** Begin Patch\n*** Add File: docs/replaced.md\n+x\n*** End Patch";
        let item = |payload: Value| json!({ "timestamp": "2026-10-02T08:00:00Z", "type": "response_item", "payload": payload });
        let custom_call = |id: &str, patch: &str| json!({ "type": "custom_tool_call", "status": "completed", "call_id": id, "name": "apply_patch", "input": patch });
        let custom_output = |id: &str, output: &str| json!({ "type": "custom_tool_call_output", "call_id": id, "output": output });
        let history = |operation: &str, items: Value| {
            json!({ "timestamp": "2026-10-02T08:00:01Z", "type": "history_mutation",
                "payload": { "operation": operation, "items": items } })
        };
        let success = "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nA docs/deploy.md\n";
        let rollout = [
            codex_meta(json!({ "originator": "codex-tui" })),
            json!({ "type": "turn_context", "payload": { "model": "doubao-seed-2.1" } }),
            // The same prompt as an event and as an item.
            json!({ "type": "event_msg", "payload": { "type": "user_message", "turn_id": "t1", "message": "写部署文档" } }),
            codex_user("t1", "写部署文档"),
            item(custom_call("c1", add)),
            item(custom_output("c1", success)),
            // TRAE's history repeats the call; it is replayed once.
            history(
                "append",
                json!([custom_call("c1", add), custom_output("c1", success)]),
            ),
            item(
                json!({ "type": "function_call", "name": "shell", "call_id": "c2",
                "arguments": json!({ "command": ["apply_patch", update] }).to_string() }),
            ),
            item(json!({ "type": "function_call_output", "call_id": "c2",
                "output": json!({ "output": "Success.", "metadata": { "exit_code": 0 } }).to_string() })),
            item(custom_call("c3", failed)),
            item(custom_output(
                "c3",
                "apply_patch verification failed: Failed to find expected lines",
            )),
            history(
                "replace",
                json!([custom_call("c4", replaced), custom_output("c4", success)]),
            ),
        ];
        let session = parse_codex(lines(&rollout), true).unwrap();
        assert_eq!(session.files.len(), 1);
        let deploy = file(&session, "/Users/me/project/docs/deploy.md");
        assert_eq!(
            deploy.content.as_deref(),
            Some("# 部署\n步骤一：备份\n步骤二\n")
        );
        assert_eq!(deploy.kind, ChangeKind::Created);
        assert_eq!(deploy.task.as_deref(), Some("写部署文档"));
        assert_eq!(deploy.model.as_deref(), Some("doubao-seed-2.1"));
        // Codex itself always records FileChange items, so it ignores apply_patch calls.
        assert!(codex(lines(&rollout)).unwrap().files.is_empty());

        assert!(tool_output_succeeded(&json!("Exit code: 0\nOutput:\nok")));
        assert!(!tool_output_succeeded(&json!(
            "Exit code: 1\nOutput:\nboom"
        )));
        assert!(!tool_output_succeeded(
            &json!({ "content": "x", "success": false })
        ));
        assert!(!tool_output_succeeded(&json!("error: patch rejected")));
    }

    #[test]
    fn claude_desktop_sessions_are_found_and_named_by_the_app() {
        let root = temp_root("desktop");
        let app = root.join("Claude");
        let cowork = app.join("local-agent-mode-sessions");
        let claude = root.join(".claude");
        let write = |path: PathBuf, text: String| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        let transcript = |id: &str, cwd: &str, doc: &str| {
            lines(&[
                json!({ "type": "user", "sessionId": id, "cwd": cwd, "message": { "content": "写周报" } }),
                json!({ "type": "assistant", "sessionId": id, "message": { "model": "claude-opus-4-8", "content": [
                    { "type": "tool_use", "id": "w", "name": "Write", "input": { "file_path": doc, "content": "周报" } }] } }),
                json!({ "type": "user", "sessionId": id, "message": { "content": [{ "type": "tool_result", "tool_use_id": "w" }] } }),
            ])
            .into_inner()
        };
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();

        // A Claude Code session the desktop Code tab lists, and one it does not.
        let projects = claude.join("projects/-Users-me-app");
        write(
            projects.join("s-code.jsonl"),
            text(transcript(
                "s-code",
                "/Users/me/app",
                "/Users/me/app/code.md",
            )),
        );
        write(
            projects.join("s-cli.jsonl"),
            text(transcript("s-cli", "/Users/me/app", "/Users/me/app/cli.md")),
        );
        write(
            app.join("claude-code-sessions/acct/org/local_1.json"),
            json!({ "cliSessionId": "s-code", "title": "桌面端会话" }).to_string(),
        );
        // A VM-era Cowork session: its sandbox paths are skipped and its outputs folder holds the deliverable.
        let account = cowork.join("org/acct");
        let storage = account.join("agent/local_2");
        write(
            account.join("agent/local_2.json"),
            json!({ "cliSessionId": "s-cowork", "title": "Cowork 周报" }).to_string(),
        );
        let cowork_transcript = storage.join(".claude/projects/-sessions-brave-owl/s-cowork.jsonl");
        write(
            cowork_transcript.clone(),
            text(transcript(
                "s-cowork",
                "/sessions/brave-owl",
                "/sessions/brave-owl/mnt/outputs/周报.md",
            )),
        );
        write(storage.join("outputs/周报.md"), "周报".into());
        write(storage.join("uploads/输入.md"), "输入".into());
        assert_eq!(cowork_storage(&cowork_transcript), Some(storage.as_path()));
        assert_eq!(cowork_storage(&projects.join("s-code.jsonl")), None);

        let roots = Roots {
            home: root.clone(),
            codex: root.join(".codex"),
            trae: root.join(".trae/cli"),
            claude,
            claude_app: Some(app),
            cowork: Some(cowork),
            qoder: vec![root.join(".qoder")],
            workbuddy: root.join(".workbuddy"),
            workbuddy_tasks: root.join("WorkBuddy"),
        };
        let mut cache = Cache::default();
        let statuses = cache.refresh(&roots);
        let available = |source| {
            statuses
                .iter()
                .any(|status| status.source == source && status.available)
        };
        assert!(available(AgentSource::Claude) && available(AgentSource::ClaudeDesktop));
        assert!(!available(AgentSource::Qoder) && !available(AgentSource::Trae));

        let mut summaries: Vec<SolutionSummary> = cache
            .index
            .iter()
            .filter_map(|((source, _), path)| cache.summary(*source, path, &roots))
            .collect();
        summaries.sort_by(|a, b| a.id.cmp(&b.id));
        let found: Vec<_> = summaries
            .iter()
            .map(|summary| (summary.source, summary.id.as_str(), summary.title.as_str()))
            .collect();
        assert_eq!(
            found,
            [
                (AgentSource::Claude, "s-cli", "写周报"),
                (AgentSource::ClaudeDesktop, "s-code", "桌面端会话"),
                (AgentSource::ClaudeDesktop, "s-cowork", "Cowork 周报"),
            ]
        );
        let cowork_summary = &summaries[2];
        let names: Vec<_> = cowork_summary
            .files
            .iter()
            .map(|file| file.name.as_str())
            .collect();
        assert_eq!(names, ["周报.md"]);
        assert!(cowork_summary.files[0].exists);
        assert_eq!(cowork_summary.models, ["claude-opus-4-8"]);
        assert!(cowork_summary
            .workspace
            .as_deref()
            .is_some_and(|dir| dir.ends_with("local_2/outputs")));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
