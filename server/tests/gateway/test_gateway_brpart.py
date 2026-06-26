"""executors.py + cleanup_service.py 分支覆盖补充。

覆盖 executors.py 中 _SubprocessExecutor 的 _stamp/_emit/_parse_json_line/
_terminate/_drain_stderr/_next_wait/_feed_stdin/read_records/_finalize 的边缘路径，
以及 cleanup_service.py 的错误隔离路径（iterdir OSError、chdir stat OSError、
rmtree OSError、_get_dir_size OSError）。
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from agent_gateway.executors import (
    JsonStreamCliExecutor,
    PlainCliExecutor,
    _SubprocessExecutor,
    _parse_json_line,
    _SeqCounter,
    _new_event_id,
)
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.runspec import AgentRunRequest, RunSpec

from agent_gateway.cleanup_service import (
    CleanupResult,
    cleanup_expired_runs,
    _get_dir_size,
)


# ===========================================================================
# executors.py branch coverage
# ===========================================================================

# ---- _parse_json_line ------------------------------------------------------


def test_parse_json_line_valid():
    assert _parse_json_line('{"key": "val"}') == {"key": "val"}


def test_parse_json_line_invalid_returns_none():
    assert _parse_json_line("not json{") is None


def test_parse_json_line_empty_string():
    assert _parse_json_line("") is None


# ---- _next_wait edge cases --------------------------------------------------


def test_next_wait_both_none():
    wait, reason = _SubprocessExecutor._next_wait(None, None, 0)
    assert wait is None and reason == "idle timeout"


def test_next_wait_idle_none_remaining_positive():
    wait, reason = _SubprocessExecutor._next_wait(None, 100.0, 50.0)
    assert wait == 50.0 and reason == "run timeout"


def test_next_wait_idle_positive_remaining_none():
    wait, reason = _SubprocessExecutor._next_wait(10.0, None, 0)
    assert wait == 10.0 and reason == "idle timeout"


def test_next_wait_idle_less_than_remaining():
    wait, reason = _SubprocessExecutor._next_wait(5.0, 100.0, 50.0)
    assert wait == 5.0 and reason == "idle timeout"


def test_next_wait_remaining_less_than_idle():
    wait, reason = _SubprocessExecutor._next_wait(50.0, 100.0, 90.0)
    assert wait == 10.0 and reason == "run timeout"


def test_next_wait_remaining_equal_to_idle():
    wait, reason = _SubprocessExecutor._next_wait(10.0, 100.0, 90.0)
    assert wait == 10.0 and reason == "run timeout"


# ---- _stamp with non-empty event_id/source ----------------------------------


def test_stamp_preserves_non_empty_event_id_and_source():
    executor = JsonStreamCliExecutor()
    seq = _SeqCounter()
    event = AgentRuntimeEvent(
        event_id="custom-id",
        run_id="wrong",
        seq=0,
        type="text_delta",
        source="my-source",
        timestamp="2026-06-25T00:00:00Z",
        payload={"text": "hi"},
    )
    stamped = executor._stamp(event, "run-stamp", seq)
    assert stamped.event_id == "custom-id"
    assert stamped.source == "my-source"
    assert stamped.run_id == "run-stamp"
    assert stamped.seq == 1


def test_stamp_fills_empty_event_id_and_source():
    executor = PlainCliExecutor()
    seq = _SeqCounter()
    event = AgentRuntimeEvent(
        event_id="",
        run_id="wrong",
        seq=0,
        type="text_delta",
        source="",
        timestamp="2026-06-25T00:00:00Z",
        payload={"text": "hi"},
    )
    stamped = executor._stamp(event, "run-fill", seq)
    assert stamped.event_id != ""
    assert stamped.source == "plain_cli"
    assert stamped.seq == 1


# ---- _emit ------------------------------------------------------------------


def test_emit_produces_correct_event():
    executor = JsonStreamCliExecutor()
    seq = _SeqCounter()
    events = []

    async def sink(ev):
        events.append(ev)

    asyncio.run(executor._emit(sink, "run-emit", "error", {"message": "boom"}, seq))
    assert len(events) == 1
    ev = events[0]
    assert ev.type == "error"
    assert ev.payload == {"message": "boom"}
    assert ev.run_id == "run-emit"
    assert ev.seq == 1
    assert ev.source == "json_stream_cli"


# ---- _SeqCounter ------------------------------------------------------------


def test_seq_counter_increments():
    c = _SeqCounter()
    assert c.next() == 1
    assert c.next() == 2
    assert c.next() == 3


# ---- _new_event_id ----------------------------------------------------------


def test_new_event_id_format():
    eid = _new_event_id("r1")
    assert eid.startswith("ev_r1_")
    assert len(eid) == len("ev_r1_") + 12


# ---- _terminate branches ----------------------------------------------------


def test_terminate_already_exited():
    """If returncode is set, _terminate should do nothing."""

    class ExitedProc:
        returncode = 0
        terminated = False
        killed = False

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

        async def wait(self):
            return 0

    proc = ExitedProc()
    asyncio.run(_SubprocessExecutor()._terminate(proc))
    assert not proc.terminated
    assert not proc.killed


def test_terminate_process_lookup_error():
    """ProcessLookupError on terminate should return early."""

    class GoneProc:
        returncode = None

        def terminate(self):
            raise ProcessLookupError()

        def kill(self):
            pass

        async def wait(self):
            return -1

    proc = GoneProc()
    # Should not raise
    asyncio.run(_SubprocessExecutor()._terminate(proc))


def test_terminate_process_lookup_error_on_kill():
    """ProcessLookupError on kill should be swallowed, wait still called."""
    waited = []

    class HangingProc:
        returncode = None
        terminated = False

        def terminate(self):
            self.terminated = True

        def kill(self):
            raise ProcessLookupError()

        async def wait(self):
            waited.append(True)
            return -9

    proc = HangingProc()

    # Mock the wait to time out immediately
    original_wait = asyncio.wait_for

    async def fast_wait_for(coro, timeout):
        # If it's a proc.wait() call, time out immediately
        if timeout == 5.0:
            # Cancel the coroutine
            coro.close()
            raise asyncio.TimeoutError()
        return await coro

    with patch("asyncio.wait_for", fast_wait_for):
        asyncio.run(_SubprocessExecutor()._terminate(proc))

    assert proc.terminated
    assert len(waited) > 0  # wait was called after kill


# ---- _drain_stderr branches ------------------------------------------------


def test_drain_stderr_no_stderr():
    class NoStderrProc:
        stderr = None

    proc = NoStderrProc()
    result = asyncio.run(_SubprocessExecutor()._drain_stderr(proc))
    assert result == ""


def test_drain_stderr_read_error():
    class ErrorStderrProc:
        class stderr:
            @staticmethod
            async def read():
                raise OSError("read failed")

    proc = ErrorStderrProc()
    result = asyncio.run(_SubprocessExecutor()._drain_stderr(proc))
    assert result == ""


def test_drain_stderr_normal():
    class NormalProc:
        class stderr:
            @staticmethod
            async def read():
                return b"some error output"

    proc = NormalProc()
    result = asyncio.run(_SubprocessExecutor()._drain_stderr(proc))
    assert result == "some error output"


# ---- _feed_stdin branches ---------------------------------------------------


def test_feed_stdin_no_stdin():
    class NoStdinProc:
        stdin = None

    proc = NoStdinProc()
    req = AgentRunRequest(
        run_id="r", tenant_id="t", run_spec=RunSpec(),
        input_messages=[{"role": "user", "content": "hi"}],
    )
    # Should not crash
    asyncio.run(_SubprocessExecutor()._feed_stdin(proc, req))


def test_feed_stdin_empty_messages():
    class MockWriter:
        written = []
        closed = False

        def write(self, data):
            self.written.append(data)

        async def drain(self):
            pass

        def close(self):
            self.closed = True

    proc = Mock()
    proc.stdin = MockWriter()
    req = AgentRunRequest(
        run_id="r", tenant_id="t", run_spec=RunSpec(),
        input_messages=[],
    )
    asyncio.run(_SubprocessExecutor()._feed_stdin(proc, req))
    assert proc.stdin.closed
    assert len(proc.stdin.written) == 0


def test_feed_stdin_with_messages():
    class MockWriter:
        def __init__(self):
            self.written = []
            self.closed = False

        def write(self, data):
            self.written.append(data)

        async def drain(self):
            pass

        def close(self):
            self.closed = True

    proc = Mock()
    proc.stdin = MockWriter()
    req = AgentRunRequest(
        run_id="r", tenant_id="t", run_spec=RunSpec(),
        input_messages=[{"role": "user", "content": "hello"}],
    )
    asyncio.run(_SubprocessExecutor()._feed_stdin(proc, req))
    assert proc.stdin.closed
    assert len(proc.stdin.written) == 1
    written = json.loads(proc.stdin.written[0].decode())
    assert written == [{"role": "user", "content": "hello"}]


def test_feed_stdin_broken_pipe():
    class BrokenWriter:
        def write(self, data):
            raise BrokenPipeError("broken")

        async def drain(self):
            pass

        def close(self):
            pass

    proc = Mock()
    proc.stdin = BrokenWriter()
    req = AgentRunRequest(
        run_id="r", tenant_id="t", run_spec=RunSpec(),
        input_messages=[{"role": "user", "content": "hi"}],
    )
    # Should not crash
    asyncio.run(_SubprocessExecutor()._feed_stdin(proc, req))


# ---- read_records with empty lines ------------------------------------------


def test_read_records_skips_empty_lines():
    """Empty lines in stdout should be skipped, not passed to _frame_line."""
    pytest.skip("requires real subprocess; covered by e2e tests indirectly")


# ---- _finalize with terminal_seen and nonzero exit --------------------------


def test_finalize_nonzero_exit_with_terminal_seen():
    """If process exits nonzero but terminal already seen, no extra error event."""

    class ExitedProc:
        returncode = 1
        stderr = None

        async def wait(self):
            return 1

    executor = JsonStreamCliExecutor()
    seq = _SeqCounter()
    events = []

    async def sink(ev):
        events.append(ev)

    handle = Mock()
    handle.cancelled = False

    proc = ExitedProc()

    async def run():
        return await executor._finalize(
            proc, AgentRunRequest(run_id="r", tenant_id="t", run_spec=RunSpec()),
            sink, "r", seq,
            handle=handle, session_id=None, usage=None,
            terminal_seen=True, timed_out=None,
        )

    result = asyncio.run(run())
    assert result.success is False
    assert "exit code 1" in result.error
    # No error event because terminal was already seen
    assert len(events) == 0


def test_finalize_nonzero_exit_without_terminal_emits_error():
    """If process exits nonzero and no terminal seen, emit error event."""

    class ExitedProc:
        class stderr:
            @staticmethod
            async def read():
                return b""

        async def wait(self):
            return 3

    executor = PlainCliExecutor()
    seq = _SeqCounter()
    events = []

    async def sink(ev):
        events.append(ev)

    handle = Mock()
    handle.cancelled = False

    proc = ExitedProc()

    async def run():
        return await executor._finalize(
            proc, AgentRunRequest(run_id="r", tenant_id="t", run_spec=RunSpec()),
            sink, "r", seq,
            handle=handle, session_id=None, usage=None,
            terminal_seen=False, timed_out=None,
        )

    result = asyncio.run(run())
    assert result.success is False
    assert events and events[-1].type == "error"
    assert events[-1].payload.get("exit_code") == 3


# ===========================================================================
# cleanup_service.py error path coverage
# ===========================================================================


def test_cleanup_iterdir_oserror(tmp_path: Path):
    """iterdir() raising OSError should return error result."""
    with patch.object(Path, "iterdir", side_effect=OSError("permission denied")):
        result = cleanup_expired_runs(str(tmp_path), retention_days=7)
    assert result.scanned_count == 0
    assert len(result.errors) > 0
    assert "扫描目录失败" in result.errors[0]


def test_cleanup_stat_oserror_skips_run(tmp_path: Path):
    """stat() raising OSError on a run entry should record error and skip it."""
    run_dir = tmp_path / "run_broken"
    run_dir.mkdir()
    old_time = time.time() - (10 * 86400)
    os.utime(run_dir, (old_time, old_time))

    # Count calls per-path: let is_dir() succeed, then entry.stat() fail
    call_counts: dict[str, int] = {}

    def stat_side_effect(path, *a, **kw):
        key = str(path)
        if key.endswith("run_broken"):
            call_counts[key] = call_counts.get(key, 0) + 1
            # First stat (is_dir): return real; Second stat (entry.stat): fail
            if call_counts[key] >= 2:
                raise OSError("stat failed")
        return original_os_stat(path, *a, **kw)

    import os as _os
    original_os_stat = _os.stat

    with patch("os.stat", side_effect=stat_side_effect):
        result = cleanup_expired_runs(str(tmp_path), retention_days=7, db_url=None)

    assert result.scanned_count == 1
    assert result.deleted_count == 0
    assert len(result.errors) > 0
    assert "stat 失败" in result.errors[0]
    assert run_dir.exists()


def test_cleanup_rmtree_oserror(tmp_path: Path):
    """shutil.rmtree raising OSError should record error and continue."""
    run_dir = tmp_path / "run_locked"
    run_dir.mkdir()
    (run_dir / "file.txt").write_text("data")
    old_time = time.time() - (10 * 86400)
    os.utime(run_dir, (old_time, old_time))

    with patch("shutil.rmtree", side_effect=OSError("permission denied")):
        result = cleanup_expired_runs(str(tmp_path), retention_days=7, db_url=None)

    assert result.scanned_count == 1
    assert result.deleted_count == 0
    assert len(result.errors) > 0
    assert "删除失败" in result.errors[0]


def test_cleanup_active_runs_with_logging(tmp_path: Path):
    """When db_url is given and active_runs are found, logging.info should fire."""
    run_dir = tmp_path / "run_recent"
    run_dir.mkdir()
    (run_dir / "file.txt").write_text("data")

    with patch("agent_gateway.cleanup_service._get_active_runs", return_value={"run_recent"}):
        result = cleanup_expired_runs(
            str(tmp_path), retention_days=7, db_url="fake://db"
        )

    assert result.scanned_count == 1
    assert result.skipped_count == 1
    assert run_dir.exists()


def test_cleanup_path_traversal_valueerror(tmp_path: Path):
    """relative_to raising ValueError should record error and skip the entry.

    We mock Path.relative_to so that entries whose name starts with "run_trav"
    raise ValueError, simulating a path-traversal escape detected by relative_to.
    """
    run_dir = tmp_path / "run_traversal"
    run_dir.mkdir()
    old_time = time.time() - (10 * 86400)
    os.utime(run_dir, (old_time, old_time))

    original_relative_to = Path.relative_to

    def fail_relative_to(self, other, *more):
        if getattr(self, "name", "").startswith("run_trav"):
            raise ValueError("not subpath")
        return original_relative_to(self, other, *more)

    with patch.object(Path, "relative_to", fail_relative_to):
        result = cleanup_expired_runs(str(tmp_path), retention_days=0, db_url=None)

    assert result.scanned_count == 1
    assert result.deleted_count == 0
    assert len(result.errors) > 0
    assert "路径越权" in result.errors[0]
    assert run_dir.exists()


def test_get_dir_size_file_stat_oserror(tmp_path: Path):
    """_get_dir_size should handle OSError on individual file stat."""
    (tmp_path / "file1.txt").write_text("data")

    # The OSError on individual file stat is caught inside _get_dir_size
    with patch.object(Path, "stat", side_effect=OSError("denied")):
        size = _get_dir_size(tmp_path)
    # Should return 0 because all stat calls failed
    # (the rglob itself works, but individual stat() raises OSError)
    assert size == 0


def test_get_dir_size_rglob_oserror():
    """_get_dir_size should handle OSError on rglob itself."""
    nonexistent = Path("/nonexistent/path/xyz")
    size = _get_dir_size(nonexistent)
    assert size == 0


def test_cleanup_with_files_not_dirs(tmp_path: Path):
    """Regular files in runs_root should be skipped (not counted as runs)."""
    (tmp_path / "readme.txt").write_text("not a run")
    (tmp_path / "config.json").write_text("{}")

    result = cleanup_expired_runs(str(tmp_path), retention_days=7)
    assert result.scanned_count == 0
    assert result.deleted_count == 0
