//! Packaged macOS Agent lifecycle. The child owns its database and chooses its port.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Default)]
pub struct AgentState(Mutex<Runtime>);

#[derive(Default)]
struct Runtime {
    child: Option<Child>,
    result: Option<Result<String, String>>,
    // An OS lock is released on crash as well as normal exit; never delete its file.
    instance_lock: Option<File>,
    agent_dir: Option<PathBuf>,
    root: Option<PathBuf>,
}

fn acquire_instance_lock(root: &Path) -> Result<File, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("desktop.lock"))
        .map_err(|e| e.to_string())?;
    // SAFETY: file owns a valid descriptor and remains alive for the app lifetime.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("AIFred 已在运行，请使用已打开的窗口".into());
    }
    Ok(file)
}

fn copy_config_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_config_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn prepare_config(agent: &Path, root: &Path) -> Result<PathBuf, String> {
    // Explicit host configuration wins; keep relative JWKS paths beside that file.
    if let Some(path) = std::env::var_os("AITEAM_AGENT_CONFIG") {
        return fs::canonicalize(path).map_err(|e| format!("AITEAM_AGENT_CONFIG: {e}"));
    }
    let custom = root.join("agent.env");
    if custom.is_file() {
        return Ok(custom);
    }
    // A new package gets a fresh matching env/JWKS pair, without touching agent-data
    // or overwriting an administrator's agent.env override.
    let manifest = fs::read(agent.join("manifest.json")).map_err(|e| e.to_string())?;
    let revision = hex::encode(Sha256::digest(manifest));
    let destination = root.join("agent-config").join(revision);
    if !destination.exists() {
        let staging = root
            .join("agent-config")
            .join(uuid::Uuid::new_v4().to_string());
        copy_config_tree(&agent.join("config"), &staging).map_err(|e| e.to_string())?;
        fs::rename(staging, &destination).map_err(|e| e.to_string())?;
    }
    Ok(destination.join("agent.env"))
}

/// Enterprise public configuration is mandatory for a production Agent. Detect the
/// shipped template (placeholder Manager URL, empty public keys) before spending 30s
/// on a launch that the bundled Agent is guaranteed to refuse.
fn incomplete_enterprise_config(path: &Path) -> Option<(&'static str, &'static str)> {
    let text = fs::read_to_string(path).ok()?;
    let mut production = false;
    let mut jwks = false;
    let mut skill = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        match key.trim() {
            "AITEAM_ENV" => production = value == "production",
            "AITEAM_AGENT_JWKS_JSON" | "AITEAM_AGENT_JWKS_PATH" => jwks |= !value.is_empty(),
            "AITEAM_SKILL_SIGNING_PUBLIC_KEY" | "AITEAM_SKILL_SIGNING_PUBLIC_KEYS" => {
                skill |= !value.is_empty()
            }
            _ => {}
        }
    }
    if !production {
        return None;
    }
    match (jwks, skill) {
        (true, true) => None,
        (false, false) => Some((
            "missing_jwks_and_skill_key",
            "缺少 AITEAM_AGENT_JWKS_PATH/JSON 企业公共 JWKS 与 AITEAM_SKILL_SIGNING_PUBLIC_KEY 技能验签公钥",
        )),
        (false, true) => Some(("missing_jwks", "缺少 AITEAM_AGENT_JWKS_PATH/JSON 企业公共 JWKS")),
        (true, false) => Some((
            "missing_skill_key",
            "缺少 AITEAM_SKILL_SIGNING_PUBLIC_KEY 技能验签公钥",
        )),
    }
}

