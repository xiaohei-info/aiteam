"""Agent-terminal capability tests (GitHub #300 gap).

Covers the four unblocked capabilities:
  T01 - Terminal session management (create / duplicate / resize / close).
  T02 - Command execution (bash) with output capture.
  T03 - Output streaming via the bounded ption queue.
  T04 - Per-run working-directory isolation.

Linux-only tests that spawn a real PTY are gated with skipif, mirroring
``tests.base.test_terminal_linux_lifecycle``.  Pure-logic tests run on all
platforms so the CI contract is exercised everywhere.
"""

import os
import queue
import sys
import time
import threading

import pytest

# The agent_gateway package lives under <repo>/app.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
APP_DIR = os.path.join(REPO_ROOT, "app")
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

import agent_gateway.terminal as terminal  # noqa: E402
from agent_gateway.terminal import (  # noqa: E402
    TerminalSession,
    close_all_terminals,
    close_terminal,
    get_terminal,
    resize_terminal,
    start_terminal,
    write_terminal,
)


LINUX = sys.platform.startswith("linux")


@pytest.mark.skipif(not LINUX, reason="PTY tests require Linux")
class TestTerminalLifecycleLinux:
    """T01 — create / duplicate-skip / resize / close / reap."""

    def test_start_creates_live_terminal(self, tmp_path):
        sid = f"t01-live-{os.getpid()}"
        term = start_terminal(sid, tmp_path, rows=10, cols=50)
        try:
            assert isinstance(term, TerminalSession)
            assert term.session_id == sid
            assert term.rows == 10
            assert term.cols == 50
            assert term.proc.poll() is None
            assert term.is_alive()
            assert term.workspace == str(tmp_path.resolve())
        finally:
            assert close_terminal(sid) is True

    def test_start_reuses_live_session_in_place(self, tmp_path):
        sid = f"t01-reuse-{os.getpid()}"
        term = start_terminal(sid, tmp_path, rows=10, cols=50)
        try:
            again = start_terminal(sid, tmp_path, rows=10, cols=50)
            assert again is term
        finally:
            close_terminal(sid)

    def test_start_restarts_when_requested(self, tmp_path):
        sid = f"t01-restart-{os.getpid()}"
        term = start_terminal(sid, tmp_path)
        pid_before = term.proc.pid
        try:
            restarted = start_terminal(sid, tmp_path, restart=True)
            assert restarted is not term
            # Old shell should have been reaped.
            assert not term.is_alive() or term.proc.pid != pid_before
        finally:
            close_terminal(sid)

    def test_resize_updates_size(self, tmp_path):
        sid = f"t01-resize-{os.getpid()}"
        term = start_terminal(sid, tmp_path, rows=24, cols=80)
        try:
            resize_terminal(sid, rows=40, cols=120)
            assert term.rows == 40
            assert term.cols == 120
            resize_terminal(sid, rows=1000, cols=1000)  # clamps to max
            assert term.rows == 80
            assert term.cols == 240
        finally:
            close_terminal(sid)

    def test_close_reaps_shell_and_marks_dead(self, tmp_path):
        sid = f"t01-close-{os.getpid()}"
        term = start_terminal(sid, tmp_path)
        assert close_terminal(sid) is True
        # Shell reaped.
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and term.proc.poll() is None:
            time.sleep(0.05)
        assert term.proc.poll() is not None
        assert get_terminal(sid) is None
        # Idempotent close.
        assert close_terminal(sid) is False


@pytest.mark.skipif(not LINUX, reason="PTY tests require Linux")
class TestCommandExecutionAndStreaming:
    """T02 + T03 — command execution + output streaming."""

    def test_write_a_command_and_capture_output(self, tmp_path):
        sid = f"t02-echo-{os.getpid()}"
        marker = f"agent-term-marker-{os.getpid()}"
        term = start_terminal(sid, tmp_path)
        try:
            write_terminal(sid, f"printf '{marker}\\n'\n")
            seen = ""
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                try:
                    event, payload = term.output.get(timeout=0.2)
                except queue.Empty:
                    if not term.is_alive():
                        break
                    continue
                if event == "output":
                    seen += payload.get("text", "")
                    if f"{marker}" in seen:
                        break
            assert f"{marker}" in seen
        finally:
            close_terminal(sid)

    def test_output_streaming_terminal_closed_event(self, tmp_path):
        sid = f"t02-closed-{os.getpid()}"
        term = start_terminal(sid, tmp_path)
        write_terminal(sid, "exit\n")
        got_closed = False
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                event, payload = term.output.get(timeout=0.2)
            except queue.Empty:
                if not term.is_alive():
                    break
                continue
            if event == "terminal_closed":
                got_closed = True
                assert isinstance(payload.get("exit_code"), int)
                break
        assert got_closed
        close_terminal(sid)


