use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use std::process::Command;

// Only these fixed portals can be opened; the webview passes a key, never a URL.
const PORTALS: &[(&str, &str)] = &[
    ("taiyi-ops", "http://121.40.78.201:8781/"),
    ("enterprise-admin", "http://121.40.78.201:8782/"),
    ("agent-user", "http://121.40.78.201:8783/"),
];

fn portal_url(key: &str) -> Option<&'static str> {
    PORTALS.iter().find(|(k, _)| *k == key).map(|(_, url)| *url)
}

#[tauri::command]
pub fn open_portal_in_browser(key: String) -> Result<(), String> {
    let url = portal_url(&key).ok_or_else(|| "未知的入口".to_string())?;
    open_url(url).map_err(|e| format!("无法拉起系统浏览器: {e}"))
}

/// 允许打开的外部平台主机。当前只有 ClawHub（技能导入时让用户查看来源页面）。
/// 精确主机名匹配，不接受任意 URL——与 `open_portal_in_browser` 的白名单风格一致。
const EXTERNAL_HOSTS: &[&str] = &["clawhub.ai", "www.clawhub.ai"];

/// 打开外部平台页面。只放行 https + 明确的主机白名单，避免把「打开浏览器」变成任意 URL 执行。
#[tauri::command]
pub fn open_external_url(raw: String) -> Result<(), String> {
    let host = host_of(&raw).ok_or_else(|| "地址格式不对".to_string())?;
    if !raw.starts_with("https://") {
        return Err("只允许打开 https 地址".to_string());
    }
    if !EXTERNAL_HOSTS.contains(&host.as_str()) {
        return Err("不允许打开该站点".to_string());
    }
    open_url(raw.as_str()).map_err(|e| format!("无法拉起系统浏览器: {e}"))
}

/** 从 `https://host[:port]/...` 里取小写主机名；格式不对返回 None。 */
fn host_of(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("https://")?;
    // 主机在第一个 /、?、# 之前；端口用 ':' 切掉。
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if host.is_empty() || host.contains(' ') {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

/// 在文件管理器中显示本机技能目录。只允许显示 Agent 数据目录之内的路径——
/// 前端传什么就显示什么会把「文件管理器」变成任意目录遍历入口。
/// 根目录由 Rust 侧从 `app_data_dir` 推导，不接受前端传值。
#[tauri::command]
pub fn reveal_in_file_manager(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| "应用数据目录不可用".to_string())?
        .join("agent-data");
    let root = data_root.as_path();
    let target = PathBuf::from(&path);
    if !is_within(root, &target) {
        return Err("只能显示本应用的技能目录".to_string());
    }
    let resolved = target
        .canonicalize()
        .map_err(|_| "目录不存在".to_string())?;
    // 字符串层面的包含挡不住 agent-data 内的符号链接：先 canonicalize 再判一次，避免绕出目录。
    let resolved_root = root.canonicalize().map_err(|_| "应用数据目录不可用".to_string())?;
    if !is_within(&resolved_root, &resolved) {
        return Err("只能显示本应用的技能目录".to_string());
    }
    if !resolved.is_dir() {
        return Err("这不是一个目录".to_string());
    }
    reveal(&resolved).map_err(|e| format!("无法打开文件管理器: {e}"))
}

fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ())
}

fn reveal(path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(path).spawn();
    #[cfg(target_os = "windows")]
    // `/select,` 会在资源管理器中定位到该目录本身。
    let result = Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    // Linux 没有「定位到目录」的通用参数，退化为打开父目录。
    let result = match path.parent() {
        Some(parent) => Command::new("xdg-open").arg(parent).spawn(),
        None => Command::new("xdg-open").arg(path).spawn(),
    };
    result.map(|_| ())
}

/// `target` 是否位于 `root` 之内（含等于）。用规范化后的路径做组件级比较，
/// 不允许 `..` 越出，也不被符号链接之外的字符串技巧绕过。
fn is_within(root: &Path, target: &Path) -> bool {
    let norm = |p: &Path| -> Option<PathBuf> {
        let mut out = PathBuf::new();
        for part in p.components() {
            match part {
                Component::Prefix(_) | Component::RootDir => out.push(part.as_os_str()),
                Component::CurDir => {}
                Component::ParentDir => return None,
                Component::Normal(segment) => out.push(segment),
            }
        }
        Some(out)
    };
    let root = match norm(root) { Some(v) => v, None => return false };
    let target = match norm(target) { Some(v) => v, None => return false };
    target.starts_with(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_portals_resolve() {
        assert_eq!(portal_url("agent-user"), Some("http://121.40.78.201:8783/"));
        assert_eq!(portal_url("http://evil.example/"), None);
    }

    #[test]
    fn only_allowed_hosts_and_https_are_opened() {
        let cases = [
            ("https://clawhub.ai/pskoett/skills/x", true),
            ("https://www.clawhub.ai/skills/x", true),
            ("https://CLAWHUB.AI/skills/x", true),
            ("http://clawhub.ai/skills/x", false),
            ("https://evil.example/skills/x", false),
            ("https://clawhub.ai.evil.example/skills/x", false),
            ("不是网址", false),
        ];
        for (raw, expected) in cases {
            let ok = raw.starts_with("https://")
                && host_of(raw).is_some_and(|h| EXTERNAL_HOSTS.contains(&h.as_str()));
            assert_eq!(ok, expected, "{raw}");
        }
    }

    #[test]
    fn reveal_stays_inside_the_agent_data_dir() {
        let root = Path::new("/tmp/agent-data");
        assert!(is_within(root, Path::new("/tmp/agent-data/custom-skills/weekly-report")));
        assert!(is_within(root, Path::new("/tmp/agent-data")));
        assert!(!is_within(root, Path::new("/tmp/agent-data/../secret")));
        assert!(!is_within(root, Path::new("/tmp/other")));
        assert!(!is_within(root, Path::new("/tmp/agent-data-evil")));
    }
}
