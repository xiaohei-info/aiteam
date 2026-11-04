//! How a project runs, decided from the files at its root (workbench plan §4.1). A folder that
//! does not run as a whole may hold several apps side by side, one per subfolder — an agent
//! asked for a few demos in one conversation writes them that way.
use crate::agent_projects::{
    project_files, read_small, FileFormat, IGNORED_DIRS, MAX_MANIFEST_BYTES,
};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// npm scripts that start a project, in order of preference.
const NODE_SCRIPTS: &[&str] = &["dev", "start", "preview"];
const PYTHON_DEPENDENCIES: &[&str] = &["requirements.txt", "pyproject.toml"];
const PYTHON_ENTRIES: &[&str] = &["app.py", "main.py", "streamlit_app.py"];
/// Folders a built or plain site keeps its `index.html` in, in order of preference.
const SITE_DIRS: &[&str] = &["", "dist", "build", "public"];
/// Apps looked for among a project's subfolders, at most.
const MAX_SUBFOLDER_APPS: usize = 50;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RunnableFile {
    pub id: String,
    /// Relative to the project folder, `/`-separated.
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Runner {
    /// `npm install`, then `npm run <script>`.
    Node { script: String },
    /// Dependencies from `dependencies` into a private venv, then the entry file.
    Python {
        entry: String,
        dependencies: String,
        streamlit: bool,
    },
    /// A static server for `<dir>/index.html`; `dir` is empty for the project root.
    Static { dir: String },
    /// HTML pages without an `index.html`: the user picks one to open.
    Html { files: Vec<RunnableFile> },
    /// Nothing to run; the folder can only be shown.
    None,
}

/// Something in a project that runs on its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RunUnit {
    /// A subfolder directly in the project folder; empty for the project folder itself.
    pub dir: String,
    /// Paths in `runner` are relative to `dir`.
    pub runner: Runner,
}

/// A regular file `name` in `dir` (empty for `root`); symlinks do not count.
fn plain_file(root: &Path, dir: &str, name: &str) -> bool {
    let folder = root.join(dir);
    let folder_ok =
        dir.is_empty() || std::fs::symlink_metadata(&folder).is_ok_and(|meta| meta.is_dir());
    folder_ok && std::fs::symlink_metadata(folder.join(name)).is_ok_and(|meta| meta.is_file())
}

fn node_script(root: &Path) -> Option<String> {
    if !plain_file(root, "", "package.json") {
        return None;
    }
    let manifest: Value =
        serde_json::from_str(&read_small(&root.join("package.json"), MAX_MANIFEST_BYTES)?).ok()?;
    let scripts = &manifest["scripts"];
    NODE_SCRIPTS
        .iter()
        .find(|name| {
            scripts[**name]
                .as_str()
                .is_some_and(|command| !command.trim().is_empty())
        })
        .map(|name| (*name).to_string())
}

fn imports_streamlit(source: &str) -> bool {
    source
        .lines()
        .map(str::trim_start)
        .any(|line| line.starts_with("import streamlit") || line.starts_with("from streamlit"))
}

fn python(root: &Path) -> Option<Runner> {
    let dependencies = PYTHON_DEPENDENCIES
        .iter()
        .find(|name| plain_file(root, "", name))?;
    let entry = PYTHON_ENTRIES
        .iter()
        .find(|name| plain_file(root, "", name))?;
    let streamlit = read_small(&root.join(entry), MAX_MANIFEST_BYTES)
        .is_some_and(|source| imports_streamlit(&source));
    Some(Runner::Python {
        entry: (*entry).to_string(),
        dependencies: (*dependencies).to_string(),
        streamlit,
    })
}

/// A Node app, Python app or site at `root`.
fn detect_app(root: &Path) -> Option<Runner> {
    if let Some(script) = node_script(root) {
        return Some(Runner::Node { script });
    }
    if let Some(runner) = python(root) {
        return Some(runner);
    }
    SITE_DIRS
        .iter()
        .find(|dir| plain_file(root, dir, "index.html"))
        .map(|dir| Runner::Static {
            dir: (*dir).to_string(),
        })
}

