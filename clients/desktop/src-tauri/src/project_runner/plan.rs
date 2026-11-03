//! The commands a Node or Python project runs with, the first-run consent and the child
//! environment (workbench plan §4.3–§4.4).
use super::detect::Runner;
use super::process::Step;
use crate::agent_projects::read_small;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const CONSENT_FILE: &str = "workbench-run-consent.json";
const MAX_CONSENT_BYTES: u64 = 4 * 1024 * 1024;
/// Dependency files larger than this are not run.
const MAX_DEPENDENCY_BYTES: u64 = 1024 * 1024;
const MARKER_FILE: &str = "dependencies.sha256";
const SOURCE_FILE: &str = "workbench-dependency-source.json";
const MAX_SOURCE_URL_CHARS: usize = 512;
pub const PYPI_MIRROR: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";
pub const NPM_MIRROR: &str = "https://registry.npmmirror.com";
/// Installs retry a flaky network instead of giving up on the first slow response.
const NPM_NETWORK_ARGS: &[&str] = &["--fetch-retries=5", "--fetch-timeout=120000"];
/// `--disable-pip-version-check` skips pip's own call to pypi.org, slow where it is far away.
const PIP_NETWORK_ARGS: &[&str] = &["--disable-pip-version-check", "--timeout=60", "--retries=5"];

/// Where project dependencies download from.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum DependencySource {
    /// Mirrors in China: Tsinghua PyPI and npmmirror.
    #[default]
    Mirror,
    /// Whatever the user's pip and npm configuration says.
    System,
    /// The user's own index addresses; one left out follows the system configuration.
    Custom {
        pypi: Option<String>,
        npm: Option<String>,
    },
}

/// An index address without credentials (those belong in the user's own pip/npm config).
fn valid_source_url(url: &str) -> bool {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    let host = rest.map(|rest| rest.split('/').next().unwrap_or_default());
    url.chars().count() <= MAX_SOURCE_URL_CHARS
        && host.is_some_and(|host| !host.is_empty() && !host.contains('@'))
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

impl DependencySource {
    fn pypi(&self) -> Option<&str> {
        match self {
            Self::Mirror => Some(PYPI_MIRROR),
            Self::System => None,
            Self::Custom { pypi, .. } => pypi.as_deref(),
        }
    }

    fn npm(&self) -> Option<&str> {
        match self {
            Self::Mirror => Some(NPM_MIRROR),
            Self::System => None,
            Self::Custom { npm, .. } => npm.as_deref(),
        }
    }

    /// Trims custom addresses and drops empty ones; `None` if an address is not acceptable.
    fn normalized(self) -> Option<Self> {
        let Self::Custom { pypi, npm } = self else {
            return Some(self);
        };
        let clean = |url: Option<String>| -> Option<Option<String>> {
            match url
                .map(|url| url.trim().to_string())
                .filter(|url| !url.is_empty())
            {
                Some(url) if valid_source_url(&url) => Some(Some(url)),
                Some(_) => None,
                None => Some(None),
            }
        };
        Some(Self::Custom {
            pypi: clean(pypi)?,
            npm: clean(npm)?,
        })
    }
}

/// The saved download source; the mirrors when none is saved or the file is unreadable.
pub fn load_source(data_dir: &Path) -> DependencySource {
    read_small(&data_dir.join(SOURCE_FILE), MAX_CONSENT_BYTES)
        .and_then(|text| serde_json::from_str::<DependencySource>(&text).ok())
        .and_then(DependencySource::normalized)
        .unwrap_or_default()
}

/// Saves the download source and returns it as stored.
pub fn save_source(data_dir: &Path, source: DependencySource) -> Result<DependencySource, String> {
    let source = source.normalized().ok_or("invalid_download_source")?;
    let text = serde_json::to_string_pretty(&source).map_err(|_| "download_source_failed")?;
    std::fs::create_dir_all(data_dir).map_err(|_| "download_source_failed")?;
    let temporary = data_dir.join(format!("{SOURCE_FILE}.tmp"));
    std::fs::write(&temporary, text).map_err(|_| "download_source_failed")?;
    std::fs::rename(&temporary, data_dir.join(SOURCE_FILE))
        .map_err(|_| "download_source_failed")?;
    Ok(source)
}
/// Host variables a project keeps; everything else, `AITEAM_*` and credentials included, is
/// dropped. `PYTHONUNBUFFERED` and `BROWSER` are set so output arrives line by line and dev
/// servers do not open a second browser tab.
/// The Windows entries are what npm and Python need to start there at all.
const INHERITED_ENV: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TMPDIR",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
];

