use super::*;
use serde_json::json;
use std::io::Cursor;

const START: i64 = 1_800_000_000_000;

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "aiteam-projects-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// Fixture homes use this platform's native absolute form: `Path::is_absolute` only accepts a
/// native path, so a POSIX `/Users/me` can never resolve on Windows.
fn home_dir() -> &'static str {
    if cfg!(windows) {
        r"C:\Users\me"
    } else {
        "/Users/me"
    }
}

fn path(base: &str, rest: &str) -> String {
    Path::new(base).join(rest).to_string_lossy().into_owned()
}

fn lines(values: &[Value]) -> Cursor<Vec<u8>> {
    let mut text = String::new();
    for value in values {
        text.push_str(&value.to_string());
        text.push('\n');
    }
    Cursor::new(text.into_bytes())
}

fn fake_births(entries: &[(&str, Birth)]) -> impl FnMut(&Path) -> Birth {
    let births: HashMap<PathBuf, Birth> = entries
        .iter()
        .map(|(path, birth)| (PathBuf::from(path), *birth))
        .collect();
    move |path: &Path| births.get(path).copied().unwrap_or(Birth::Missing)
}

fn root_of(file: &str, births: &mut impl FnMut(&Path) -> Birth) -> Option<String> {
    project_root(Path::new(file), START, Path::new("/h"), births)
        .unwrap()
        .map(|root| root.display().to_string())
}

#[test]
fn project_root_is_the_outermost_folder_created_after_the_session_started() {
    let old = Birth::At(START - 86_400_000);
    let new = Birth::At(START + 1_000);
    let mut births = fake_births(&[
        ("/h/game", new),
        ("/h/game/js", new),
        ("/h/Desktop", old),
        ("/h/early", Birth::At(START - 60_000)),
        ("/h/stale", Birth::At(START - 180_000)),
        ("/h/gone", new),
    ]);
    assert_eq!(
        root_of("/h/game/js/app.js", &mut births).as_deref(),
        Some("/h/game")
    );
    assert_eq!(
        root_of("/h/game/index.html", &mut births).as_deref(),
        Some("/h/game")
    );
    // Written into a folder the user already had, or straight into home.
    assert_eq!(root_of("/h/Desktop/page.html", &mut births), None);
    assert_eq!(root_of("/h/notes.md", &mut births), None);
    // Folders made shortly before the first record still count.
    assert_eq!(
        root_of("/h/early/a.py", &mut births).as_deref(),
        Some("/h/early")
    );
    assert_eq!(root_of("/h/stale/a.py", &mut births), None);
    // Deeper folders deleted since the session do not hide the one left.
    assert_eq!(
        root_of("/h/gone/deeper/a.txt", &mut births).as_deref(),
        Some("/h/gone")
    );
}

#[test]
fn project_root_skips_existing_projects_hidden_and_outside_folders() {
    let old = Birth::At(START - 86_400_000);
    let new = Birth::At(START + 1_000);
    let mut births = fake_births(&[
        ("/h/repo", old),
        ("/h/repo/.git", old),
        ("/h/repo/src", old),
        ("/h/repo/src/api", new),
        ("/h/work", old),
        ("/h/work/package.json", Birth::At(START + 5_000)),
        ("/h/work/app", new),
        ("/h/.codex/out", new),
        ("/h/Library/x", new),
        ("/other/new", new),
    ]);
    // A new folder inside a repository the user already had belongs to that repository.
    assert_eq!(root_of("/h/repo/src/api/client.ts", &mut births), None);
    // A marker the session created itself does not make the parent the user's.
    assert_eq!(
        root_of("/h/work/app/main.py", &mut births).as_deref(),
        Some("/h/work/app")
    );
    assert_eq!(root_of("/h/.codex/out/a.md", &mut births), None);
    assert_eq!(root_of("/h/Library/x/a.md", &mut births), None);
    assert_eq!(root_of("/other/new/a.md", &mut births), None);
    assert_eq!(root_of("/h/game/../repo/a.md", &mut births), None);

    let mut unknown = fake_births(&[("/h/x", Birth::Unknown)]);
    assert_eq!(
        project_root(Path::new("/h/x/a.md"), START, Path::new("/h"), &mut unknown),
        Err(CreationTimeUnavailable)
    );
}

