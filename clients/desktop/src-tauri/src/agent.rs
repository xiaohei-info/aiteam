//! Packaged Agent lifecycle (macOS ARM64 and Windows x64). The child owns its database and chooses its port.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::{fs::OpenOptionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const RUNTIME: &str = if cfg!(windows) {
    "runtime/node.exe"
} else {
    "runtime/node"
};

#[derive(Default)]
pub struct AgentState(Mutex<Runtime>);

#[derive(Default)]
struct Runtime {
    child: Option<Child>,
    #[cfg(windows)]
    job: Option<job::Job>,
    result: Option<Result<String, String>>,
    instance_lock: Option<File>,
    agent_dir: Option<PathBuf>,
    root: Option<PathBuf>,
}

#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    impl Job {
        pub fn adopt(child: &Child) -> Option<Job> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let job = Job(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 || AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0
                {
                    return None;
                }
                Some(job)
            }
        }
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(unix)]
fn acquire_instance_lock(root: &Path) -> Result<File, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("desktop.lock"))
        .map_err(|e| e.to_string())?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("AIFred 已在运行，请使用已打开的窗口".into());
    }
    Ok(file)
}

#[cfg(windows)]
fn acquire_instance_lock(root: &Path) -> Result<File, String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("无法创建实例锁目录 {}：{error}", root.display()))?;
    let lock_path = root.join("desktop.lock");
    match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&lock_path)
    {
        Ok(file) => Ok(file),
        Err(error) => {
            // `share_mode(0)` makes this open fail with ERROR_SHARING_VIOLATION only when another
            // AIFred already holds the lock. Every other failure is a real environment problem
            // (permissions, path, disk) and must not be reported as "already running".
            const ERROR_SHARING_VIOLATION: i32 = 32;
            if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) {
                Err("AIFred 已在运行，请使用已打开的窗口".into())
            } else {
                Err(format!(
                    "无法创建或打开实例锁 {}：{error}",
                    lock_path.display()
                ))
            }
        }
    }
}

#[cfg(windows)]
fn import_specifier(path: &Path) -> OsString {
    url::Url::from_file_path(path)
        .map(|u| OsString::from(u.as_str()))
        .unwrap_or_else(|_| path.as_os_str().to_owned())
}
#[cfg(not(windows))]
fn import_specifier(path: &Path) -> OsString {
    path.as_os_str().to_owned()
}

const INHERITED_ENV: &[&str] = if cfg!(windows) {
    // `ProgramFiles` / `ProgramFiles(x86)` are how Pi's `getShellConfig()` locates
    // `Git\\bin\\bash.exe`; without them the bash tool only resolves when bash happens to be on
    // PATH. `SystemRoot`/`WINDIR`/`ComSpec` keep cmd and the Node runtime working.
    &[
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ]
} else {
    &["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG"]
};

/// A full Git for Windows installation, which Pi's `getShellConfig` checks before PATH. Its tool set
/// is larger than MinGit's, so the bundled copy must never take precedence over it.
#[cfg(windows)]
fn full_git_bash() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join("Git").join("bin").join("bash.exe"))
        .find(|bash| bash.is_file())
}

/// Directories of the MinGit tree the installer drops next to the bundled Agent
/// (`<install>/gitbash`). The Agent resolves its shell with `where bash.exe`, so these must lead PATH;
/// `cmd` carries the git wrapper used by the bash tool. Neither exists when the installer could not
/// fetch MinGit, in which case the inherited PATH is left untouched. A full Git installation wins:
/// prepending MinGit there would shadow its larger tool set for every bash tool call.
#[cfg(windows)]
fn bundled_bash_dirs_with(agent: &Path, full_git: Option<&Path>) -> Vec<PathBuf> {
    if full_git.is_some() {
        return Vec::new();
    }
    let Some(gitbash) = agent.parent().map(|parent| parent.join("gitbash")) else {
        return Vec::new();
    };
    let bin = gitbash.join("usr").join("bin");
    if !bin.join("bash.exe").is_file() {
        return Vec::new();
    }
    let cmd = gitbash.join("cmd");
    if cmd.is_dir() {
        vec![bin, cmd]
    } else {
        vec![bin]
    }
}

#[cfg(windows)]
fn bundled_bash_dirs(agent: &Path) -> Vec<PathBuf> {
    let full_git = full_git_bash();
    bundled_bash_dirs_with(agent, full_git.as_deref())
}

/// `where bash.exe` candidates that Pi can actually use. The Windows WSL stub has no `-c` transport
/// (`getShellConfig` rewrites it), but plain `bash.exe` under System32 is not a usable Git Bash.
#[cfg(windows)]
fn is_usable_bash_path(line: &str) -> bool {
    let normalized = line.trim().replace('/', "\\").to_ascii_lowercase();
    !normalized.is_empty()
        && !normalized.ends_with("\\windows\\system32\\bash.exe")
        && !normalized.ends_with("\\windows\\sysnative\\bash.exe")
}

