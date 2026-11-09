//! Fred's managed workspace folders, addressed only by validated keys.

use super::*;

/// Longest segment of a workspace key, in characters; same as the Agent's rule.
const MAX_KEY_SEGMENT_CHARS: usize = 128;

/// Fred's `workspace_key`: the folder's path below `workspaces/`. One segment for a private chat or
/// a group's shared folder (`<会话名>-<短 ID>`, or a legacy `conversation-<24 hex>`), two for a
/// private chat that changed employee (`<会话名>-<短 ID>/<员工名>`). No segment starts with a dot or holds a separator or control
/// character, so a key never leaves the root. Mirrors `WORKSPACE_KEY_PATTERN` in the Agent.
pub(super) fn valid_workspace_key(key: &str) -> bool {
    let segments: Vec<&str> = key.split('/').collect();
    (1..=2).contains(&segments.len()) && segments.iter().all(|segment| valid_key_segment(segment))
}

fn valid_key_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with('.')
        && segment.chars().count() <= MAX_KEY_SEGMENT_CHARS
        && !segment
            .chars()
            .any(|ch| ch == '/' || ch == '\\' || ch.is_ascii_control())
}

/// Fred's managed workspace folder for `key`, if it exists as a real folder. Each level is
/// checked without following links, so a linked conversation folder never resolves.
pub(super) fn fred_workspace(root: &Path, key: &str) -> Result<Option<PathBuf>, String> {
    if !valid_workspace_key(key) {
        return Err("invalid_workspace_key".into());
    }
    let mut dir = root.to_path_buf();
    for segment in key.split('/') {
        dir.push(segment);
        if !std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            return Ok(None);
        }
    }
    Ok(Some(dir))
}

/// Lists the Fred workspaces `keys` names, newest first as given. The host alone decides how
/// many are listed; the rest are reported as `truncated` so the page can say so.
pub(super) fn list_fred_workspaces(
    root: &Path,
    keys: &[String],
) -> Result<FredWorkspaceList, String> {
    list_fred_workspaces_up_to(root, keys, MAX_FRED_WORKSPACES)
}

pub(super) fn list_fred_workspaces_up_to(
    root: &Path,
    keys: &[String],
    limit: usize,
) -> Result<FredWorkspaceList, String> {
    let mut seen = HashSet::new();
    let mut workspaces = Vec::new();
    let mut truncated = false;
    for key in keys {
        let Some(dir) = fred_workspace(root, key)? else {
            continue;
        };
        if !seen.insert(key.as_str()) {
            continue;
        }
        if workspaces.len() == limit {
            truncated = true;
            break;
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
    Ok(FredWorkspaceList {
        workspaces,
        truncated,
    })
}

/// Fred's managed workspaces: `<app data>/agent-data/workspaces`, as the bundled Agent uses.
pub(super) fn fred_workspace_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("agent-data").join("workspaces"))
        .map_err(|_| "data_dir_unavailable".into())
}