#[test]
fn nested_project_folders_merge_into_the_outer_one() {
    let dirs = vec![
        PathBuf::from("/h/a/b"),
        PathBuf::from("/h/a-b"),
        PathBuf::from("/h/a"),
        PathBuf::from("/h/c"),
    ];
    assert_eq!(
        drop_nested(dirs),
        [
            PathBuf::from("/h/a"),
            PathBuf::from("/h/a-b"),
            PathBuf::from("/h/c")
        ]
    );
}

#[test]
fn project_listing_skips_hidden_dependency_empty_sensitive_and_linked_files() {
    let root = temp_root("listing");
    let outside = temp_root("listing-outside");
    for (name, text) in [
        ("index.html", "<h1>hi</h1>"),
        ("js/app.js", "console.log(1)"),
        ("empty.txt", ""),
        (".env", "TOKEN=1"),
        (".git/config", "[core]"),
        ("node_modules/pkg/index.js", "x"),
        ("__pycache__/a.pyc", "x"),
        ("venv/bin/python", "x"),
        ("secrets.json", "{}"),
        ("server.pem", "-----BEGIN"),
    ] {
        write(&root.join(name), text);
    }
    write(&outside.join("real.txt"), "outside");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("real.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked-dir")).unwrap();
    }

    let listing = list_project(&root, MAX_PROJECT_FILES);
    let paths: Vec<_> = listing
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    assert_eq!(paths, ["index.html", "js/app.js"]);
    assert!(!listing.truncated);
    assert_eq!(listing.files[0].format, FileFormat::Html);
    assert_eq!(listing.files[1].format, FileFormat::Code);
    assert_eq!(listing.files[1].id, file_id("js/app.js"));

    let limited = list_project(&root, 1);
    assert_eq!(limited.files.len(), 1);
    assert!(limited.truncated);
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::remove_dir_all(&outside).unwrap();
}