/// Where the host keeps run state and finds the runtimes.
#[derive(Clone, Debug)]
pub struct RunContext {
    /// `<app data>`: holds `workbench-runs/` and the consent file.
    pub data_dir: PathBuf,
    /// The bundled Node runtime and npm entry point.
    pub node: PathBuf,
    pub npm_cli: PathBuf,
    /// The system `python3`, if any.
    pub python: Option<PathBuf>,
    pub source: DependencySource,
}

/// What the consent dialog shows, and the fingerprint the consent is stored under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodePlan {
    pub commands: Vec<String>,
    pub fingerprint: String,
}

/// `<app data>/workbench-runs/<source>-<project id>`: venv, dependency marker and log.
pub fn run_dir(data_dir: &Path, source: &str, project_id: &str) -> PathBuf {
    data_dir
        .join("workbench-runs")
        .join(format!("{source}-{project_id}"))
}

fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python")
    }
}

fn sha256(parts: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    hex::encode(digest.finalize())
}

/// The dependency file of a code project and its contents.
fn dependencies(runner: &Runner, root: &Path) -> Result<(String, Vec<u8>), String> {
    let name = match runner {
        Runner::Node { .. } => "package.json",
        Runner::Python { dependencies, .. } => dependencies.as_str(),
        _ => return Err("not_runnable".into()),
    };
    let path = root.join(name);
    let plain = std::fs::symlink_metadata(&path)
        .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_DEPENDENCY_BYTES);
    if !plain {
        return Err("dependencies_unreadable".into());
    }
    let bytes = std::fs::read(&path).map_err(|_| "dependencies_unreadable")?;
    Ok((name.to_string(), bytes))
}

fn npm_install(source: &DependencySource) -> Vec<String> {
    let mut args: Vec<String> = ["install", "--no-audit", "--no-fund"]
        .iter()
        .chain(NPM_NETWORK_ARGS)
        .map(|arg| arg.to_string())
        .collect();
    // npm also points the registry.npmjs.org addresses of a package-lock.json at this one.
    args.extend(source.npm().map(|url| format!("--registry={url}")));
    args
}

fn pip_install(dependencies: &str, source: &DependencySource) -> Vec<String> {
    let mut args: Vec<String> = ["-m", "pip", "install"]
        .iter()
        .chain(PIP_NETWORK_ARGS)
        .map(|arg| arg.to_string())
        .collect();
    args.extend(source.pypi().map(|url| format!("--index-url={url}")));
    if dependencies == "requirements.txt" {
        args.extend(["-r".into(), dependencies.into()]);
    } else {
        args.push(".".into());
    }
    args
}

fn python_start(entry: &str, streamlit: bool, port: &str) -> Vec<String> {
    if !streamlit {
        return vec![entry.to_string()];
    }
    [
        "-m",
        "streamlit",
        "run",
        entry,
        "--server.address",
        "127.0.0.1",
        "--server.port",
        port,
        "--server.headless",
        "true",
    ]
    .map(String::from)
    .to_vec()
}

/// The commands as the user confirms them; the port shows as `$PORT`.
fn commands(runner: &Runner, venv: &Path, source: &DependencySource) -> Vec<String> {
    match runner {
        Runner::Node { script } => vec![
            format!("npm {}", npm_install(source).join(" ")),
            format!("npm run {script}"),
        ],
        Runner::Python {
            entry,
            dependencies,
            streamlit,
        } => {
            let python = venv_python(venv).display().to_string();
            vec![
                format!("python3 -m venv {}", venv.display()),
                format!("{python} {}", pip_install(dependencies, source).join(" ")),
                format!(
                    "{python} {}",
                    python_start(entry, *streamlit, "$PORT").join(" ")
                ),
            ]
        }
        _ => Vec::new(),
    }
}

