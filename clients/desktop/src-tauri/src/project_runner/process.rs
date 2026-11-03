//! Node and Python projects run as child processes (workbench plan §4.3). Each run is one
//! process group running its steps in order (install, then start). Output is kept as the last
//! 500 lines and in a log file, and the first loopback address the start step prints is opened.
use serde::Serialize;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const MAX_LOG_LINES: usize = 500;
const MAX_LOG_LINE_CHARS: usize = 2000;
/// Longest stretch of output read as one line.
const MAX_READ_BYTES: u64 = 64 * 1024;
/// How long the start step may run without printing an address before the user is told to
/// check the log.
pub const URL_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(3);

/// One command of a run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The command as the log and the consent dialog show it.
    pub label: String,
    /// Written once the step succeeds: records which dependencies are installed.
    pub marker: Option<(PathBuf, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Installing dependencies.
    Preparing,
    /// The start step runs but has not printed an address yet.
    Starting,
    Running,
    Exited,
    Failed,
    Stopped,
}

impl Phase {
    pub fn active(self) -> bool {
        matches!(self, Phase::Preparing | Phase::Starting | Phase::Running)
    }
}

/// Called once with the first address the start step prints.
pub type Ready = Box<dyn FnOnce(String) + Send>;

struct Shared {
    phase: Phase,
    url: Option<String>,
    exit_code: Option<i32>,
    starting_since: Option<Instant>,
    pid: Option<u32>,
    stopping: bool,
    logs: VecDeque<String>,
    log_file: Option<File>,
    ready: Option<Ready>,
}

impl Shared {
    fn log(&mut self, line: &str) {
        let line: String = line.chars().take(MAX_LOG_LINE_CHARS).collect();
        if let Some(file) = &mut self.log_file {
            let _ = writeln!(file, "{line}");
        }
        if self.logs.len() == MAX_LOG_LINES {
            self.logs.pop_front();
        }
        self.logs.push_back(line);
    }
}

fn lock(shared: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub phase: Phase,
    pub url: Option<String>,
    pub exit_code: Option<i32>,
    pub url_timed_out: bool,
    pub logs: Vec<String>,
}

/// A running (or finished) project; dropping it ends the whole process group.
pub struct ProcessRun(Arc<Mutex<Shared>>);

impl ProcessRun {
    pub fn start(
        steps: Vec<Step>,
        cwd: PathBuf,
        env: Vec<(String, String)>,
        log_path: &Path,
        ready: Ready,
    ) -> Result<Self, String> {
        if steps.is_empty() {
            return Err("not_runnable".into());
        }
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "run_failed")?;
        }
        let log_file = File::create(log_path).map_err(|_| "run_failed")?;
        let shared = Arc::new(Mutex::new(Shared {
            phase: Phase::Preparing,
            url: None,
            exit_code: None,
            starting_since: None,
            pid: None,
            stopping: false,
            logs: VecDeque::new(),
            log_file: Some(log_file),
            ready: Some(ready),
        }));
        let supervised = shared.clone();
        std::thread::Builder::new()
            .name("aifred-project-run".into())
            .spawn(move || supervise(&supervised, &steps, &cwd, &env))
            .map_err(|_| "run_failed")?;
        Ok(Self(shared))
    }

    pub fn snapshot(&self) -> Snapshot {
        let state = lock(&self.0);
        Snapshot {
            phase: state.phase,
            url: state.url.clone(),
            exit_code: state.exit_code,
            url_timed_out: state.phase == Phase::Starting
                && state
                    .starting_since
                    .is_some_and(|since| since.elapsed() >= URL_TIMEOUT),
            logs: state.logs.iter().cloned().collect(),
        }
    }

    /// Ends the current step and its descendants; later steps do not start.
    pub fn stop(&self) {
        let pid = {
            let mut state = lock(&self.0);
            state.stopping = true;
            if state.phase.active() {
                state.phase = Phase::Stopped;
                state.log("已停止");
            }
            state.pid
        };
        if let Some(pid) = pid {
            terminate_group(pid);
        }
    }
}

impl Drop for ProcessRun {
    fn drop(&mut self) {
        self.stop();
    }
}

