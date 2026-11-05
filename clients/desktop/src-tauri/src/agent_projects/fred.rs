//! Fred's managed workspace folders, addressed only by validated keys.

use super::*;

/// Fred's managed workspace folder name: `conversation-<24 hex>`.
pub(super) fn valid_workspace_key(key: &str) -> bool {
    key.strip_prefix("conversation-").is_some_and(|hex| {
        hex.len() == 24
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// Fred's managed workspace folder for `key`, if it exists as a real folder.
pub(super) fn fred_workspace(root: &Path, key: &str) -> Result<Option<PathBuf>, String> {
    if !valid_workspace_key(key) {
        return Err("invalid_workspace_key".into());
    }
    let dir = root.join(key);
    Ok(std::fs::symlink_metadata(&dir)
        .is_ok_and(|meta| meta.is_dir())
        .then_some(dir))
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