/// The commands of a code project and the fingerprint its consent is stored under: a change of
/// the project, its folder, the commands (download source included) or the dependency file
/// asks again.
pub fn describe(
    runner: &Runner,
    root: &Path,
    run_dir: &Path,
    key: &str,
    source: &DependencySource,
) -> Result<CodePlan, String> {
    let (name, contents) = dependencies(runner, root)?;
    let commands = commands(runner, &run_dir.join("venv"), source);
    let joined = commands.join("\n");
    let folder = root.display().to_string();
    let fingerprint = sha256(&[
        b"aifred-workbench-run-v1",
        key.as_bytes(),
        folder.as_bytes(),
        joined.as_bytes(),
        name.as_bytes(),
        &contents,
    ]);
    Ok(CodePlan {
        commands,
        fingerprint,
    })
}

/// The steps to run now, with the port filled in; installing is skipped while the installed
/// dependencies match the dependency file. Also returns the folders to put first on `PATH`.
pub fn steps(
    runner: &Runner,
    root: &Path,
    run_dir: &Path,
    context: &RunContext,
    port: u16,
) -> Result<(Vec<Step>, Vec<PathBuf>), String> {
    let (_, contents) = dependencies(runner, root)?;
    let installed_hash = sha256(&[&contents]);
    let marker = run_dir.join(MARKER_FILE);
    let installed = std::fs::read_to_string(&marker).is_ok_and(|hash| hash == installed_hash);
    let labels = commands(runner, &run_dir.join("venv"), &context.source);
    let port_text = port.to_string();
    match runner {
        Runner::Node { script } => {
            if !context.node.is_file() || !context.npm_cli.is_file() {
                return Err("node_unavailable".into());
            }
            let npm = |args: Vec<String>| {
                let mut all = vec![context.npm_cli.display().to_string()];
                all.extend(args);
                all
            };
            let mut steps = Vec::new();
            let modules = std::fs::symlink_metadata(root.join("node_modules"))
                .is_ok_and(|meta| meta.is_dir());
            if !(installed && modules) {
                steps.push(Step {
                    program: context.node.clone(),
                    args: npm(npm_install(&context.source)),
                    label: labels[0].clone(),
                    marker: Some((marker, installed_hash)),
                });
            }
            steps.push(Step {
                program: context.node.clone(),
                args: npm(vec!["run".into(), script.clone()]),
                label: labels[1].clone(),
                marker: None,
            });
            let prefix = context
                .node
                .parent()
                .map(Path::to_path_buf)
                .into_iter()
                .collect();
            Ok((steps, prefix))
        }
        Runner::Python {
            entry,
            dependencies,
            streamlit,
        } => {
            let venv = run_dir.join("venv");
            let python = venv_python(&venv);
            let mut steps = Vec::new();
            let has_venv = python.is_file();
            if !has_venv {
                let system = context.python.clone().ok_or("python_unavailable")?;
                steps.push(Step {
                    program: system,
                    args: vec!["-m".into(), "venv".into(), venv.display().to_string()],
                    label: labels[0].clone(),
                    marker: None,
                });
            }
            if !(installed && has_venv) {
                steps.push(Step {
                    program: python.clone(),
                    args: pip_install(dependencies, &context.source),
                    label: labels[1].clone(),
                    marker: Some((marker, installed_hash)),
                });
            }
            steps.push(Step {
                program: python.clone(),
                args: python_start(entry, *streamlit, &port_text),
                label: labels[2].replace("$PORT", &port_text),
                marker: None,
            });
            let prefix = python.parent().map(Path::to_path_buf).into_iter().collect();
            Ok((steps, prefix))
        }
        _ => Err("not_runnable".into()),
    }
}