/// The HTML pages in `root`, leaving out those in the folders `skip`.
fn html_pages(root: &Path, skip: &[RunUnit]) -> Runner {
    let files: Vec<RunnableFile> = project_files(root)
        .into_iter()
        .filter(|file| file.format == FileFormat::Html)
        .filter(|file| {
            !skip
                .iter()
                .any(|unit| file.path.starts_with(&format!("{}/", unit.dir)))
        })
        .map(|file| RunnableFile {
            id: file.id,
            path: file.path,
        })
        .collect();
    if files.is_empty() {
        Runner::None
    } else {
        Runner::Html { files }
    }
}

/// How the folder `root` runs as a whole; the app itself asks for its units instead.
#[cfg(test)]
pub fn detect(root: &Path) -> Runner {
    detect_app(root).unwrap_or_else(|| html_pages(root, &[]))
}

/// Apps in the folders directly in `root`, by folder name. Hidden, dependency and symlinked
/// folders do not count.
fn subfolder_apps(root: &Path) -> Vec<RunUnit> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        // DirEntry::file_type does not follow symlinks.
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.') && !IGNORED_DIRS.contains(&name.as_str()))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|dir| detect_app(&root.join(&dir)).map(|runner| RunUnit { dir, runner }))
        .take(MAX_SUBFOLDER_APPS)
        .collect()
}

