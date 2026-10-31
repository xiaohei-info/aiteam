use serde_json::Value;
use urlpattern::{UrlPattern, UrlPatternInit, UrlPatternMatchInput};

// HTTP scope entries are deserialized together on the first native request.
// A malformed entry (including an unused IPv6 entry) breaks every request.
// Use the same engine and normalization as tauri-plugin-http's scope parser.
fn configured_patterns() -> Vec<UrlPattern> {
    let capability: Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|permission| {
            permission["identifier"]
                .as_str()
                .is_some_and(|id| id.starts_with("http:"))
        })
        .flat_map(|permission| permission["allow"].as_array().unwrap())
        .map(|entry| {
            let scope = entry["url"].as_str().unwrap();
            let mut init = UrlPatternInit::parse_constructor_string::<regex::Regex>(scope, None)
                .unwrap_or_else(|error| panic!("invalid HTTP scope {scope}: {error}"));
            for component in [&mut init.search, &mut init.hash] {
                if component.as_ref().is_none_or(|value| value.is_empty()) {
                    *component = Some("*".into());
                }
            }
            if init
                .pathname
                .as_ref()
                .is_none_or(|p| p.is_empty() || p == "/")
            {
                init.pathname = Some("*".into());
            }
            UrlPattern::parse(init, Default::default())
                .unwrap_or_else(|error| panic!("invalid HTTP scope {scope}: {error}"))
        })
        .collect()
}

#[test]
fn http_scope_accepts_dynamic_agent_ports_and_auth_routes() {
    let patterns = configured_patterns();
    for port in [8180, 53124, 64400, 65535] {
        for path in [
            "/healthz",
            "/readyz",
            "/api/auth/resolve-tenant-by-account",
            "/api/agent/login",
            "/api/agent/conversations/test/events?after=cursor",
        ] {
            let url: reqwest::Url = format!("http://127.0.0.1:{port}{path}").parse().unwrap();
            assert!(patterns.iter().any(|pattern| pattern
                .test(UrlPatternMatchInput::Url(url.clone()))
                .unwrap()));
        }
    }
}

#[test]
fn http_scope_accepts_documented_backend_routes() {
    let patterns = configured_patterns();
    for path in [
        "/api/agent/org/tree",
        "/api/agent/marketplace/templates",
        "/api/agent/knowledge-bases",
        "/api/auth/resolve-tenant-by-account",
        // Capability probes (group editing, custom groups, local directories) read the service contract.
        "/openapi.json",
    ] {
        let url: reqwest::Url = format!("http://121.40.78.201:8783{path}").parse().unwrap();
        assert!(patterns.iter().any(|pattern| pattern
            .test(UrlPatternMatchInput::Url(url.clone()))
            .unwrap()));
    }
}

#[test]
fn http_scope_keeps_unconfigured_origins_denied() {
    let patterns = configured_patterns();
    for address in [
        "http://121.40.78.201:8782/api/agent/login",
        "http://121.40.78.201:8782/api/operator/tenants",
        "http://121.40.78.201:8781/api/operator/tenants",
        "http://192.168.1.2:64400/api/agent/login",
        "https://untrusted.example/api/agent/login",
    ] {
        let url: reqwest::Url = address.parse().unwrap();
        assert!(!patterns.iter().any(|pattern| pattern
            .test(UrlPatternMatchInput::Url(url.clone()))
            .unwrap()));
    }
}