fn supervise(shared: &Arc<Mutex<Shared>>, steps: &[Step], cwd: &Path, env: &[(String, String)]) {
    for (index, step) in steps.iter().enumerate() {
        let starting = index + 1 == steps.len();
        // Spawn under the lock so a concurrent stop either prevents the step or sees its pid.
        let mut child = {
            let mut state = lock(shared);
            if state.stopping {
                return;
            }
            state.log(&format!("$ {}", step.label));
            if starting {
                state.phase = Phase::Starting;
                state.starting_since = Some(Instant::now());
            }
            match spawn(step, cwd, env) {
                Ok(child) => {
                    state.pid = Some(child.id());
                    child
                }
                Err(error) => {
                    state.log(&format!("无法启动：{error}"));
                    state.phase = Phase::Failed;
                    return;
                }
            }
        };
        let pid = child.id();
        let outputs: [Option<Box<dyn Read + Send>>; 2] = [
            child
                .stdout
                .take()
                .map(|out| Box::new(out) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|err| Box::new(err) as Box<dyn Read + Send>),
        ];
        let readers: Vec<_> = outputs
            .into_iter()
            .flatten()
            .map(|output| {
                let shared = shared.clone();
                std::thread::spawn(move || read_output(&shared, output, starting))
            })
            .collect();
        let status = child.wait();
        // Background processes the step left behind would keep the output open; end them.
        terminate_group(pid);
        for reader in readers {
            let _ = reader.join();
        }
        let mut state = lock(shared);
        state.pid = None;
        if state.stopping {
            return;
        }
        let code = status.as_ref().ok().and_then(|status| status.code());
        let success = status.is_ok_and(|status| status.success());
        let outcome =
            code.map_or_else(|| "被信号结束".to_string(), |code| format!("退出码 {code}"));
        if starting {
            state.phase = Phase::Exited;
            state.exit_code = code;
            state.log(&format!("进程已退出（{outcome}）"));
        } else if success {
            if let Some((path, value)) = &step.marker {
                let _ = std::fs::write(path, value);
            }
        } else {
            state.phase = Phase::Failed;
            state.exit_code = code;
            state.log(&format!("步骤失败（{outcome}）"));
            return;
        }
    }
}