fn launch(agent: &Path, root: &Path, log: &Path) -> Result<Child, String> {
    if !agent.join("config/agent.env").is_file() || !agent.join("runtime/node").is_file() {
        return Err("未安装新版本机 Agent 包及企业公共配置".into());
    }
    let config = prepare_config(agent, root)?;
    if let Some((code, reason)) = incomplete_enterprise_config(&config) {
        // Fail fast with an actionable configuration error instead of an opaque
        // 30s health timeout that never reaches the port file.
        crate::diagnostics::host_event_fields(
            root,
            "agent.config_incomplete",
            "error",
            serde_json::json!({ "code": code }),
        );
        return Err(format!(
            "本机 Agent 企业公共配置不完整：{reason}。请补全 agent.env 及其配套公钥文件后重新启动应用。"
        ));
    }
    let data = root.join("agent-data");
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    if log.exists() {
        fs::rename(log, log.with_extension("previous.log")).map_err(|e| e.to_string())?;
    }
    crate::diagnostics::host_event(root, "agent.starting", "info");
    let mut command = Command::new(agent.join("runtime/node"));
    command.env_clear();
    for key in ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    if let Some(channel) = crate::local_directory_host::config() {
        command.env("AITEAM_LOCAL_HOST_SOCKET", channel.socket);
        command.env("AITEAM_LOCAL_HOST_TOKEN", channel.token);
    }
    command
        .arg("--import")
        .arg(agent.join("node_modules/tsx/dist/esm/index.mjs"))
        .arg(agent.join("bin/start-agent.mjs"))
        .arg("--config")
        .arg(config)
        .args(["--host", "127.0.0.1", "--port", "0"])
        .arg("--data-dir")
        .arg(data)
        .current_dir(agent)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动随包 Node runtime: {e}"))?;
    if let Some(stdout) = child.stdout.take() {
        crate::diagnostics::capture_child(stdout, log.to_path_buf());
    }
    if let Some(stderr) = child.stderr.take() {
        crate::diagnostics::capture_child(stderr, log.to_path_buf());
    }
    Ok(child)
}

#[derive(Deserialize)]
struct PortFile {
    schema_version: u32,
    pid: u32,
    host: String,
    port: u16,
}

fn read_agent_url(path: &Path, pid: u32) -> Option<String> {
    let file: PortFile = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    // The launcher is explicitly bound to IPv4 loopback. Do not accept stale ports,
    // another process's file, remote hosts, redirects or a wildcard listen address.
    if file.schema_version != 1 || file.pid != pid || file.host != "127.0.0.1" || file.port == 0 {
        return None;
    }
    Some(format!("http://127.0.0.1:{}", file.port))
}

