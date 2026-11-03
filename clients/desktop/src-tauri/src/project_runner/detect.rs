//! How a project runs, decided from the files at its root (workbench plan §4.1).
use crate::agent_projects::{project_files, read_small, FileFormat, MAX_MANIFEST_BYTES};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

/// npm scripts that start a project, in order of preference.
const NODE_SCRIPTS: &[&str] = &["dev", "start", "preview"];
const PYTHON_DEPENDENCIES: &[&str] = &["requirements.txt", "pyproject.toml"];
const PYTHON_ENTRIES: &[&str] = &["app.py", "main.py", "streamlit_app.py"];
/// Folders a built or plain site keeps its `index.html` in, in order of preference.
const SITE_DIRS: &[&str] = &["", "dist", "build", "public"];

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

pub fn detect(root: &Path) -> Runner {
    if let Some(script) = node_script(root) {
        return Runner::Node { script };
    }
    if let Some(runner) = python(root) {
        return runner;
    }
    if let Some(dir) = SITE_DIRS
        .iter()
        .find(|dir| plain_file(root, dir, "index.html"))
    {
        return Runner::Static {
            dir: (*dir).to_string(),
        };
    }
    let files: Vec<RunnableFile> = project_files(root)
        .into_iter()
        .filter(|file| file.format == FileFormat::Html)
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

    #[cfg(unix)]
    #[test]
    fn symlinked_entry_files_do_not_count() {
        let outside = project("outside", &[("index.html", "x")]);
        let root = project("linked", &[]);
        std::os::unix::fs::symlink(outside.join("index.html"), root.join("index.html")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("dist")).unwrap();
        assert_eq!(detect(&root), Runner::None);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }
}