/// The child environment: `prefix` first on the host `PATH`, the allowed host variables, and
/// `PORT`/`HOST` for the dev server.
pub fn child_env(prefix: &[PathBuf], port: u16) -> Vec<(String, String)> {
    let mut paths = prefix.to_vec();
    if let Some(host) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&host));
    }
    let mut env = Vec::new();
    if let Ok(path) = std::env::join_paths(paths) {
        env.push(("PATH".to_string(), path.to_string_lossy().into_owned()));
    }
    for name in INHERITED_ENV {
        if let Ok(value) = std::env::var(name) {
            env.push((name.to_string(), value));
        }
    }
    for (name, value) in [
        ("PORT", port.to_string()),
        ("HOST", "127.0.0.1".to_string()),
        ("PYTHONUNBUFFERED", "1".to_string()),
        ("BROWSER", "none".to_string()),
    ] {
        env.push((name.to_string(), value));
    }
    env
}

/// The system `python3`: Homebrew first on macOS, where GUI apps get a minimal `PATH`.
pub fn find_python() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    };
    let preferred: &[&str] = if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
    } else {
        &[]
    };
    let on_path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .collect()
        })
        .unwrap_or_default();
    preferred
        .iter()
        .map(PathBuf::from)
        .chain(on_path)
        .chain(cfg!(unix).then(|| PathBuf::from("/usr/bin/python3")))
        .find(|path| path.is_file())
}

