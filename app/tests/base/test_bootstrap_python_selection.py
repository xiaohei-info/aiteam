import pathlib
from unittest.mock import patch

import bootstrap


def test_ensure_python_prefers_agent_venv_when_launcher_cannot_import_agent(monkeypatch, tmp_path):
    """Avoid starting WebUI with a local venv that later cannot import AIAgent."""
    local_python = tmp_path / "webui" / ".venv" / "bin" / "python"
    agent_python = tmp_path / "agent" / "venv" / "bin" / "python"
    agent_python.parent.mkdir(parents=True)
    agent_python.write_text("", encoding="utf-8")

    probes = []

    def fake_can_run(python_exe: str, agent_dir: pathlib.Path | None = None) -> bool:
        probes.append(pathlib.Path(python_exe))
        return pathlib.Path(python_exe) == agent_python

    monkeypatch.setattr(bootstrap, "_python_can_run_webui_and_agent", fake_can_run)

    selected = bootstrap.ensure_python_has_webui_deps(str(local_python), tmp_path / "agent")

    assert selected == str(agent_python)
    assert probes == [local_python, agent_python]


def test_ensure_python_fails_loudly_when_no_interpreter_can_import_agent(monkeypatch, tmp_path):
    """Do not report health OK when chat would fail with missing AIAgent."""
    local_python = tmp_path / "webui" / ".venv" / "bin" / "python"
    agent_python = tmp_path / "agent" / "venv" / "bin" / "python"
    agent_python.parent.mkdir(parents=True)
    agent_python.write_text("", encoding="utf-8")

    # Pretend REPO_ROOT/.venv already exists with a python binary so the function
    # skips venv.EnvBuilder.create() entirely. Without this, CI runners that
    # don't have a .venv try to build one and the monkey-patched subprocess
    # stub (which only covers subprocess.run, not the venv module's internal
    # subprocess.check_output) fails with AttributeError on .stdout. The
    # behavior under test is "what happens when no interpreter can import
    # both WebUI deps and the agent", not the venv-creation path itself.
    fake_venv_python = tmp_path / "fake-repo-venv-python"
    fake_venv_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(bootstrap, "REPO_ROOT", tmp_path)
    # Ensure the .venv/bin/python (or .venv/Scripts/python.exe) path resolves
    # to our fake binary so .exists() returns True and EnvBuilder is skipped.
    venv_subdir = tmp_path / ".venv" / "bin"
    venv_subdir.mkdir(parents=True, exist_ok=True)
    (venv_subdir / "python").write_text("", encoding="utf-8")
    if (tmp_path / ".venv").exists():  # platform-independent guard
        pass

    monkeypatch.setattr(bootstrap, "_python_can_run_webui_and_agent", lambda *a, **k: False)
    # Cover both subprocess.run (used for pip install) and any other subprocess
    # entry points the venv module might invoke. Returning None is fine because
    # we never inspect the result on this code path.
    monkeypatch.setattr(bootstrap.subprocess, "run", lambda *a, **k: None)

    try:
        bootstrap.ensure_python_has_webui_deps(str(local_python), tmp_path / "agent")
    except RuntimeError as exc:
        assert "cannot import both WebUI dependencies and Hermes Agent" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")


