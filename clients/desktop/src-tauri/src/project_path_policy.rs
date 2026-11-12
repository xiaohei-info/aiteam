use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const RAW_POLICY: &str = include_str!("../../../../shared/project-sensitive-paths.json");

#[derive(Debug, Deserialize)]
struct Policy {
    macos: PlatformPolicy,
    windows: PlatformPolicy,
}

#[derive(Debug, Deserialize)]
struct PlatformPolicy {
    home_roots: Vec<String>,
    system_roots: Vec<String>,
    #[serde(default)]
    short_names: std::collections::HashMap<String, Vec<String>>,
}

fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(RAW_POLICY).expect("invalid shared project path policy")
    })
}

fn normalized(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/").to_lowercase();
    if value.starts_with("//?/") {
        value = value[4..].to_string();
    }
    while value.len() > 1 && value.ends_with('/') {
        value.pop();
    }
    value
}

fn components(path: &Path) -> Vec<String> {
    normalized(path)
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

fn within(path: &Path, root: &Path) -> bool {
    let path = components(path);
    let root = components(root);
    path.len() >= root.len()
        && path
            .iter()
            .zip(root.iter())
            .all(|(left, right)| left == right)
}

fn exact(path: &Path, root: &Path) -> bool {
    normalized(path) == normalized(root)
}

fn windows_drive_root(home: &Path) -> PathBuf {
    let value = normalized(home);
    let prefix = value.split('/').next().unwrap_or("");
    if prefix.ends_with(':') {
        PathBuf::from(format!("{prefix}/"))
    } else {
        PathBuf::from("/")
    }
}

fn roots(policy: &PlatformPolicy, home: &Path, windows: bool) -> Vec<(PathBuf, bool)> {
    let mut result = policy
        .home_roots
        .iter()
        .map(|root| (home.join(root), false))
        .collect::<Vec<_>>();
    if windows {
        let drive = windows_drive_root(home);
        for root in &policy.system_roots {
            result.push((drive.join(root), false));
            if let Some(aliases) = policy.short_names.get(root) {
                result.extend(aliases.iter().map(|alias| (drive.join(alias), false)));
            }
        }
    } else {
        result.extend(
            policy
                .system_roots
                .iter()
                .map(|root| (PathBuf::from(root), root == "/")),
        );
    }
    result
}

fn sensitive_names(platform: &PlatformPolicy) -> std::collections::HashSet<String> {
    let mut names = platform
        .home_roots
        .iter()
        .filter_map(|root| root.rsplit(['/', '\\']).next())
        .map(str::to_lowercase)
        .collect::<std::collections::HashSet<_>>();
    for aliases in platform.short_names.values() {
        names.extend(aliases.iter().map(|alias| alias.to_lowercase()));
    }
    names
}

/// System roots from the shared policy. Platform hosts should add their own app/runtime roots separately.
pub fn system_protected_roots() -> Vec<PathBuf> {
    let platform = if cfg!(target_os = "windows") {
        &policy().windows
    } else {
        &policy().macos
    };
    platform
        .system_roots
        .iter()
        .filter(|root| root.as_str() != "/")
        .map(PathBuf::from)
        .collect()
}

/// Shared sensitive project-folder policy used by the desktop host and Agent.
/// Rejects a folder that is sensitive, is inside a sensitive tree, or contains one.
pub fn is_allowed_project_folder(path: &Path, home: &Path, runtime_roots: &[PathBuf]) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let windows = cfg!(target_os = "windows");
    let platform = if windows {
        &policy().windows
    } else {
        &policy().macos
    };
    let sensitive = sensitive_names(platform);
    if components(path).iter().any(|part| sensitive.contains(part)) {
        return false;
    }
    for (root, exact_only) in roots(platform, home, windows) {
        if (exact_only && exact(path, &root))
            || (!exact_only && (within(path, &root) || within(&root, path)))
        {
            return false;
        }
    }
    !runtime_roots
        .iter()
        .any(|root| within(path, root) || within(root, path))
}

#[cfg(test)]
mod tests {
    use super::is_allowed_project_folder;

    // The macOS table is selected for every non-Windows host, and its fixtures are POSIX-only:
    // `Path::is_absolute` rejects `/Users/alice` on Windows, where the Windows table applies.
    #[cfg(unix)]
    #[test]
    fn macos_policy_rejects_sensitive_trees_and_ancestors() {
        let home = std::path::Path::new("/Users/alice");
        let runtime = vec![std::path::PathBuf::from(
            "/Users/alice/Library/Application Support/AIFred",
        )];
        assert!(is_allowed_project_folder(
            std::path::Path::new("/Users/alice/Documents/app"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new("/Users/alice/.ssh"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new("/Users/alice/.ssh/keys"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new("/Users/alice"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new("/Users"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new("/"),
            home,
            &runtime
        ));
    }

    // Windows roots are drive-relative and also carry their 8.3 short names.
    #[cfg(windows)]
    #[test]
    fn windows_policy_rejects_sensitive_trees_and_short_names() {
        let home = std::path::Path::new(r"C:\Users\alice");
        let runtime = vec![std::path::PathBuf::from(r"C:\Users\alice\Work")];
        assert!(is_allowed_project_folder(
            std::path::Path::new(r"C:\Users\alice\Documents\app"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new(r"C:\Users\alice\.ssh"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new(r"C:\Users\alice\.ssh\keys"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new(r"C:\Windows\System32"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new(r"C:\WINDOW~1\System32"),
            home,
            &runtime
        ));
        assert!(!is_allowed_project_folder(
            std::path::Path::new(r"C:\Users\alice"),
            home,
            &runtime
        ));
    }
}