fn load_consent(data_dir: &Path) -> BTreeMap<String, String> {
    read_small(&data_dir.join(CONSENT_FILE), MAX_CONSENT_BYTES)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn consented(data_dir: &Path, key: &str, fingerprint: &str) -> bool {
    load_consent(data_dir)
        .get(key)
        .is_some_and(|stored| stored == fingerprint)
}

/// Records consent; callers serialize writes.
pub fn grant(data_dir: &Path, key: &str, fingerprint: &str) -> Result<(), String> {
    let mut all = load_consent(data_dir);
    all.insert(key.to_string(), fingerprint.to_string());
    let text = serde_json::to_string_pretty(&all).map_err(|_| "consent_failed")?;
    std::fs::create_dir_all(data_dir).map_err(|_| "consent_failed")?;
    let temporary = data_dir.join(format!("{CONSENT_FILE}.tmp"));
    std::fs::write(&temporary, text).map_err(|_| "consent_failed")?;
    std::fs::rename(&temporary, data_dir.join(CONSENT_FILE)).map_err(|_| "consent_failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aiteam-plan-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn context(data: &Path) -> RunContext {
        RunContext {
            data_dir: data.to_path_buf(),
            node: data.join("runtime/node"),
            npm_cli: data.join("runtime/npm/bin/npm-cli.js"),
            python: Some(data.join("python3")),
            source: DependencySource::Mirror,
        }
    }

    const NPM_INSTALL: &str = "npm install --no-audit --no-fund --fetch-retries=5 \
        --fetch-timeout=120000 --registry=https://registry.npmmirror.com";
    const PIP_MIRROR_ARGS: [&str; 7] = [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--timeout=60",
        "--retries=5",
        "--index-url=https://pypi.tuna.tsinghua.edu.cn/simple",
    ];

    #[test]
    fn dependency_sources_pick_the_index_and_reject_bad_addresses() {
        let node = Runner::Node {
            script: "dev".into(),
        };
        let venv = Path::new("/v");
        assert_eq!(
            commands(&node, venv, &DependencySource::Mirror)[0],
            NPM_INSTALL
        );
        assert_eq!(
            commands(&node, venv, &DependencySource::System)[0],
            "npm install --no-audit --no-fund --fetch-retries=5 --fetch-timeout=120000"
        );
        let custom = DependencySource::Custom {
            pypi: Some("https://pip.example.com/simple".into()),
            npm: None,
        };
        assert_eq!(custom.npm(), None);
        assert!(pip_install("requirements.txt", &custom)
            .contains(&"--index-url=https://pip.example.com/simple".to_string()));
        assert!(!pip_install("requirements.txt", &DependencySource::System)
            .iter()
            .any(|arg| arg.starts_with("--index-url")));

        let data = temp("source", &[]);
        assert_eq!(load_source(&data), DependencySource::Mirror);
        let saved = save_source(
            &data,
            DependencySource::Custom {
                pypi: Some("  https://pip.example.com/simple ".into()),
                npm: Some("".into()),
            },
        )
        .unwrap();
        assert_eq!(saved, custom);
        assert_eq!(load_source(&data), custom);
        for bad in [
            "ftp://x",
            "https://",
            "https://user:secret@pip.example.com/simple",
            "https://a b",
            "pip.example.com",
        ] {
            let source = DependencySource::Custom {
                pypi: Some(bad.into()),
                npm: None,
            };
            assert_eq!(
                save_source(&data, source).unwrap_err(),
                "invalid_download_source",
                "{bad}"
            );
        }
        assert_eq!(load_source(&data), custom);
        save_source(&data, DependencySource::System).unwrap();
        assert_eq!(load_source(&data), DependencySource::System);
        std::fs::write(data.join(SOURCE_FILE), "{broken").unwrap();
        assert_eq!(load_source(&data), DependencySource::Mirror);
        std::fs::remove_dir_all(&data).unwrap();
    }

    fn labels(steps: &[Step]) -> Vec<&str> {
        steps.iter().map(|step| step.label.as_str()).collect()
    }

    #[test]
    fn node_installs_until_the_dependencies_match() {
        let data = temp(
            "node-data",
            &[("runtime/node", "x"), ("runtime/npm/bin/npm-cli.js", "x")],
        );
        let root = temp("node", &[("package.json", r#"{"scripts":{"dev":"vite"}}"#)]);
        let runner = Runner::Node {
            script: "dev".into(),
        };
        let runs = run_dir(&data, "codex", "abc");
        let ctx = context(&data);

        let (steps, prefix) = steps(&runner, &root, &runs, &ctx, 4000).unwrap();
        assert_eq!(labels(&steps), [NPM_INSTALL, "npm run dev"]);
        assert_eq!(
            steps[0].args[1..],
            NPM_INSTALL.split(' ').collect::<Vec<_>>()[1..]
        );
        assert_eq!(steps[1].program, ctx.node);
        assert_eq!(steps[1].args[1..], ["run", "dev"]);
        assert_eq!(prefix, [data.join("runtime")]);
        let (marker, hash) = steps[0].marker.clone().unwrap();
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, hash).unwrap();
        // The marker alone is not enough: node_modules must still be there.
        assert_eq!(
            super::steps(&runner, &root, &runs, &ctx, 4000)
                .unwrap()
                .0
                .len(),
            2
        );
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        assert_eq!(
            labels(&super::steps(&runner, &root, &runs, &ctx, 4000).unwrap().0),
            ["npm run dev"]
        );
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"dependencies":{"x":"1"}}"#,
        )
        .unwrap();
        assert_eq!(
            super::steps(&runner, &root, &runs, &ctx, 4000)
                .unwrap()
                .0
                .len(),
            2
        );

        std::fs::remove_file(&ctx.npm_cli).unwrap();
        assert_eq!(
            super::steps(&runner, &root, &runs, &ctx, 4000).unwrap_err(),
            "node_unavailable"
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn python_runs_in_a_private_venv() {
        let data = temp("py-data", &[]);
        let root = temp(
            "py",
            &[
                ("requirements.txt", "streamlit\n"),
                ("app.py", "import streamlit"),
            ],
        );
        let runner = Runner::Python {
            entry: "app.py".into(),
            dependencies: "requirements.txt".into(),
            streamlit: true,
        };
        let runs = run_dir(&data, "fred", "conversation-1");
        let mut ctx = context(&data);
        let (all, prefix) = steps(&runner, &root, &runs, &ctx, 8501).unwrap();
        let venv = runs.join("venv");
        let python = venv_python(&venv);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].program, data.join("python3"));
        let venv_arg = venv.display().to_string();
        assert_eq!(all[0].args, ["-m", "venv", venv_arg.as_str()]);
        assert_eq!(all[1].program, python);
        assert_eq!(all[1].args[..7], PIP_MIRROR_ARGS);
        assert_eq!(all[1].args[7..], ["-r", "requirements.txt"]);
        assert!(all[2]
            .args
            .windows(2)
            .any(|pair| pair == ["--server.port", "8501"]));
        assert!(all[2]
            .label
            .ends_with("--server.port 8501 --server.headless true"));
        assert_eq!(prefix, [python.parent().unwrap()]);

        // With the venv and matching dependencies only the app starts; no system python needed.
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "x").unwrap();
        let (marker, hash) = all[1].marker.clone().unwrap();
        std::fs::write(marker, hash).unwrap();
        ctx.python = None;
        let only = steps(&runner, &root, &runs, &ctx, 8501).unwrap().0;
        assert_eq!(only.len(), 1);
        std::fs::remove_dir_all(&venv).unwrap();
        assert_eq!(
            steps(&runner, &root, &runs, &ctx, 8501).unwrap_err(),
            "python_unavailable"
        );

        let flask = Runner::Python {
            entry: "main.py".into(),
            dependencies: "pyproject.toml".into(),
            streamlit: false,
        };
        std::fs::write(root.join("pyproject.toml"), "[project]\n").unwrap();
        ctx.python = Some(data.join("python3"));
        let plain = steps(&flask, &root, &runs, &ctx, 5000).unwrap().0;
        assert_eq!(plain[1].args[..7], PIP_MIRROR_ARGS);
        assert_eq!(plain[1].args[7..], ["."]);
        assert_eq!(plain[2].args, ["main.py"]);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn consent_follows_the_commands_and_the_dependency_file() {
        let data = temp("consent", &[]);
        let root = temp(
            "consent-node",
            &[("package.json", r#"{"scripts":{"dev":"vite"}}"#)],
        );
        let runs = run_dir(&data, "codex", "abc");
        let dev = Runner::Node {
            script: "dev".into(),
        };
        let mirror = DependencySource::Mirror;
        let plan = describe(&dev, &root, &runs, "codex:abc", &mirror).unwrap();
        assert_eq!(plan.commands, [NPM_INSTALL, "npm run dev"]);
        // Another download source is another command: confirmed again.
        assert_ne!(
            describe(&dev, &root, &runs, "codex:abc", &DependencySource::System)
                .unwrap()
                .fingerprint,
            plan.fingerprint
        );
        assert!(!consented(&data, "codex:abc", &plan.fingerprint));
        grant(&data, "codex:abc", &plan.fingerprint).unwrap();
        assert!(consented(&data, "codex:abc", &plan.fingerprint));
        assert!(!consented(&data, "codex:other", &plan.fingerprint));
        assert_eq!(
            describe(&dev, &root, &runs, "codex:abc", &mirror).unwrap(),
            plan
        );

        let start = Runner::Node {
            script: "start".into(),
        };
        assert_ne!(
            describe(&start, &root, &runs, "codex:abc", &mirror)
                .unwrap()
                .fingerprint,
            plan.fingerprint
        );
        assert_ne!(
            describe(&dev, &root, &runs, "claude:abc", &mirror)
                .unwrap()
                .fingerprint,
            plan.fingerprint
        );
        std::fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite","postinstall":"curl x"}}"#,
        )
        .unwrap();
        let changed = describe(&dev, &root, &runs, "codex:abc", &mirror).unwrap();
        assert_ne!(changed.fingerprint, plan.fingerprint);
        assert!(!consented(&data, "codex:abc", &changed.fingerprint));
        std::fs::remove_file(root.join("package.json")).unwrap();
        assert_eq!(
            describe(&dev, &root, &runs, "codex:abc", &mirror).unwrap_err(),
            "dependencies_unreadable"
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&data).unwrap();
    }

    #[test]
    fn child_environment_keeps_only_allowed_variables() {
        let prefix = [PathBuf::from("/opt/aifred/runtime")];
        let env = child_env(&prefix, 4321);
        let names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
        for name in &names {
            assert!(
                *name == "PATH"
                    || INHERITED_ENV.contains(name)
                    || ["PORT", "HOST", "PYTHONUNBUFFERED", "BROWSER"].contains(name),
                "{name}"
            );
        }
        let get = |key: &str| {
            env.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("PORT"), Some("4321"));
        assert_eq!(get("HOST"), Some("127.0.0.1"));
        assert!(get("PATH").unwrap().starts_with("/opt/aifred/runtime"));
    }
}
