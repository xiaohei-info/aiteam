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
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(url).spawn();
    result
        .map(|_| ())
        .map_err(|e| format!("无法拉起系统浏览器: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_portals_resolve() {
        assert_eq!(portal_url("agent-user"), Some("http://121.40.78.201:8783/"));
        assert_eq!(portal_url("http://evil.example/"), None);
    }
}
