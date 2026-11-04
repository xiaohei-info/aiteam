//! The files of a project folder: listing, name and README summary, preview and opening them
//! with the system.

use super::*;

/// A small regular file as text; symlinks are not followed.
pub(crate) fn read_small(path: &Path, max: u64) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    String::from_utf8(std::fs::read(path).ok()?).ok()
}

pub(super) fn is_sensitive_stem(stem: &str) -> bool {
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

/// Opaque, stable id for a path (64-bit FNV-1a), so the WebView never sends paths.
pub(crate) fn file_id(path: &str) -> String {
    let hash = path.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")
}

pub(super) fn valid_file_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) struct Listing {
    pub(super) files: Vec<ProjectFile>,
    pub(super) truncated: bool,
}

impl Listing {
    pub(super) fn updated_at(&self) -> Option<i64> {
        self.files.iter().filter_map(|file| file.modified_at).max()
    }
}

/// `path` relative to `root`, `/`-separated; `None` for anything but plain UTF-8 names.
pub(super) fn relative_path(root: &Path, path: &Path) -> Option<String> {
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

pub(super) fn list_project(root: &Path, limit: usize) -> Listing {
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
                if IGNORED_DIRS.contains(&name)
                    || (name == BUILD_OUTPUT_DIR && dir.join("package.json").is_file())
                {
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
pub(super) struct ProjectInfo {
    pub(super) name: Option<String>,
    pub(super) description: Option<String>,
}

pub(super) fn package_name(text: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    str_field(&value, "name").map(|name| truncate_chars(&name, MAX_TITLE_CHARS))
}

/// `name` of `[project]` or `[tool.poetry]` in a `pyproject.toml`.
pub(super) fn pyproject_name(text: &str) -> Option<String> {
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
pub(super) fn readme_summary(text: &str) -> Option<String> {
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

pub(super) fn readme_file(dir: &Path) -> Option<PathBuf> {
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

pub(super) fn project_info(dir: &Path) -> ProjectInfo {
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

/// The listed file with `file_id` in the project folder, found by listing it again.
pub(super) fn find_project_file(
    root: &Path,
    file_id: &str,
) -> Result<(PathBuf, ProjectFile), String> {
    let file = list_project(root, MAX_PROJECT_FILES)
        .files
        .into_iter()
        .find(|file| file.id == file_id)
        .ok_or("file_not_found")?;
    Ok((root.join(&file.path), file))
}

pub(super) fn read_project_file_at(
    root: &Path,
    file_id: &str,
) -> Result<ProjectFileContent, String> {
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
pub(super) fn system_open_command(path: &Path, reveal: bool) -> std::process::Command {
    let mut command = std::process::Command::new("open");
    if reveal {
        command.arg("-R");
    }
    command.arg(path);
    command
}

#[cfg(target_os = "windows")]
pub(super) fn system_open_command(path: &Path, reveal: bool) -> std::process::Command {
    let mut command = std::process::Command::new("explorer");
    if reveal {
        command.arg("/select,");
    }
    command.arg(path);
    command
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn system_open_command(path: &Path, reveal: bool) -> std::process::Command {
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
pub(super) fn open_project_path(
    root: &Path,
    file_id: Option<&str>,
    reveal: bool,
) -> Result<(), String> {
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
