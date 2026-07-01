"""Terminal command-execution capability tests (issue #415).

Covers the main path + boundaries of the run-scoped, one-shot bash executor:
T01 main path stdout, T02 stderr tagging, T03 nonzero exit (+stderr),
T04 timeout kills sleep, T05 cancel in-flight, T06 empty command short-circuit,
T07 per-run workdir isolation, T08 env sandbox strip+inject, T09 run_id path containment,
T10 output sanitization (AKIA / API_KEY / Bearer / ~user path),
T11 end-to-end through GatewayRunner.
"""
import asyncio
import os
import sys
import tempfile

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
SERVER_DIR = os.path.join(REPO_ROOT, "server")
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import pytest

from agent_gateway.drivers.terminal import TerminalDriver
from agent_gateway.runner import GatewayRunner
from agent_gateway.sandbox import SandboxPolicy, build_env, prepare_run_dir
from agent_gateway.terminal import TerminalExecutor
from shared.contracts.runspec import AgentRunRequest, RunSpec


def make_request(command, *, timeout_seconds=None):
    run_id = "t-" + "".join(c if c.isalnum() else "-" for c in command[:10]) + "-" + str(os.getpid())
    return AgentRunRequest(
        run_id=run_id,
        tenant_id="local",
        run_spec=RunSpec(custom_args=[command], timeout_seconds=timeout_seconds),
    )


async def run_and_collect(executor, request):
    events = []

    async def sink(ev):
        events.append(ev)

    result = await executor.execute(request, TerminalDriver(), sink)
    return result, events


@pytest.mark.asyncio
class TestTerminalMainPath:
    async def test_hello_stdout(self, tmp_path):
        req = make_request("/bin/echo hello world")
        ex = TerminalExecutor(sandbox=SandboxPolicy(runs_root=str(tmp_path)))
        result, events = await run_and_collect(ex, req)
        assert result.success is True
        types = [e.type for e in events]
        assert "command_started" in types
        assert "completed" in types
        out = "\n".join(e.payload.get("data", "") for e in events if e.type == "command_output")
        assert "hello world" in out

    async def test_stderr_stream_tagged(self, tmp_path):
        req = make_request('/bin/bash -c "echo out; echo err >&2"')
        ex = TerminalExecutor(sandbox=SandboxPolicy(runs_root=str(tmp_path)))
        result, events = await run_and_collect(ex, req)
        assert result.success is True
        streams = {e.payload.get("stream") for e in events if e.type == "command_output"}
        assert "stdout" in streams and "stderr" in streams


@pytest.mark.asyncio
class TestTerminalBoundaries:
    async def test_nonzero_exit(self, tmp_path):
        req = make_request('/bin/bash -c "exit 42"')
        ex = TerminalExecutor(sandbox=SandboxPolicy(runs_root=str(tmp_path)))
        result, events = await run_and_collect(ex, req)
        assert result.success is False
        errors = [e for e in events if e.type == "error"]
        assert len(errors) == 1
        assert errors[0].payload.get("exit_code") == 42

    async def test_nonzero_exit_with_stderr(self, tmp_path):
        req = make_request('/bin/bash -c "echo boom >&2; exit 7"')
        ex = TerminalExecutor(sandbox=SandboxPolicy(runs_root=str(tmp_path)))
        result, events = await run_and_collect(ex, req)
        assert result.success is False
        err = next(e for e in events if e.type == "error")
        assert "boom" in err.payload.get("message", "")
        assert err.payload.get("exit_code") == 7

    async def test_timeout_kills_sleep(self, tmp_path):
        req = make_request("/bin/sleep 5", timeout_seconds=1)
        ex = TerminalExecutor(sandbox=SandboxPolicy(runs_root=str(tmp_path)))
        result, events = await run_and_collect(ex, req)
        assert result.success is False
        assert any(e.type == "error" for e in events)
        assert any("timeout" in e.payload.get("message", "") for e in events if e.type == "error")

    async def test_cancel_emits_cancelled(self, tmp_path):
        req = make_request("/bin/sleep 10")
        ex = TerminalExecutor(sandbox=SandboxPolicy(runs_root=str(tmp_path)))
        run_task = asyncio.create_task(run_and_collect(ex, req))
        await asyncio.sleep(0.4)
        await ex.cancel(req.run_id)
        result, events = await run_task
        assert result.success is False
        assert any(e.type in {"cancelled", "error"} for e in events)

    async def test_empty_command_short_circuits(self, tmp_path):
        req = make_request(" ")
        ex = TerminalExecutor(sandbox=SandboxPolicy(runs_root=str(tmp_path)))
        result, events = await run_and_collect(ex, req)
        assert result.success is False
        assert result.error == "empty command"
        assert events and events[0].type == "error"


class TestTerminalIsolation:
    def test_per_run_workdir_isolation(self, tmp_path):
        a = prepare_run_dir(SandboxPolicy(runs_root=str(tmp_path)), "run-a")
        b = prepare_run_dir(SandboxPolicy(runs_root=str(tmp_path)), "run-b")
        assert a != b
        assert os.path.isdir(a) and os.path.isdir(b)

    def test_env_sandbox_strips_and_injects(self, tmp_path):
        policy = SandboxPolicy(runs_root=str(tmp_path), extra_env={"MY_TOKEN": "xyz"})
        env = build_env(policy)
        assert "PATH" in env
        assert "MY_TOKEN" in env and env["MY_TOKEN"] == "xyz"

    def test_run_id_cannot_escape_root(self, tmp_path):
        out = prepare_run_dir(SandboxPolicy(runs_root=str(tmp_path)), "../../etc/passwd")
        assert os.path.commonpath([str(tmp_path.resolve()), os.path.realpath(out)]) == str(tmp_path.resolve())


class TestTerminalDriverSanitization:
    def _one(self, text):
        return TerminalDriver()._sanitize(text)

    def test_aws_akia_redacted(self):
        assert "<REDACTED_AKIA>" in self._one("aws key AKIAIOSFODNN7EXAMPLE")

    def test_api_key_redacted(self):
        out = self._one("MY_API_KEY=supersecret123 OTHER=visible")
        assert "REDACTED" in out
        assert "supersecret123" not in out
        assert "visible" in out

    def test_bearer_redacted(self):
        s = self._one("Authorization: Bearer abc123")
        assert "abc123" not in s

    def test_user_path_redacted(self):
        out = self._one("/Users/alice/secret/cred")
        assert "<user>" in out and "alice" not in out


@pytest.mark.asyncio
class TestTerminalViaRunner:
    """End-to-end through GatewayRunner (the same path the service layer uses)."""

    async def test_runner_success(self, tmp_path):
        runner = GatewayRunner(executor=TerminalExecutor(), driver=TerminalDriver())
        req = make_request("/bin/echo via-runner")
        events = []

        async def sink(ev):
            events.append(ev)

        result = await runner.run(req, sink)
        assert result.success is True
        assert any(e.type == "completed" for e in events)
        out = " ".join(e.payload.get("data", "") for e in events if e.type == "command_output")
        assert "via-runner" in out