async fn wait_until_ready(
    state: &AgentState,
    port_file: &Path,
    root: &Path,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut last_observation = String::from("尚未生成 agent-port.json");
    while Instant::now() < deadline {
        let pid = {
            let mut runtime = state.0.lock().unwrap();
            let child = runtime.child.as_mut().ok_or("Agent 已停止")?;
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                let mut fields = serde_json::Map::new();
                if let Some(code) = status.code() {
                    fields.insert("exit_code".into(), serde_json::json!(code));
                }
                crate::diagnostics::host_event_fields(
                    root,
                    "agent.exited_early",
                    "error",
                    serde_json::Value::Object(fields),
                );
                return Err(format!(
                    "Agent 启动失败（{status}），请检查日志、agent.env 配置及本地 sandbox 是否可用"
                ));
            }
            child.id()
        };
        if let Some(url) = read_agent_url(port_file, pid) {
            let health = client.get(format!("{url}/healthz")).send().await;
            if !health
                .as_ref()
                .is_ok_and(|res| res.status() == reqwest::StatusCode::OK)
            {
                last_observation = match health {
                    Ok(res) => format!("已发现端口 {url}，但 /healthz 返回 HTTP {}", res.status()),
                    Err(error) => format!("已发现端口 {url}，但 /healthz 请求失败: {error}"),
                };
            } else {
                if let Ok(res) = client.get(format!("{url}/readyz")).send().await {
                    if res.status() == reqwest::StatusCode::OK {
                        if let Ok(body) = res.json::<serde_json::Value>().await {
                            if body["data"]["ready"] == true {
                                let contract: serde_json::Value = client
                                    .get(format!("{url}/openapi.json"))
                                    .send()
                                    .await
                                    .map_err(|_| "无法核对本机 Agent API 契约")?
                                    .error_for_status()
                                    .map_err(|_| "本机 Agent 缺少 API 契约")?
                                    .json()
                                    .await
                                    .map_err(|_| "本机 Agent API 契约无效")?;
                                for path in [
                                    "/api/agent/conversations/{conversation_id}/participants",
                                    "/api/agent/messages/search",
                                    "/api/agent/work-records",
                                    "/api/agent/work-records/changes",
                                    "/api/agent/usage/statistics",
                                ] {
                                    if contract["paths"][path]["get"].is_null() {
                                        return Err(
                                            "本机 Agent 版本过旧，请安装包含 macOS 三端接口的新包"
                                                .into(),
                                        );
                                    }
                                }
                                return Ok(url);
                            }
                            last_observation = "/readyz 返回 ready=false".into();
                        } else {
                            last_observation = "/readyz 返回无效 JSON".into();
                        }
                    } else {
                        last_observation = format!("/readyz 返回 HTTP {}", res.status());
                    }
                } else {
                    last_observation = "/readyz 请求失败".into();
                }
            }
        } else if port_file.exists() {
            last_observation = "agent-port.json 存在但内容无效或 PID/地址不匹配".into();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Err(format!(
        "Agent 启动超时，未通过 healthz / readyz 检查；最后状态：{last_observation}"
    ))
}

impl Runtime {
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let group = -(child.id() as i32);
            // SAFETY: the child was spawned in its own process group. Stop its
            // sandbox/tool descendants too, without signalling any other app.
            unsafe {
                libc::kill(group, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            unsafe {
                libc::kill(group, libc::SIGKILL);
            }
            let _ = child.wait();
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = app.path().app_data_dir()?;
    let instance_lock = acquire_instance_lock(&root).map_err(std::io::Error::other)?;
    let state = app.state::<AgentState>();
    state.0.lock().unwrap().instance_lock = Some(instance_lock);
    let agent = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent")
    } else {
        app.path().resource_dir()?.join("agent")
    };
    {
        let mut runtime = state.0.lock().unwrap();
        runtime.agent_dir = Some(agent.clone());
        runtime.root = Some(root.clone());
    }
    if let Err(error) = crate::local_directory_host::start(app.handle().clone()) {
        crate::diagnostics::host_event_fields(
            &root,
            "agent.local_directory_host_unavailable",
            "warn",
            serde_json::json!({ "reason": error }),
        );
    }
    let log = root.join("agent.log");
    match launch(&agent, &root, &log) {
        Ok(child) => state.0.lock().unwrap().child = Some(child),
        Err(error) => {
            crate::diagnostics::host_event(&root, "agent.launch_failed", "error");
            state.0.lock().unwrap().result = Some(Err(error));
            return Ok(());
        }
    }
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AgentState>();
        let result = wait_until_ready(&state, &root.join("agent-data/agent-port.json"), &root)
            .await
            .map_err(|error| {
                format!(
                    "{error}\n日志：{}\n自定义配置：{}",
                    log.display(),
                    root.join("agent.env").display()
                )
            });
        crate::diagnostics::host_event(
            &root,
            if result.is_ok() {
                "agent.ready"
            } else {
                "agent.readiness_failed"
            },
            if result.is_ok() { "info" } else { "error" },
        );
        let mut runtime = state.0.lock().unwrap();
        if result.is_err() {
            runtime.stop();
        }
        runtime.result = Some(result);
    });
    Ok(())
}