/// What runs in a project: the project itself when it is one app; otherwise each app in a
/// subfolder, after the HTML pages outside them. Never empty: a project with nothing to run
/// has one unit that runs nothing.
pub fn detect_units(root: &Path) -> Vec<RunUnit> {
    if let Some(runner) = detect_app(root) {
        return vec![RunUnit {
            dir: String::new(),
            runner,
        }];
    }
    let apps = subfolder_apps(root);
    let pages = html_pages(root, &apps);
    let mut units = Vec::with_capacity(apps.len() + 1);
    if pages != Runner::None || apps.is_empty() {
        units.push(RunUnit {
            dir: String::new(),
            runner: pages,
        });
    }
    units.extend(apps);
    units
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "aiteam-runner-detect-{tag}-{}-{}",
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

    fn detected(tag: &str, files: &[(&str, &str)]) -> Runner {
        let root = project(tag, files);
        let runner = detect(&root);
        std::fs::remove_dir_all(&root).unwrap();
        runner
    }

    #[test]
    fn node_projects_need_a_start_script() {
        let vite = r#"{"scripts":{"build":"vite build","preview":"vite preview","dev":"vite"}}"#;
        assert_eq!(
            detected("vite", &[("package.json", vite), ("index.html", "x")]),
            Runner::Node {
                script: "dev".into()
            }
        );
        // A package.json without a start script falls through to the static site.
        let library = r#"{"name":"lib","scripts":{"test":"node --test"}}"#;
        assert_eq!(
            detected("lib", &[("package.json", library), ("index.html", "x")]),
            Runner::Static { dir: "".into() }
        );
        assert_eq!(
            detected("broken", &[("package.json", "{not json")]),
            Runner::None
        );
    }

    #[test]
    fn python_projects_need_dependencies_and_an_entry() {
        assert_eq!(
            detected(
                "streamlit",
                &[
                    ("requirements.txt", "streamlit\npandas\n"),
                    ("app.py", "import pandas as pd\nimport streamlit as st\n")
                ]
            ),
            Runner::Python {
                entry: "app.py".into(),
                dependencies: "requirements.txt".into(),
                streamlit: true
            }
        );
        assert_eq!(
            detected(
                "flask",
                &[
                    ("pyproject.toml", "[project]\nname='api'\n"),
                    ("main.py", "from flask import Flask\n")
                ]
            ),
            Runner::Python {
                entry: "main.py".into(),
                dependencies: "pyproject.toml".into(),
                streamlit: false
            }
        );
        // A script without declared dependencies is not a runnable app.
        assert_eq!(detected("script", &[("main.py", "print(1)")]), Runner::None);
    }

    #[test]
    fn sites_and_single_pages_are_served_statically() {
        assert_eq!(
            detected("dist", &[("dist/index.html", "x"), ("src/main.ts", "x")]),
            Runner::Static { dir: "dist".into() }
        );
        let Runner::Html { files } = detected(
            "pages",
            &[
                ("trending_daily.html", "<p>d</p>"),
                ("report/weekly.html", "<p>w</p>"),
                ("empty.html", ""),
                ("notes.md", "x"),
            ],
        ) else {
            panic!("expected single pages");
        };
        let paths: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["report/weekly.html", "trending_daily.html"]);
        assert_eq!(detected("docs", &[("notes.md", "x")]), Runner::None);
    }

    #[test]
    fn folders_of_demos_run_each_app_on_its_own() {
        let vite = r#"{"scripts":{"dev":"vite"}}"#;
        let root = project(
            "demos",
            &[
                ("trending.html", "<p>t</p>"),
                ("html-game-demo/index.html", "<p>g</p>"),
                ("html-game-demo/js/game.js", "x"),
                ("vite-demo/package.json", vite),
                ("vite-demo/index.html", "<p>v</p>"),
                ("vite-demo/dist/index.html", "<p>b</p>"),
                ("streamlit-demo/requirements.txt", "streamlit\n"),
                ("streamlit-demo/app.py", "import streamlit as st\n"),
                ("streamlit-demo/.venv/lib/site.html", "<p>s</p>"),
                ("notes/readme.md", "x"),
                (".cache/index.html", "x"),
                ("node_modules/pkg/index.html", "x"),
            ],
        );
        let units = detect_units(&root);
        let dirs: Vec<_> = units.iter().map(|unit| unit.dir.as_str()).collect();
        assert_eq!(dirs, ["", "html-game-demo", "streamlit-demo", "vite-demo"]);
        // Pages inside the apps belong to the apps.
        let Runner::Html { files } = &units[0].runner else {
            panic!("expected the loose pages");
        };
        let paths: Vec<_> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["trending.html"]);
        assert_eq!(units[1].runner, Runner::Static { dir: "".into() });
        assert!(matches!(
            units[2].runner,
            Runner::Python {
                streamlit: true,
                ..
            }
        ));
        assert_eq!(
            units[3].runner,
            Runner::Node {
                script: "dev".into()
            }
        );
        std::fs::remove_dir_all(&root).unwrap();

        // Without loose pages there is no unit for the project folder.
        let root = project("apps", &[("a/index.html", "x"), ("b/index.html", "x")]);
        let dirs: Vec<_> = detect_units(&root)
            .into_iter()
            .map(|unit| unit.dir)
            .collect();
        assert_eq!(dirs, ["a", "b"]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn an_app_at_the_root_is_the_only_unit() {
        let root = project(
            "root-app",
            &[
                ("package.json", r#"{"scripts":{"start":"node server.js"}}"#),
                ("examples/demo/index.html", "x"),
                ("client/index.html", "x"),
            ],
        );
        assert_eq!(
            detect_units(&root),
            [RunUnit {
                dir: "".into(),
                runner: Runner::Node {
                    script: "start".into()
                }
            }]
        );
        std::fs::remove_dir_all(&root).unwrap();
        let docs = project("nothing", &[("notes/a.md", "x")]);
        assert_eq!(
            detect_units(&docs),
            [RunUnit {
                dir: "".into(),
                runner: Runner::None
            }]
        );
        std::fs::remove_dir_all(&docs).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_entry_files_do_not_count() {
        let outside = project("outside", &[("index.html", "x")]);
        let root = project("linked", &[]);
        std::os::unix::fs::symlink(outside.join("index.html"), root.join("index.html")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("dist")).unwrap();
        assert_eq!(detect(&root), Runner::None);
        // A symlinked folder is no app of its own either.
        assert_eq!(detect_units(&root).len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }
}