fn spawn(step: &Step, cwd: &Path, env: &[(String, String)]) -> std::io::Result<Child> {
    let mut command = Command::new(&step.program);
    command
        .args(&step.args)
        .current_dir(cwd)
        .env_clear()
        .envs(
            env.iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    command.spawn()
}

/// Ends the process group led by `pid`: SIGTERM, then SIGKILL for whatever is left.
#[cfg(unix)]
fn terminate_group(pid: u32) {
    // Never signal group 0 (our own) or init.
    let Some(group) = i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 1)
        .map(|pid| -pid)
    else {
        return;
    };
    // SAFETY: the group was created for this step's child by `process_group(0)`.
    unsafe {
        libc::kill(group, libc::SIGTERM);
    }
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        // SAFETY: signal 0 only checks whether any process of the group is left.
        if unsafe { libc::kill(group, 0) } != 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // SAFETY: as above.
    unsafe {
        libc::kill(group, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn terminate_group(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn read_output(shared: &Mutex<Shared>, output: Box<dyn Read + Send>, starting: bool) {
    let mut reader = BufReader::new(output);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match (&mut reader)
            .take(MAX_READ_BYTES)
            .read_until(b'\n', &mut buffer)
        {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let text = strip_ansi(&String::from_utf8_lossy(&buffer));
        let ready = {
            let mut state = lock(shared);
            let mut ready = None;
            // Progress bars redraw with `\r`; keep each redraw as its own line.
            for line in text
                .split(['\r', '\n'])
                .filter(|line| !line.trim().is_empty())
            {
                state.log(line.trim_end());
                if !starting || state.url.is_some() || state.stopping {
                    continue;
                }
                if let Some(url) = loopback_url(line) {
                    state.url = Some(url.clone());
                    state.phase = Phase::Running;
                    ready = state.ready.take().map(|ready| (ready, url));
                }
            }
            ready
        };
        if let Some((ready, url)) = ready {
            ready(url);
        }
    }
}

/// Drops terminal escape sequences (colours, cursor moves) from process output.
fn strip_ansi(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(char) = chars.next() {
        if char != '\x1b' {
            output.push(char);
            continue;
        }
        if chars.clone().next() == Some('[') {
            chars.next();
            for char in chars.by_ref() {
                if ('@'..='~').contains(&char) {
                    break;
                }
            }
        }
    }
    output
}

/// The first `http://127.0.0.1:<port>` or `http://localhost:<port>` address in a line.
fn loopback_url(line: &str) -> Option<String> {
    let (at, prefix) = ["http://127.0.0.1:", "http://localhost:"]
        .into_iter()
        .filter_map(|prefix| line.find(prefix).map(|at| (at, prefix)))
        .min_by_key(|(at, _)| *at)?;
    let digits: String = line[at + prefix.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let port: u16 = digits.parse().ok().filter(|port| *port > 0)?;
    Some(format!("{prefix}{port}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_first_loopback_address_in_coloured_output() {
        let vite = "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n";
        assert_eq!(
            loopback_url(&strip_ansi(vite)).as_deref(),
            Some("http://localhost:5173/")
        );
        assert_eq!(
            loopback_url(" * Running on http://127.0.0.1:5000 (Press CTRL+C to quit)").as_deref(),
            Some("http://127.0.0.1:5000/")
        );
        assert_eq!(
            loopback_url("Local: http://localhost:3000 Network: http://127.0.0.1:9").as_deref(),
            Some("http://localhost:3000/")
        );
        for line in [
            "Network: http://192.168.1.5:5173/",
            "http://0.0.0.0:8000",
            "https://localhost:443",
            "http://localhost:/",
            "http://127.0.0.1:0/",
            "http://localhost:99999/",
            "GET https://registry.npmjs.org/vite",
        ] {
            assert_eq!(loopback_url(line), None, "{line}");
        }
    }

    #[cfg(unix)]
    mod unix {
        use super::super::*;

        fn sh(script: &str) -> Step {
            Step {
                program: "/bin/sh".into(),
                args: vec!["-c".into(), script.into()],
                label: script.into(),
                marker: None,
            }
        }

        fn temp(tag: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "aiteam-process-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn env() -> Vec<(String, String)> {
            vec![("PATH".into(), "/usr/bin:/bin".into())]
        }

        fn start(dir: &Path, steps: Vec<Step>) -> ProcessRun {
            ProcessRun::start(
                steps,
                dir.to_path_buf(),
                env(),
                &dir.join("logs/run.log"),
                Box::new(|_| {}),
            )
            .unwrap()
        }

        fn wait(run: &ProcessRun, done: impl Fn(&Snapshot) -> bool) -> Snapshot {
            for _ in 0..200 {
                let snapshot = run.snapshot();
                if done(&snapshot) {
                    return snapshot;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            panic!("timed out: {:?}", run.snapshot());
        }

        #[test]
        fn a_failed_step_ends_the_run_and_records_markers_only_on_success() {
            let dir = temp("failed");
            let mut install = sh("echo installed");
            install.marker = Some((dir.join("marker"), "abc".into()));
            let run = start(
                &dir,
                vec![install, sh("echo boom >&2; exit 3"), sh("echo never")],
            );
            let snapshot = wait(&run, |snapshot| !snapshot.phase.active());
            assert_eq!(snapshot.phase, Phase::Failed);
            assert_eq!(snapshot.exit_code, Some(3));
            assert!(snapshot.logs.iter().any(|line| line == "installed"));
            assert!(snapshot.logs.iter().any(|line| line == "boom"));
            assert!(!snapshot.logs.iter().any(|line| line == "never"));
            assert_eq!(std::fs::read_to_string(dir.join("marker")).unwrap(), "abc");
            drop(run);
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn opens_the_first_address_once_and_keeps_the_last_500_lines() {
            let dir = temp("logs");
            let (sender, receiver) = std::sync::mpsc::channel();
            let run = ProcessRun::start(
                vec![sh(
                    "echo 'Local: http://127.0.0.1:4321/'; echo 'again http://localhost:1/'; \
                     i=0; while [ $i -lt 600 ]; do echo line$i; i=$((i+1)); done",
                )],
                dir.clone(),
                env(),
                &dir.join("run.log"),
                Box::new(move |url| sender.send(url).unwrap()),
            )
            .unwrap();
            let snapshot = wait(&run, |snapshot| snapshot.phase == Phase::Exited);
            assert_eq!(snapshot.url.as_deref(), Some("http://127.0.0.1:4321/"));
            assert_eq!(
                receiver.try_iter().collect::<Vec<_>>(),
                ["http://127.0.0.1:4321/"]
            );
            assert_eq!(snapshot.exit_code, Some(0));
            assert_eq!(snapshot.logs.len(), MAX_LOG_LINES);
            assert_eq!(snapshot.logs[MAX_LOG_LINES - 2], "line599");
            let file = std::fs::read_to_string(dir.join("run.log")).unwrap();
            assert!(file.lines().any(|line| line == "line0"));
            drop(run);
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn children_get_only_the_given_environment() {
            assert!(std::env::vars().any(|(name, _)| name.starts_with("CARGO")));
            let dir = temp("env");
            let run = start(&dir, vec![sh("env")]);
            let snapshot = wait(&run, |snapshot| snapshot.phase == Phase::Exited);
            assert!(snapshot
                .logs
                .iter()
                .any(|line| line == "PATH=/usr/bin:/bin"));
            assert!(
                !snapshot.logs.iter().any(|line| line.starts_with("CARGO")),
                "{:?}",
                snapshot.logs
            );
            drop(run);
            std::fs::remove_dir_all(&dir).unwrap();
        }

        #[test]
        fn stopping_ends_the_whole_process_group() {
            let dir = temp("stop");
            let run = start(
                &dir,
                vec![sh("sleep 30 & echo child:$!; wait"), sh("echo never")],
            );
            let snapshot = wait(&run, |snapshot| {
                snapshot.logs.iter().any(|line| line.starts_with("child:"))
            });
            let child: i32 = snapshot
                .logs
                .iter()
                .find_map(|line| line.strip_prefix("child:"))
                .unwrap()
                .parse()
                .unwrap();
            run.stop();
            assert_eq!(run.snapshot().phase, Phase::Stopped);
            // SAFETY: signal 0 only checks whether the background child still exists.
            let gone = (0..100).any(|_| {
                std::thread::sleep(Duration::from_millis(20));
                unsafe { libc::kill(child, 0) != 0 }
            });
            assert!(gone, "the background child should be ended with its group");
            std::thread::sleep(Duration::from_millis(200));
            let snapshot = run.snapshot();
            assert_eq!(snapshot.phase, Phase::Stopped);
            assert!(!snapshot.logs.iter().any(|line| line == "never"));
            drop(run);
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}