def test_local_venv_is_created_with_symlinks(monkeypatch, tmp_path):
    """Regression: mise/asdf macOS Pythons need symlinks=True to avoid SIGABRT.

    Their copy-mode venv produces a python binary referencing
    @executable_path/../lib/libpython3.X.dylib that never gets copied into the
    new .venv. Symlinking keeps @executable_path resolving back to the original
    install. CPython's venv falls back to copy mode if symlink creation fails,
    so this is safe to set unconditionally.
    """
    local_python = tmp_path / "webui" / ".venv" / "bin" / "python"
    monkeypatch.setattr(bootstrap, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(bootstrap, "_python_can_run_webui_and_agent", lambda *a, **k: False)
    monkeypatch.setattr(bootstrap.subprocess, "run", lambda *a, **k: None)

    with patch.object(bootstrap.venv, "EnvBuilder") as mock_builder:
        # Make EnvBuilder().create() materialize the venv python so the post-create
        # `_python_can_run_webui_and_agent` retry path doesn't trip on a missing file.
        venv_python = tmp_path / ".venv" / "bin" / "python"

        def fake_create(target):
            venv_python.parent.mkdir(parents=True, exist_ok=True)
            venv_python.write_text("", encoding="utf-8")

        mock_builder.return_value.create.side_effect = fake_create

        try:
            bootstrap.ensure_python_has_webui_deps(str(local_python), None)
        except RuntimeError:
            pass  # expected — fake _python_can_run_webui_and_agent always returns False

        mock_builder.assert_called_once_with(with_pip=True, symlinks=True)


def test_repo_local_venv_auto_installs_agent_when_webui_deps_exist(monkeypatch, tmp_path):
    """Repo-local .venv should self-heal by installing hermes-agent editable."""
    local_python = tmp_path / ".venv" / "bin" / "python"
    local_python.parent.mkdir(parents=True, exist_ok=True)
    local_python.write_text("", encoding="utf-8")
    agent_dir = tmp_path / "hermes-agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "pyproject.toml").write_text("[project]\nname='hermes-agent'\n", encoding="utf-8")

    monkeypatch.setattr(bootstrap, "REPO_ROOT", tmp_path)

    probes = []

    def fake_can_run(python_exe: str, selected_agent_dir: pathlib.Path | None = None) -> bool:
        probes.append((pathlib.Path(python_exe), pathlib.Path(selected_agent_dir) if selected_agent_dir else None))
        # First probe fails before install, second fails after requirements,
        # third succeeds only after editable agent install.
        return len(probes) >= 3 and pathlib.Path(python_exe) == local_python

    installs = []

    def fake_run(cmd, **kwargs):
        installs.append(cmd)
        return None

    monkeypatch.setattr(bootstrap, "_python_can_run_webui_and_agent", fake_can_run)
    monkeypatch.setattr(bootstrap.subprocess, "run", fake_run)

    selected = bootstrap.ensure_python_has_webui_deps(str(local_python), agent_dir)

    assert selected == str(local_python)
    assert installs[:2] == [
        [str(local_python), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
        [str(local_python), "-m", "pip", "install", "--quiet", "-r", str(tmp_path / "requirements.txt")],
    ]
    assert installs[2] == [
        str(local_python),
        "-m",
        "pip",
        "install",
        "--quiet",
        "-e",
        str(agent_dir),
    ]
    assert probes == [
        (local_python, agent_dir),
        (local_python, agent_dir),
        (local_python, agent_dir),
    ]


def test_external_python_does_not_auto_install_agent(monkeypatch, tmp_path):
    """Non-repo interpreters should fail loudly instead of mutating user envs."""
    external_python = tmp_path / "external" / "bin" / "python"
    external_python.parent.mkdir(parents=True, exist_ok=True)
    external_python.write_text("", encoding="utf-8")
    agent_dir = tmp_path / "hermes-agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    repo_root = tmp_path / "repo"
    monkeypatch.setattr(bootstrap, "REPO_ROOT", repo_root)
    monkeypatch.setattr(bootstrap, "_python_can_run_webui_and_agent", lambda *a, **k: False)

    repo_venv_python = repo_root / ".venv" / "bin" / "python"
    repo_venv_python.parent.mkdir(parents=True, exist_ok=True)
    repo_venv_python.write_text("", encoding="utf-8")

    installs = []

    def fake_run(cmd, **kwargs):
        installs.append(cmd)
        return None

    monkeypatch.setattr(bootstrap.subprocess, "run", fake_run)

    try:
        bootstrap.ensure_python_has_webui_deps(str(external_python), agent_dir)
    except RuntimeError as exc:
        assert "cannot import both WebUI dependencies and Hermes Agent" in str(exc)
    else:
        raise AssertionError("expected RuntimeError")

    assert installs == [
        [str(repo_venv_python), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
        [str(repo_venv_python), "-m", "pip", "install", "--quiet", "-r", str(repo_root / "requirements.txt")],
    ]