@pytest.mark.skipif(not LINUX, reason="PTY tests require Linux")
class TestWorkingDirectoryIsolation:
    """T04 — commands run in the terminal's own cwd."""

    def test_command_sees_terminal_workspace_as_cwd(self, tmp_path):
        sid = f"t04-cwd-{os.getpid()}"
        term = start_terminal(sid, tmp_path, rows=10, cols=40)
        try:
            write_terminal(sid, "pwd\n")
            seen = str(tmp_path.resolve())
            collected = ""
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                try:
                    event, payload = term.output.get(timeout=0.2)
                except queue.Empty:
                    if not term.is_alive():
                        break
                    continue
                if event == "output":
                    collected += payload.get("text", "")
                    if seen in collected:
                        break
            assert seen in collected
        finally:
            close_terminal(sid)

    def test_runs_in_different_workdirs_are_isolated(self, tmp_path):
        a = tmp_path / "a"
        b = tmp_path / "b"
        a.mkdir()
        b.mkdir()
        sid_a = f"t04-iso-a-{os.getpid()}"
        sid_b = f"t04-iso-b-{os.getpid()}"
        term_a = start_terminal(sid_a, a, rows=10, cols=40)
        term_b = start_terminal(sid_b, b, rows=10, cols=40)
        try:
            def collect_cwd(term, needle, timeout=5.0):
                text = ""
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    try:
                        ev, pl = term.output.get(timeout=0.2)
                    except queue.Empty:
                        if not term.is_alive():
                            break
                        continue
                    if ev == "output":
                        text += pl.get("text", "")
                        if needle in text:
                            return True
                return False

            write_terminal(sid_a, "pwd\n")
            write_terminal(sid_b, "pwd\n")
            assert collect_cwd(term_a, str(a.resolve()))
            assert collect_cwd(term_b, str(b.resolve()))
            # Best-effort guard: B should NOT show up as A's cwd.
            text_a = ""
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                try:
                    ev, pl = term_a.output.get(timeout=0.1)
                    if ev == "output":
                        text_a += pl.get("text", "")
                except queue.Empty:
                    if not term_a.is_alive():
                        break
                    continue
            assert str(b.resolve()) not in text_a
        finally:
            close_terminal(sid_a)
            close_terminal(sid_b)


class TestPureLogicAllPlatforms:
    """Logic that doesn't need a PTY — run on every platform."""

    def test_close_all_terminals_is_safe_when_empty(self):
        close_all_terminals()  # no-op, must not raise

    def test_get_terminal_returns_none_for_unknown(self):
        assert get_terminal(f"nope-{os.getpid()}") is None

    def test_write_terminal_raises_for_unknown(self):
        with pytest.raises(KeyError):
            write_terminal(f"nope-{os.getpid()}", "echo hi\n")

    def test_resize_terminal_raises_for_unknown(self):
        with pytest.raises(KeyError):
            resize_terminal(f"nope-{os.getpid()}", 24, 80)

    @pytest.mark.skipif(not LINUX, reason="PTY tests require Linux")
    def test_shell_env_has_safe_keys_only(self, tmp_path):
        sid = f"tlogic-env-{os.getpid()}"
        term = start_terminal(sid, tmp_path)
        try:
            write_terminal(sid, "env\n")
            collected = ""
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                try:
                    ev, pl = term.output.get(timeout=0.2)
                except queue.Empty:
                    if not term.is_alive():
                        break
                    continue
                if ev == "output":
                    collected += pl.get("text", "")
                    if "AITEAM_AGENT_TERMINAL=" in collected:
                        break
            # Marker env var present.
            assert "AITEAM_AGENT_TERMINAL=1" in collected
            # And a server-side secret allowlist key is NOT leaked.
            assert "HERMES_WEBUI_PASSWORD" not in collected
        finally:
            close_terminal(sid)


@pytest.mark.skipif(not LINUX, reason="PTY tests require Linux")
class TestSpawnSupervisorRobustness:
    """Reap semantics mirroring tests.base.test_terminal_linux_lifecycle."""

    def test_spawn_delegates_popen_to_supervisor_thread(self, monkeypatch, tmp_path):
        sid = f"tspawn-deleg-{os.getpid()}"
        request_thread_id = None
        popen_thread_id = None
        real_popen = terminal.subprocess.Popen

        def tracking_popen(*args, **kwargs):
            nonlocal popen_thread_id
            popen_thread_id = threading.get_ident()
            return real_popen(*args, **kwargs)

        monkeypatch.setattr(terminal.subprocess, "Popen", tracking_popen)
        result = queue.Queue()

        def request_thread():
            nonlocal request_thread_id
            request_thread_id = threading.get_ident()
            try:
                result.put(start_terminal(sid, tmp_path, rows=8, cols=40, restart=True))
            except Exception as exc:  # noqa: BLE001
                result.put(exc)

        thread = threading.Thread(target=request_thread)
        thread.start()
        thread.join(timeout=2.0)
        assert not thread.is_alive()
        term = result.get(timeout=2.0)
        if isinstance(term, Exception):
            raise AssertionError("terminal spawn failed") from term
        try:
            assert term.proc.poll() is None
            assert popen_thread_id is not None
            assert popen_thread_id != request_thread_id
        finally:
            close_terminal(sid)

    def test_supervisor_propagates_popen_failure(self, monkeypatch, tmp_path):
        sid = f"tspawn-fail-{os.getpid()}"
        import agent_gateway.terminal as term_mod

        expected = RuntimeError("spawn failed")
        real_put = term_mod._spawn_queue.put

        def failing_popen(*args, **kwargs):
            raise expected

        monkeypatch.setattr(term_mod.subprocess, "Popen", failing_popen)

        with pytest.raises(RuntimeError, match="spawn failed"):
            start_terminal(sid, tmp_path, restart=True)
        assert sid not in term_mod._TERMINALS