/// Whether the Agent will find a shell on this machine; used to explain readiness timeouts.
#[cfg(windows)]
fn bash_is_available(agent: &Path) -> bool {
    if full_git_bash().is_some() || !bundled_bash_dirs_with(agent, None).is_empty() {
        return true;
    }
    Command::new("where")
        .arg("bash.exe")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(is_usable_bash_path)
        })
        .unwrap_or(false)
}

/// Build a PATH value with `dirs` first and the inherited entries after them.
#[cfg(windows)]
fn prepend_path_dirs(dirs: &[PathBuf], inherited: Option<&std::ffi::OsStr>) -> OsString {
    let mut path = OsString::new();
    for dir in dirs {
        if !path.is_empty() {
            path.push(";");
        }
        path.push(dir.as_os_str());
    }
    if let Some(existing) = inherited {
        if !existing.is_empty() {
            if !path.is_empty() {
                path.push(";");
            }
            path.push(existing);
        }
    }
    path
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
    if !agent.join("config/agent.env").is_file() || !agent.join(RUNTIME).is_file() {
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
    let mut command = Command::new(agent.join(RUNTIME));
    command.env_clear();
    for key in INHERITED_ENV {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    // The installer ships MinGit under `<install>/gitbash`; put it ahead of the inherited PATH so
    // Pi's `where bash.exe` resolves on machines without Git for Windows.
    #[cfg(windows)]
    {
        let bash_dirs = bundled_bash_dirs(agent);
        if !bash_dirs.is_empty() {
            command.env(
                "PATH",
                prepend_path_dirs(&bash_dirs, std::env::var_os("PATH").as_deref()),
            );
        }
    }
    // The private directory-authority channel is a macOS Unix-socket feature.
    #[cfg(target_os = "macos")]
    if let Some(channel) = crate::local_directory_host::config() {
        command.env("AITEAM_LOCAL_HOST_SOCKET", channel.socket);
        command.env("AITEAM_LOCAL_HOST_TOKEN", channel.token);
    }
    command
        .arg("--import")
        .arg(import_specifier(
            &agent.join("node_modules/tsx/dist/esm/index.mjs"),
        ))
        .arg(agent.join("bin/start-agent.mjs"))
        .arg("--config")
        .arg(config)
        .args(["--host", "127.0.0.1", "--port", "0"])
        .arg("--data-dir")
        .arg(data)
        .current_dir(agent)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    // CREATE_NO_WINDOW: no console flashes up for the headless Node process or its children.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
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

/// Keep the freshly spawned Agent and, on Windows, the job that lets `stop` end its whole tree.
fn track(runtime: &mut Runtime, child: Child) {
    #[cfg(windows)]
    {
        match job::Job::adopt(&child) {
            Some(job) => runtime.job = Some(job),
            None => {
                // Without the job, `stop` can only end the Agent itself; the bash/tool processes it
                // spawned would survive. Record it so a lingering process tree is diagnosable.
                runtime.job = None;
                if let Some(root) = &runtime.root {
                    crate::diagnostics::host_event_fields(
                        root,
                        "agent.job_adopt_failed",
                        "warn",
                        serde_json::json!({ "pid": child.id() }),
                    );
                }
            }
        }
    }
    runtime.child = Some(child);
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
    let mut message = format!(
        "Agent 启动超时，未通过 healthz / readyz 检查；最后状态：{last_observation}"
    );
    #[cfg(windows)]
    {
        let agent_dir = state.0.lock().unwrap().agent_dir.clone();
        if let Some(agent) = agent_dir {
            if !bash_is_available(&agent) {
                crate::diagnostics::host_event_fields(
                    root,
                    "agent.bash_missing",
                    "error",
                    serde_json::json!({ "code": "bash_missing" }),
                );
                message = format!(
                    "本机缺少可用的 bash：内置 Git Bash 未安装，且系统没有 Git for Windows。请联网后重新运行安装程序，或安装 Git for Windows；最后状态：{last_observation}"
                );
            }
        }
    }
    Err(message)
}

impl Runtime {
    #[cfg(unix)]
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

    // Windows has no SIGTERM for a windowless child: ending the job stops the Agent together with
    // the bash/tool processes it started. agent-port.json is removed here because a killed Agent cannot.
    #[cfg(windows)]
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            match self.job.take() {
                Some(job) => job.terminate(),
                None => {
                    let _ = child.kill();
                }
            }
            let _ = child.wait();
            if let Some(root) = &self.root {
                let _ = fs::remove_file(root.join("agent-data/agent-port.json"));
            }
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
    #[cfg(target_os = "macos")]
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
        Ok(child) => track(&mut state.0.lock().unwrap(), child),
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
                        track(&mut runtime, child);
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

    #[cfg(windows)]
    #[test]
    fn bundled_bash_dirs_follow_the_installed_gitbash_tree() {
        let root = temporary_root("gitbash");
        let agent = root.join("agent");
        fs::create_dir_all(&agent).unwrap();
        assert!(bundled_bash_dirs_with(&agent, None).is_empty());
        fs::create_dir_all(root.join("gitbash/usr/bin")).unwrap();
        fs::write(root.join("gitbash/usr/bin/bash.exe"), "stub").unwrap();
        assert_eq!(
            bundled_bash_dirs_with(&agent, None),
            vec![root.join("gitbash/usr/bin")]
        );
        fs::create_dir_all(root.join("gitbash/cmd")).unwrap();
        assert_eq!(
            bundled_bash_dirs_with(&agent, None),
            vec![root.join("gitbash/usr/bin"), root.join("gitbash/cmd")]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_full_git_install_wins_over_the_bundled_tree() {
        let root = temporary_root("gitbash-preference");
        let agent = root.join("agent");
        fs::create_dir_all(&agent).unwrap();
        fs::create_dir_all(root.join("gitbash/usr/bin")).unwrap();
        fs::write(root.join("gitbash/usr/bin/bash.exe"), "stub").unwrap();
        let full_git = root.join("Git/bin/bash.exe");
        fs::create_dir_all(full_git.parent().unwrap()).unwrap();
        fs::write(&full_git, "stub").unwrap();
        // MinGit's tool set is smaller, so it must never shadow a real Git for Windows install.
        assert!(bundled_bash_dirs_with(&agent, Some(&full_git)).is_empty());
        assert!(!bundled_bash_dirs_with(&agent, None).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn the_wsl_bash_stub_is_not_a_usable_shell() {
        assert!(is_usable_bash_path(r"C:\Program Files\Git\bin\bash.exe"));
        assert!(is_usable_bash_path(r"C:\msys64\usr\bin\bash.exe"));
        assert!(!is_usable_bash_path(r"C:\Windows\System32\bash.exe"));
        assert!(!is_usable_bash_path("C:/Windows/Sysnative/bash.exe"));
        assert!(!is_usable_bash_path("  "));
    }

    #[cfg(windows)]
    #[test]
    fn bundled_bash_leads_the_agent_path() {
        let dirs = [
            PathBuf::from(r"C:\app\gitbash\usr\bin"),
            PathBuf::from(r"C:\app\gitbash\cmd"),
        ];
        assert_eq!(
            prepend_path_dirs(&dirs, Some(std::ffi::OsStr::new(r"C:\Windows"))),
            OsString::from(r"C:\app\gitbash\usr\bin;C:\app\gitbash\cmd;C:\Windows")
        );
        assert_eq!(
            prepend_path_dirs(&dirs, None),
            OsString::from(r"C:\app\gitbash\usr\bin;C:\app\gitbash\cmd")
        );
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
        fs::write(agent.join(RUNTIME), "not-executed").unwrap();
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
        {
            let child = launch(
                &repository.join("resources/agent"),
                &root,
                &root.join("agent.log"),
            )
            .unwrap();
            let mut runtime = state.0.lock().unwrap();
            runtime.root = Some(root.clone());
            track(&mut runtime, child);
        }
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
            // A unique nonexistent account is a read-only connectivity check: login
            // without an enterprise makes Manager match the account and password.
            // A real Manager 401 proves forwarding worked; 503 would mean failure.
            // (resolve-tenant-by-account is retired and always answers 410 locally,
            // so it can no longer prove that Manager is reachable.)
            let response = client.post(format!("{url}/api/agent/login"))
                .json(&serde_json::json!({
                    "account": format!("desktop-probe-{}", uuid::Uuid::new_v4()),
                    "password": format!("probe-{}", uuid::Uuid::new_v4()),
                }))
                .send().await.unwrap();
            assert_eq!(response.status(), 401);
            let body: serde_json::Value = response.json().await.unwrap();
            println!(
                "Manager login reached: HTTP 401, code={}",
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
        let generated = Command::new(agent.join(RUNTIME)).args(["-e", r#"
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
            {
                // Same path as production: the job and the data root are what `stop` relies on.
                let mut runtime = state.0.lock().unwrap();
                runtime.root = Some(root.clone());
                track(&mut runtime, child);
            }
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
            // On Windows `stop` waits on the child handle, so reaping is already guaranteed there.
            #[cfg(unix)]
            assert_eq!(
                unsafe { libc::kill(pid as i32, 0) },
                -1,
                "child must be reaped"
            );
            #[cfg(windows)]
            let _ = pid;
            // Use the bundled Node SQLite implementation; the desktop no longer
            // links a second SQLite runtime after the remote legacy cleanup.
            let script = if iteration == 0 {
                "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec(\"CREATE TABLE desktop_smoke (value TEXT); INSERT INTO desktop_smoke VALUES ('preserved');\"); db.close();"
            } else {
                "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); if(db.prepare('SELECT value FROM desktop_smoke').get().value !== 'preserved') process.exit(1); db.close();"
            };
            let result = Command::new(agent.join(RUNTIME))
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
