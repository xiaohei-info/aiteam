//! Finding projects: where each agent keeps its sessions, which folders a session created, and
//! the cached scan that turns sessions into project summaries.

use super::*;
use std::ffi::OsString;

pub(super) struct CacheEntry {
    pub(super) modified: Option<SystemTime>,
    pub(super) len: u64,
    pub(super) session: Option<SessionRecord>,
}

#[derive(Default)]
pub(super) struct Cache {
    pub(super) sessions: HashMap<PathBuf, CacheEntry>,
    /// Project folders by (source, project id) from the latest scan.
    pub(super) index: HashMap<(AgentSource, String), PathBuf>,
}

pub(super) struct Roots {
    pub(super) home: PathBuf,
    pub(super) codex: PathBuf,
    pub(super) claude: PathBuf,
    /// Claude desktop app data folder.
    pub(super) claude_app: Option<PathBuf>,
    /// Claude desktop Cowork sessions.
    pub(super) cowork: Option<PathBuf>,
    pub(super) workbuddy: PathBuf,
    /// Parent of WorkBuddy's per-task folders.
    pub(super) workbuddy_tasks: PathBuf,
}

/// An absolute directory named by an environment variable.
pub(super) fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// The current user's home directory.
///
/// Only looking at `HOME` broke every local source on Windows: Windows shells export `USERPROFILE`
/// (or `HOMEDRIVE`+`HOMEPATH`) instead, and the `HOME` a Git Bash parent sets is a POSIX path such
/// as `/c/Users/me`, which is not an absolute Windows path. The scan then failed with
/// `home_unavailable` and the workbench reported “无法确定当前用户目录”.
pub(super) fn home_dir() -> Option<PathBuf> {
    home_dir_from(|name| std::env::var_os(name))
}

pub(super) fn home_dir_from(env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let absolute = |name: &str| {
        env(name)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    absolute("HOME")
        .or_else(|| absolute("USERPROFILE"))
        .or_else(|| {
            // HOMEDRIVE is just `C:`, which is not absolute on its own, so join before checking.
            let drive = env("HOMEDRIVE")?;
            let directory = env("HOMEPATH")?;
            let joined = PathBuf::from(format!(
                "{}{}",
                drive.to_string_lossy(),
                directory.to_string_lossy()
            ));
            joined.is_absolute().then_some(joined)
        })
}

#[cfg(target_os = "macos")]
pub(super) fn claude_app_dir(home: &Path) -> Option<PathBuf> {
    Some(home.join("Library/Application Support/Claude"))
}

#[cfg(target_os = "windows")]
pub(super) fn claude_app_dir(_home: &Path) -> Option<PathBuf> {
    env_dir("APPDATA").map(|dir| dir.join("Claude"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn claude_app_dir(home: &Path) -> Option<PathBuf> {
    Some(
        env_dir("XDG_CONFIG_HOME")
            .unwrap_or_else(|| home.join(".config"))
            .join("Claude"),
    )
}

impl Roots {
    pub(super) fn resolve() -> Result<Self, String> {
        let home = home_dir().ok_or("home_unavailable")?;
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
    pub(super) fn session_dirs(&self, source: AgentSource) -> Vec<(PathBuf, usize)> {
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

pub(super) struct Candidate {
    pub(super) path: PathBuf,
    pub(super) modified: Option<SystemTime>,
    pub(super) len: u64,
}

pub(super) fn accepts_file(source: AgentSource, name: &str) -> bool {
    match source {
        AgentSource::Codex => name.starts_with("rollout-") && name.ends_with(".jsonl"),
        _ => name.ends_with(".jsonl"),
    }
}

/// Subdirectories of `dir`; symlinks are not followed.
pub(super) fn subdirectories(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect()
}

pub(super) fn name_starts_with(path: &Path, prefix: &str) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(prefix))
}

/// Cowork runs Claude Code with a private config folder per session:
/// `<root>/<org>/<account>/[agent/]local_<id>/.claude/projects/<slug>/<cli-session>.jsonl`.
pub(super) fn collect_cowork(root: &Path, out: &mut Vec<Candidate>) {
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
pub(super) fn cowork_storage(transcript: &Path) -> Option<&Path> {
    let projects = transcript.parent()?.parent()?;
    let config = projects.parent()?;
    let storage = config.parent()?;
    (projects.file_name()? == "projects"
        && config.file_name()? == ".claude"
        && name_starts_with(storage, "local_"))
    .then_some(storage)
}

/// Claude desktop lists its sessions through records naming the Claude Code transcript
/// (`cliSessionId`): the Code tab's at `claude-code-sessions/<account>/<org>/local_<id>.json`,
/// Cowork's at `local-agent-mode-sessions/<org>/<account>/[agent/]local_<id>.json`. Collects the
/// transcript ids and the titles the app shows.
pub(super) fn read_desktop_sessions(
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

pub(super) fn collect_files(
    source: AgentSource,
    dir: &Path,
    depth: usize,
    out: &mut Vec<Candidate>,
) {
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

pub(super) fn millis(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

pub(super) fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// WorkBuddy gives each task its own `~/WorkBuddy/YYYY-MM-DD-HH-MM-SS` folder.
pub(super) fn is_workbuddy_task_folder(dir: &Path, task_root: &Path) -> bool {
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
pub(super) enum Birth {
    Missing,
    At(i64),
    /// The path exists but the file system does not record creation times.
    Unknown,
}

pub(super) fn birth_time(path: &Path) -> Birth {
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
pub(super) struct CreationTimeUnavailable;

/// The project a session made by writing `file`: the outermost folder under the home folder
/// created after the session started (less `CREATION_GRACE_MS`). Folders the user already had,
/// hidden folders, `~/Library`, and new folders inside an existing repository or package are not
/// projects.
pub(super) fn project_root(
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
pub(super) fn session_project_roots(
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
pub(super) fn drop_nested(mut dirs: Vec<PathBuf>) -> Vec<PathBuf> {
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

/// What the sessions that made one project say about it; the earliest session names it.
pub(super) struct Found {
    pub(super) source: AgentSource,
    pub(super) created_at: Option<i64>,
    pub(super) title: Option<String>,
    pub(super) first_prompt: Option<String>,
    pub(super) employee_name: Option<String>,
    pub(super) model: Option<String>,
    pub(super) models: Vec<String>,
    pub(super) seeded: bool,
}

impl Found {
    pub(super) fn new(source: AgentSource) -> Self {
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

    pub(super) fn merge(
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
    pub(super) fn refresh(&mut self, roots: &Roots) -> (Vec<SourceStatus>, Vec<ProjectSummary>) {
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