#[test]
fn project_info_reads_package_names_and_the_readme_summary() {
    assert_eq!(
        package_name(r#"{"name": "snake-game"}"#).as_deref(),
        Some("snake-game")
    );
    assert_eq!(package_name("not json"), None);
    let pyproject = "[build-system]\nname = \"wrong\"\n\n[project]\nname = 'sales-dashboard'\n";
    assert_eq!(
        pyproject_name(pyproject).as_deref(),
        Some("sales-dashboard")
    );
    assert_eq!(
        pyproject_name("[tool.poetry]\nname=\"poem\"").as_deref(),
        Some("poem")
    );
    let readme = "# 贪吃蛇\n\n[![ci](x)](y)\n\n```bash\nnpm i\n```\n\n一个在浏览器里玩的\n贪吃蛇小游戏。\n\n## 运行";
    assert_eq!(
        readme_summary(readme).as_deref(),
        Some("一个在浏览器里玩的 贪吃蛇小游戏。")
    );
    assert_eq!(
        readme_summary("# Title\nIntro line"),
        Some("Intro line".into())
    );
    assert_eq!(readme_summary("# Only a heading"), None);

    let root = temp_root("info");
    write(&root.join("package.json"), r#"{"name":"vite-app"}"#);
    write(&root.join("README.md"), "A Vite app.");
    assert_eq!(
        project_info(&root),
        ProjectInfo {
            name: Some("vite-app".into()),
            description: Some("A Vite app.".into())
        }
    );
    std::fs::remove_dir_all(&root).unwrap();
}

fn codex_meta(extra: Value) -> Value {
    let mut payload = json!({
        "id": "thread-1",
        "timestamp": "2026-10-01T10:00:00Z",
        "cwd": home_dir(),
    });
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({ "type": "session_meta", "payload": payload })
}

fn codex_change(status: &str, changes: Value) -> Value {
    json!({ "type": "event_msg", "timestamp": "2026-10-01T10:05:00Z", "payload": {
        "type": "item_completed", "turn_id": "t1",
        "item": { "type": "FileChange", "status": status, "changes": changes } } })
}

#[test]
fn codex_records_written_files_models_and_the_first_prompt() {
    let home = home_dir();
    let mut completed = serde_json::Map::new();
    completed.insert(
        "game/index.html".to_string(),
        json!({ "type": "add", "content": "<html>" }),
    );
    completed.insert(
        path(home, "game/old.js"),
        json!({
            "type": "update",
            "unified_diff": "",
            "move_path": path(home, "game/main.js"),
        }),
    );
    completed.insert(path(home, "game/tmp.txt"), json!({ "type": "delete" }));
    let mut failed = serde_json::Map::new();
    failed.insert(
        path(home, "game/broken.js"),
        json!({ "type": "add", "content": "x" }),
    );
    let session = parse_codex(lines(&[
        codex_meta(json!({})),
        json!({ "type": "turn_context", "payload": { "model": "gpt-5.5" } }),
        json!({ "type": "event_msg", "payload": { "type": "user_message", "turn_id": "t1", "message": "做一个贪吃蛇小游戏\n要能暂停" } }),
        codex_change("completed", Value::Object(completed)),
        codex_change("failed", Value::Object(failed)),
    ]))
    .unwrap();
    assert_eq!(session.id, "thread-1");
    assert_eq!(
        session.created_at,
        parse_rfc3339_millis("2026-10-01T10:00:00Z")
    );
    assert_eq!(session.title.as_deref(), Some("做一个贪吃蛇小游戏"));
    let mut writes: Vec<_> = session
        .writes
        .iter()
        .map(|(path, model)| (path.as_str(), model.as_deref()))
        .collect();
    writes.sort();
    let index = path(home, "game/index.html");
    let main = path(home, "game/main.js");
    assert_eq!(
        writes,
        [
            (index.as_str(), Some("gpt-5.5")),
            (main.as_str(), Some("gpt-5.5"))
        ]
    );
    assert!(parse_codex(lines(&[codex_meta(json!({ "thread_source": "subagent" }))])).is_none());
}

fn claude_line(kind: &str, message: Value) -> Value {
    json!({ "type": kind, "sessionId": "c1", "cwd": path(home_dir(), "app"),
        "timestamp": "2026-10-01T10:00:00Z", "message": message })
}

#[test]
fn claude_records_only_file_tools_that_succeeded() {
    let app = path(home_dir(), "app");
    let session = parse_claude(lines(&[
        claude_line("user", json!({ "content": "做个落地页" })),
        claude_line(
            "assistant",
            json!({ "model": "claude-opus-5-5", "content": [
            { "type": "tool_use", "id": "w1", "name": "Write", "input": { "file_path": "site/index.html", "content": "x" } },
            { "type": "tool_use", "id": "w2", "name": "Write", "input": { "file_path": path(&app, "site/bad.html"), "content": "x" } },
            { "type": "tool_use", "id": "b1", "name": "Bash", "input": { "command": "ls" } }] }),
        ),
        claude_line(
            "user",
            json!({ "content": [
            { "type": "tool_result", "tool_use_id": "w1" },
            { "type": "tool_result", "tool_use_id": "w2", "is_error": true },
            { "type": "tool_result", "tool_use_id": "b1" }] }),
        ),
        json!({ "type": "ai-title", "aiTitle": "落地页" }),
    ]));
    assert_eq!(session.id, "c1");
    assert_eq!(session.title.as_deref(), Some("落地页"));
    assert_eq!(session.first_prompt.as_deref(), Some("做个落地页"));
    assert_eq!(
        session.writes,
        [(
            path(&app, "site/index.html"),
            Some("claude-opus-5-5".to_string())
        )]
    );
}

fn creation_times_supported(dir: &Path) -> bool {
    let supported = std::fs::metadata(dir)
        .and_then(|meta| meta.created())
        .is_ok();
    if !supported {
        eprintln!("skipped: this file system does not record creation times");
    }
    supported
}

#[test]
fn scan_finds_projects_from_every_source_on_disk() {
    let home = temp_root("scan");
    if !creation_times_supported(&home) {
        std::fs::remove_dir_all(&home).unwrap();
        return;
    }
    let at = |path: &str| home.join(path).display().to_string();
    let app = home.join("Library/Application Support/Claude");
    let cowork = app.join("local-agent-mode-sessions");

    // Codex: a new game folder becomes a project; a file written straight into home does not,
    // and nor does a session that started after the folder existed.
    write(&home.join("game/index.html"), "<canvas></canvas>");
    write(&home.join("game/js/app.js"), "start()");
    write(&home.join("game/README.md"), "# Snake\n\n浏览器贪吃蛇。");
    write(&home.join("notes.md"), "notes");
    write(&home.join("repo/src/new.py"), "print(1)");
    let rollout = |meta_time: &str, files: &[String]| {
        let changes: serde_json::Map<String, Value> = files
            .iter()
            .map(|file| (file.clone(), json!({ "type": "add", "content": "x" })))
            .collect();
        let bytes = lines(&[
            json!({ "type": "session_meta", "payload": { "id": "codex-1", "timestamp": meta_time, "cwd": home } }),
            json!({ "type": "turn_context", "payload": { "model": "deepseek-v4" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "写个贪吃蛇" } }),
            codex_change("completed", Value::Object(changes)),
        ])
        .into_inner();
        String::from_utf8(bytes).unwrap()
    };
    write(
        &home.join(".codex/sessions/2026/10/01/rollout-1.jsonl"),
        &rollout(
            "2026-10-01T10:00:00Z",
            &[at("game/index.html"), at("game/js/app.js"), at("notes.md")],
        ),
    );
    write(
        &home.join(".codex/sessions/2100/01/01/rollout-2.jsonl"),
        &rollout("2100-01-01T00:00:00Z", &[at("repo/src/new.py")]),
    );
    write(
        &home.join(".codex/session_index.jsonl"),
        &json!({ "id": "codex-1", "thread_name": "贪吃蛇小游戏" }).to_string(),
    );

    // Claude Code, a session the desktop Code tab lists, and a Cowork session.
    let transcript = |id: &str, file: String| {
        let bytes = lines(&[
            json!({ "type": "user", "sessionId": id, "cwd": home, "timestamp": "2026-10-01T10:00:00Z", "message": { "content": "做网页" } }),
            json!({ "type": "assistant", "sessionId": id, "message": { "model": "claude-opus-5-5", "content": [
                { "type": "tool_use", "id": "w", "name": "Write", "input": { "file_path": file, "content": "x" } }] } }),
            json!({ "type": "user", "sessionId": id, "message": { "content": [{ "type": "tool_result", "tool_use_id": "w" }] } }),
        ])
        .into_inner();
        String::from_utf8(bytes).unwrap()
    };
    write(&home.join("site/index.html"), "<p>site</p>");
    write(&home.join("tab/page.html"), "<p>tab</p>");
    write(
        &home.join(".claude/projects/-home/s-cli.jsonl"),
        &transcript("s-cli", at("site/index.html")),
    );
    write(
        &home.join(".claude/projects/-home/s-tab.jsonl"),
        &transcript("s-tab", at("tab/page.html")),
    );
    write(
        &app.join("claude-code-sessions/acct/org/local_1.json"),
        &json!({ "cliSessionId": "s-tab", "title": "桌面端网页" }).to_string(),
    );
    // Discovery walks the tree component by component, so it rebuilds the path with native
    // separators; joining these segments one at a time keeps the fixture in the same shape.
    let storage = cowork
        .join("org")
        .join("acct")
        .join("agent")
        .join("local_2");
    write(
        &cowork.join("org/acct/agent/local_2.json"),
        &json!({ "cliSessionId": "s-cowork", "title": "Cowork 周报" }).to_string(),
    );
    write(
        &storage.join(".claude/projects/-sessions-owl/s-cowork.jsonl"),
        &transcript("s-cowork", "/sessions/owl/mnt/outputs/周报.md".into()),
    );
    write(&storage.join("outputs/周报.md"), "周报");

    // WorkBuddy: task folders only, named by their session when it is still there.
    let task = home.join("WorkBuddy/2026-10-28-21-36-00");
    write(&task.join("app.py"), "import streamlit");
    write(&home.join("WorkBuddy/2026-10-29-08-00-00/empty.txt"), "");
    write(&home.join("WorkBuddy/Claw/notes.md"), "not a task folder");
    write(
        &home.join(".workbuddy/projects/p/wb-1.jsonl"),
        &[
            json!({ "type": "message", "role": "user", "sessionId": "wb-1", "cwd": task, "timestamp": 1_790_000_000_000_i64,
                "_meta": { "baggage": "buddyId=1,buddyName=%E6%95%B0%E6%8D%AE%E5%B8%88" },
                "content": [{ "type": "input_text", "text": "<user_query>做销售看板</user_query>" }] }),
            json!({ "type": "ai-title", "aiTitle": "销售看板" }),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n"),
    );

    let roots = Roots {
        home: home.clone(),
        codex: home.join(".codex"),
        claude: home.join(".claude"),
        claude_app: Some(app),
        cowork: Some(cowork),
        workbuddy: home.join(".workbuddy"),
        workbuddy_tasks: home.join("WorkBuddy"),
    };
    let mut cache = Cache::default();
    let (statuses, projects) = cache.refresh(&roots);
    let mut found: Vec<_> = projects
        .iter()
        .map(|project| {
            (
                project.source,
                project.location.as_str(),
                project.name.as_str(),
                project.employee_name.as_str(),
            )
        })
        .collect();
    found.sort();
    // The fixture keeps the POSIX separators inside its first literal segment, so the expected
    // location is derived from the fixture path rather than from a hand-written separator.
    let cowork_location = format!(
        "~/{}",
        storage
            .join("outputs")
            .strip_prefix(&home)
            .unwrap()
            .display()
    );
    assert_eq!(
        found,
        [
            (AgentSource::Codex, "~/game", "贪吃蛇小游戏", "Codex"),
            (AgentSource::Claude, "~/site", "做网页", "Claude Code"),
            (
                AgentSource::ClaudeDesktop,
                cowork_location.as_str(),
                "Cowork 周报",
                "Claude"
            ),
            (AgentSource::ClaudeDesktop, "~/tab", "桌面端网页", "Claude"),
            (
                AgentSource::Workbuddy,
                "~/WorkBuddy/2026-10-28-21-36-00",
                "销售看板",
                "数据师"
            ),
        ]
    );
    let game = projects
        .iter()
        .find(|project| project.location == "~/game")
        .unwrap();
    assert_eq!(game.description.as_deref(), Some("浏览器贪吃蛇。"));
    assert_eq!(game.models, ["deepseek-v4"]);
    assert_eq!(game.file_count, 3);
    let count = |source| {
        statuses
            .iter()
            .find(|status| status.source == source)
            .unwrap()
            .project_count
    };
    assert_eq!(count(AgentSource::ClaudeDesktop), 2);
    assert!(statuses
        .iter()
        .all(|status| status.available && !status.creation_time_unavailable));

    // Files are read and addressed by opaque ids only.
    let readme = game
        .files
        .iter()
        .find(|file| file.path == "README.md")
        .unwrap();
    let root = cache.index[&(AgentSource::Codex, game.id.clone())].clone();
    assert_eq!(root, home.join("game"));
    let content = read_project_file_at(&root, &readme.id).unwrap();
    assert_eq!(
        content.content.as_deref(),
        Some("# Snake\n\n浏览器贪吃蛇。")
    );
    std::fs::remove_dir_all(&home).unwrap();
}

#[test]
fn project_files_are_previewed_by_format_and_size() {
    let root = temp_root("read");
    write(&root.join("notes.md"), "# 标题");
    write(&root.join("Makefile"), "run:\n\tpython app.py\n");
    std::fs::write(root.join("data.bin"), [0_u8, 159, 146, 150]).unwrap();
    std::fs::write(root.join("logo.png"), [137_u8, 80, 78, 71]).unwrap();
    write(
        &root.join("big.md"),
        &"x".repeat(MAX_PREVIEW_BYTES as usize + 1),
    );
    let read = |path: &str| read_project_file_at(&root, &file_id(path));

    let notes = read("notes.md").unwrap();
    assert_eq!(
        (notes.format, notes.content.as_deref()),
        (FileFormat::Markdown, Some("# 标题"))
    );
    let makefile = read("Makefile").unwrap();
    assert_eq!(makefile.format, FileFormat::Text);
    assert!(makefile
        .content
        .is_some_and(|text| text.contains("python app.py")));
    let binary = read("data.bin").unwrap();
    assert_eq!((binary.format, binary.content), (FileFormat::Other, None));
    assert_eq!(read("logo.png").unwrap().content, None);
    assert_eq!(read("big.md").unwrap_err(), "file_too_large");
    assert_eq!(read("missing.md").unwrap_err(), "file_not_found");
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn fred_workspaces_are_addressed_by_validated_keys_only() {
    let root = temp_root("fred");
    let key = format!("conversation-{}", "a1".repeat(12));
    let empty = format!("conversation-{}", "b2".repeat(12));
    write(&root.join(&key).join("index.html"), "<p>fred</p>");
    write(
        &root.join(&key).join("package.json"),
        r#"{"name":"fred-game"}"#,
    );
    std::fs::create_dir_all(root.join(&empty)).unwrap();
    let outside = temp_root("fred-outside");
    write(&outside.join("secret.html"), "x");
    let linked = format!("conversation-{}", "c3".repeat(12));
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join(&linked)).unwrap();

    let keys = [
        key.clone(),
        key.clone(),
        empty.clone(),
        linked.clone(),
        format!("conversation-{}", "d4".repeat(12)),
    ];
    let list = list_fred_workspaces(&root, &keys).unwrap();
    assert!(!list.truncated);
    let workspaces = list.workspaces;
    let listed: Vec<_> = workspaces
        .iter()
        .map(|workspace| (workspace.workspace_key.as_str(), workspace.file_count))
        .collect();
    assert_eq!(listed, [(key.as_str(), 2), (empty.as_str(), 0)]);
    assert_eq!(workspaces[0].name.as_deref(), Some("fred-game"));

    let too_long = "长".repeat(129);
    for bad in [
        "",
        "../x",
        ".hidden",
        "会话-a1b2c3/.cache",
        "a/b/c",
        "a/",
        "/a",
        "a\\b",
        "a\u{7f}b",
        too_long.as_str(),
        &format!("conversation-{}/..", "a1".repeat(12)),
    ] {
        assert_eq!(
            fred_workspace(&root, bad).unwrap_err(),
            "invalid_workspace_key"
        );
    }
    assert_eq!(fred_workspace(&root, &linked).unwrap(), None);
    assert!(valid_workspace_key(&"长".repeat(128)));
    // Past the limit the newest stay and the page is told the rest were left out.
    let capped = list_fred_workspaces_up_to(&root, &keys, 1).unwrap();
    assert_eq!(capped.workspaces.len(), 1);
    assert!(capped.truncated);
    assert_eq!(
        parse_target("fred", &key, Some("0123456789abcdef")).unwrap(),
        AgentSource::Fred
    );
    assert_eq!(
        parse_target("fred", "../0123456789abcdef", None).unwrap_err(),
        "invalid_project_id"
    );
    assert_eq!(
        parse_target("codex", &key, None).unwrap_err(),
        "invalid_project_id"
    );
    assert_eq!(
        parse_target("codex", "0123456789abcdef", Some("../a")).unwrap_err(),
        "invalid_file_id"
    );
    assert_eq!(
        parse_target("trae", "0123456789abcdef", None).unwrap_err(),
        "invalid_source"
    );
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::remove_dir_all(&outside).unwrap();
}

#[test]
fn sources_round_trip_through_their_ids() {
    for source in [AgentSource::Fred].into_iter().chain(AgentSource::SCANNED) {
        let id = serde_json::to_value(source).unwrap();
        assert_eq!(AgentSource::parse(id.as_str().unwrap()), Some(source));
    }
}

#[test]
fn parses_rfc3339_timestamps() {
    assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        parse_rfc3339_millis("2026-10-01T10:00:00.5+02:00"),
        Some(1_790_841_600_500)
    );
    assert_eq!(parse_rfc3339_millis("2026-13-01T10:00:00Z"), None);
}

#[test]
fn conversation_named_workspaces_resolve_one_or_two_levels_without_links() {
    let root = std::env::temp_dir().join(format!("aiteam-fred-layout-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("热门AI项目总结-44f964")).unwrap();
    std::fs::write(root.join("热门AI项目总结-44f964").join("report.md"), "报告").unwrap();
    std::fs::create_dir_all(root.join("前端招聘组-22527b").join("产品经理")).unwrap();
    std::fs::write(
        root.join("前端招聘组-22527b")
            .join("产品经理")
            .join("index.html"),
        "<p>x</p>",
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("前端招聘组-22527b"), root.join("链接组-cccccc")).unwrap();

    let keys = [
        "热门AI项目总结-44f964".to_string(),
        "前端招聘组-22527b/产品经理".to_string(),
        "链接组-cccccc/产品经理".to_string(),
    ];
    let listed: Vec<_> = list_fred_workspaces(&root, &keys)
        .unwrap()
        .workspaces
        .into_iter()
        .map(|workspace| (workspace.workspace_key, workspace.file_count))
        .collect();
    assert_eq!(
        listed,
        [
            ("热门AI项目总结-44f964".to_string(), 1),
            ("前端招聘组-22527b/产品经理".to_string(), 1)
        ]
    );
    assert_eq!(
        fred_workspace(&root, "前端招聘组-22527b/产品经理").unwrap(),
        Some(root.join("前端招聘组-22527b").join("产品经理"))
    );
    #[cfg(unix)]
    assert_eq!(
        fred_workspace(&root, "链接组-cccccc/产品经理").unwrap(),
        None
    );
    assert_eq!(
        fred_workspace_display_path(&root, "前端招聘组-22527b").unwrap(),
        root.join("前端招聘组-22527b").to_string_lossy()
    );
    assert_eq!(
        fred_workspace_display_path(&root, "不存在-000000").unwrap_err(),
        "project_not_found"
    );
    assert_eq!(
        fred_workspace_display_path(&root, "../escape").unwrap_err(),
        "invalid_workspace_key"
    );
    assert_eq!(
        parse_target("fred", "前端招聘组-22527b/产品经理", None).unwrap(),
        AgentSource::Fred
    );
    std::fs::remove_dir_all(&root).unwrap();
}

fn home_from(pairs: &[(&str, &str)]) -> Option<PathBuf> {
    home_dir_from(|name| {
        pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| std::ffi::OsString::from(value))
    })
}

/// Windows shells export USERPROFILE (or HOMEDRIVE+HOMEPATH) instead of HOME, and the HOME a Git Bash
/// parent sets is a POSIX path — a scan that only read HOME reported `home_unavailable` there.
#[test]
fn home_falls_back_to_windows_variables() {
    assert_eq!(
        home_from(&[("HOME", "/c/Users/me"), ("USERPROFILE", home_dir())]),
        Some(PathBuf::from(home_dir()))
    );
    assert_eq!(home_from(&[("HOME", "")]), None);
    assert_eq!(home_from(&[("HOME", "relative/dir")]), None);
}

#[cfg(windows)]
#[test]
fn windows_home_variables_resolve_without_home() {
    assert_eq!(
        home_from(&[("USERPROFILE", r"C:\Users\me")]),
        Some(PathBuf::from(r"C:\Users\me"))
    );
    assert_eq!(
        home_from(&[("HOMEDRIVE", "C:"), ("HOMEPATH", r"\Users\me")]),
        Some(PathBuf::from(r"C:\Users\me"))
    );
    // A Git Bash HOME is not an absolute Windows path and must not win over USERPROFILE.
    assert_eq!(home_from(&[("HOME", "/c/Users/me")]), None);
    assert!(super::home_dir().is_some(), "the local scan needs a home directory on Windows");
}