pub async fn get_agent_base_url(state: tauri::State<'_, AgentState>) -> Result<String, String> {
    loop {
        let restart = {
            let mut runtime = state.0.lock().unwrap();
            let exited = if matches!(runtime.result, Some(Ok(_))) {
                match runtime.child.as_mut() {
                    Some(child) => child.try_wait().map_err(|e| e.to_string())?.is_some(),
                    None => true,
                }
            } else {
                false
            };
            if exited {
                let agent = runtime.agent_dir.clone().ok_or("Agent 资源目录未初始化")?;
                let root = runtime.root.clone().ok_or("Agent 数据目录未初始化")?;
                runtime.stop();
                match launch(&agent, &root, &root.join("agent.log")) {
                    Ok(child) => {
                        runtime.child = Some(child);
                        runtime.result = None;
                    }
                    Err(error) => {
                        runtime.result = Some(Err(error.clone()));
                        return Err(error);
                    }
                }
                Some(root)
            } else {
                if let Some(result) = &runtime.result {
                    return result.clone();
                }
                None
            }
        };
        if let Some(root) = restart {
            let result =
                wait_until_ready(&state, &root.join("agent-data/agent-port.json"), &root).await;
            let mut runtime = state.0.lock().unwrap();
            if result.is_err() {
                runtime.stop();
            }
            runtime.result = Some(result.clone());
            return result;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub fn stop(app: &tauri::AppHandle) {
    if let Ok(root) = app.path().app_data_dir() {
        crate::diagnostics::host_event(&root, "agent.stopping", "info");
    }
    let state = app.state::<AgentState>();
    let mut runtime = state.0.lock().unwrap();
    runtime.result = Some(Err("Agent 已停止".into()));
    runtime.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("aiteam-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_env(root: &Path, body: &str) -> PathBuf {
        let path = root.join("agent.env");
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn detects_incomplete_enterprise_configuration() {
        let root = temporary_root("config");
        let missing_both =
            "AITEAM_ENV=production\nAITEAM_AGENT_JWKS_JSON=\nAITEAM_SKILL_SIGNING_PUBLIC_KEY=\n";
        assert_eq!(
            incomplete_enterprise_config(&write_env(&root, missing_both)).map(|(code, _)| code),
            Some("missing_jwks_and_skill_key")
        );
        let missing_jwks = "AITEAM_ENV=production\nAITEAM_SKILL_SIGNING_PUBLIC_KEY=abc\n";
        assert_eq!(
            incomplete_enterprise_config(&write_env(&root, missing_jwks)).map(|(code, _)| code),
            Some("missing_jwks")
        );
        let missing_skill = "AITEAM_ENV=production\nAITEAM_AGENT_JWKS_PATH=manager-jwks.json\n";
        assert_eq!(
            incomplete_enterprise_config(&write_env(&root, missing_skill)).map(|(code, _)| code),
            Some("missing_skill_key")
        );
        let complete = "AITEAM_ENV=production\nAITEAM_AGENT_JWKS_JSON={\"keys\":[]}\nAITEAM_SKILL_SIGNING_PUBLIC_KEYS=[]\n";
        assert!(incomplete_enterprise_config(&write_env(&root, complete)).is_none());
        // Test/development packages legitimately run without enterprise public keys.
        let test = "AITEAM_ENV=test\nAITEAM_AGENT_DEV_AUTH=true\n";
        assert!(incomplete_enterprise_config(&write_env(&root, test)).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_an_unconfigured_package_before_launching_node() {
        // A synthetic package keeps this test meaningful regardless of whether the
        // repository's bundled Agent currently carries an enterprise config.
        let agent = temporary_root("template-package");
        fs::create_dir_all(agent.join("config")).unwrap();
        fs::create_dir_all(agent.join("runtime")).unwrap();
        fs::write(
            agent.join("config/agent.env"),
            "AITEAM_ENV=production\nAITEAM_MANAGER_URL=https://manager.example.com\nAITEAM_AGENT_JWKS_JSON=\nAITEAM_SKILL_SIGNING_PUBLIC_KEY=\n",
        )
        .unwrap();
        // A non-executable placeholder proves the refusal happens before spawning.
        fs::write(agent.join("runtime/node"), "not-executed").unwrap();
        fs::write(
            agent.join("manifest.json"),
            "{\"target\":\"darwin-arm64\"}\n",
        )
        .unwrap();

        let root = temporary_root("config-refusal");
        let error = launch(&agent, &root, &root.join("agent.log"))
            .expect_err("a template package must be refused");
        // The client maps these keywords to a configuration failure instead of a timeout.
        assert!(
            error.contains("公共配置") && error.contains("JWKS"),
            "{error}"
        );
        let log = fs::read_to_string(root.join("logs/desktop.jsonl")).unwrap();
        assert!(log.contains("agent.config_incomplete"), "{log}");
        assert!(!log.contains("manager.example.com"), "{log}");
        assert!(!root.join("agent-data").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(agent).unwrap();
    }

    #[test]
    fn rejects_stale_and_untrusted_port_files() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("agent-port.json");
        for value in [
            r#"{"schema_version":1,"pid":8,"host":"127.0.0.1","port":53124}"#,
            r#"{"schema_version":1,"pid":7,"host":"0.0.0.0","port":53124}"#,
            r#"{"schema_version":1,"pid":7,"host":"remote.example","port":53124}"#,
            r#"{"schema_version":1,"pid":7,"host":"127.0.0.1","port":0}"#,
            r#"{"schema_version":1,"pid":7,"host":"127.0.0.1","port":65536}"#,
            "{",
        ] {
            fs::write(&path, value).unwrap();
            assert!(read_agent_url(&path, 7).is_none());
        }
        fs::write(
            &path,
            r#"{"schema_version":1,"pid":7,"host":"127.0.0.1","port":53124}"#,
        )
        .unwrap();
        assert_eq!(
            read_agent_url(&path, 7).as_deref(),
            Some("http://127.0.0.1:53124")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn instance_lock_is_exclusive_and_released() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let first = acquire_instance_lock(&root).unwrap();
        assert!(acquire_instance_lock(&root).is_err());
        drop(first);
        drop(acquire_instance_lock(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "starts the packaged runtime and macOS sandbox; run with --ignored --nocapture"]
    fn packaged_agent_smoke() {
        let agent = std::env::var_os("AITEAM_SMOKE_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent"));
        smoke(agent);
    }

    #[test]
    #[ignore = "requires a built ARM64 AIFred.app; run with --ignored --nocapture"]
    fn bundled_agent_smoke() {
        smoke(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "target/aarch64-apple-darwin/release/bundle/macos/AIFred.app/Contents/Resources/agent",
        ));
    }

    #[test]
    #[ignore = "contacts the documented TEST Manager using a synthetic nonexistent account"]
    fn test_profile_startup_and_manager_connection() {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let root =
            std::env::temp_dir().join(format!("aiteam-test-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::copy(
            repository.join("../config/agent/taiyi-test.env"),
            root.join("agent.env"),
        )
        .unwrap();
        // agent.env references its public JWKS relative to itself.
        fs::copy(
            repository.join("../config/agent/taiyi-test-jwks.json"),
            root.join("taiyi-test-jwks.json"),
        )
        .unwrap();
        let state = AgentState::default();
        state.0.lock().unwrap().child = Some(
            launch(
                &repository.join("resources/agent"),
                &root,
                &root.join("agent.log"),
            )
            .unwrap(),
        );
        tauri::async_runtime::block_on(async {
            let result =
                wait_until_ready(&state, &root.join("agent-data/agent-port.json"), &root).await;
            if result.is_err() {
                eprintln!(
                    "{}",
                    fs::read_to_string(root.join("agent.log")).unwrap_or_default()
                );
            }
            let url = result.unwrap();
            println!("TEST profile: {url} passed healthz + readyz");
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap();
            let response = client
                .get(format!("{url}/api/agent/whoami"))
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                401,
                "requests without bearer must still be rejected"
            );
            // A unique nonexistent account is a read-only connectivity check.
            // A real Manager 404 proves forwarding worked; 503 would mean failure.
            let response = client.post(format!("{url}/api/auth/resolve-tenant-by-account"))
                .json(&serde_json::json!({"account": format!("desktop-probe-{}", uuid::Uuid::new_v4())}))
                .send().await.unwrap();
            assert_eq!(response.status(), 404);
            let body: serde_json::Value = response.json().await.unwrap();
            println!(
                "Manager account resolver reached: HTTP 404, code={}",
                body["code"]
            );
        });
        state.0.lock().unwrap().stop();
        assert!(!root.join("agent-data/agent-port.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn smoke(agent: PathBuf) {
        let root = std::env::temp_dir().join(format!("aiteam-smoke-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let state = AgentState::default();
        let log = root.join("agent.log");
        let port_file = root.join("agent-data/agent-port.json");

        // Public keys generated solely for this isolated smoke test. No Manager
        // login, development auth bypass or changes to the delivered config.
        let generated = Command::new(agent.join("runtime/node")).args(["-e", r#"
            const { generateKeyPairSync } = require('node:crypto');
            const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
            const ed = generateKeyPairSync('ed25519').publicKey;
            console.log(JSON.stringify({
              jwks: { keys: [{ ...rsa.export({format:'jwk'}), kid:'smoke-only', alg:'RS256', use:'sig' }] },
              skill: ed.export({type:'spki', format:'der'}).toString('base64')
            }));
        "#]).output().unwrap();
        assert!(generated.status.success());
        let keys: serde_json::Value = serde_json::from_slice(&generated.stdout).unwrap();
        fs::write(root.join("manager-jwks.json"), keys["jwks"].to_string()).unwrap();
        fs::write(root.join("agent.env"), format!(
            "AITEAM_ENV=production\nAITEAM_AGENT_LOCAL_ONLY=true\nAITEAM_AGENT_SANDBOX_READY=true\nAITEAM_MANAGER_URL=https://manager.example.com\nAITEAM_AGENT_JWT_ISSUER=https://manager.example.com\nAITEAM_AGENT_JWT_AUDIENCE=aiteam-agent\nAITEAM_AGENT_JWKS_PATH=manager-jwks.json\nAITEAM_SKILL_SIGNING_PUBLIC_KEY={}\nAITEAM_SKILL_SIGNING_KEY_ID=smoke-only\n",
            keys["skill"].as_str().unwrap()
        )).unwrap();
        for iteration in 0..2 {
            let child = launch(&agent, &root, &log).unwrap();
            let pid = child.id();
            state.0.lock().unwrap().child = Some(child);
            let result =
                tauri::async_runtime::block_on(wait_until_ready(&state, &port_file, &root));
            if result.is_err() {
                eprintln!(
                    "Smoke log: {}",
                    fs::read_to_string(&log).unwrap_or_default()
                );
            }
            assert!(
                result.is_ok(),
                "{result:?}; files retained at {}",
                root.display()
            );
            println!(
                "Launch {iteration}: {} passed healthz + readyz (pid {pid})",
                result.unwrap()
            );
            state.0.lock().unwrap().stop();
            assert!(
                !port_file.exists(),
                "graceful shutdown must remove agent-port.json"
            );
            assert_eq!(
                unsafe { libc::kill(pid as i32, 0) },
                -1,
                "child must be reaped"
            );
            // Use the bundled Node SQLite implementation; the desktop no longer
            // links a second SQLite runtime after the remote legacy cleanup.
            let script = if iteration == 0 {
                "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec(\"CREATE TABLE desktop_smoke (value TEXT); INSERT INTO desktop_smoke VALUES ('preserved');\"); db.close();"
            } else {
                "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); if(db.prepare('SELECT value FROM desktop_smoke').get().value !== 'preserved') process.exit(1); db.close();"
            };
            let result = Command::new(agent.join("runtime/node"))
                .args(["-e", script])
                .arg(root.join("agent-data/agent.sqlite"))
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "SQLite data must survive runtime restart"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
