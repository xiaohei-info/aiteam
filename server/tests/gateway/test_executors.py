"""Executor 协议族验收（G1 / 06 §7.2）。

四个协议族（Acp / JsonRpcStdio / JsonStreamCli + Plain 降级）共享子进程生命周期，
唯一差异是 framing。本测试以**真实子进程**（小段 python 脚本作 fake runtime）覆盖：

- 每个 executor：取消 / 超时 / stderr / 异常退出。
- raw 事件经 Driver 归一为 AgentRuntimeEvent 的 golden 测试（顺序/seq/type/payload）。
- Executor 是 seq 顺序元数据的权威方（重盖 driver 的 seq）。

只 import shared.contracts.* + agent_gateway；不依赖真实 runtime（非 integration）。
"""

import asyncio
import sys

from agent_gateway.executors import (
    JsonStreamCliExecutor,
    PlainCliExecutor,
)
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, Executor, RuntimeCapability
from shared.contracts.runspec import AgentRunRequest, RunSpec

# --------------------------------------------------------------------------
# 测试用 fake runtime：直接用当前解释器跑一段 -c 脚本，避免依赖外部 CLI。
# --------------------------------------------------------------------------

# JSON stream：逐行打印 JSON 对象，正常 0 退出。
_JSON_SCRIPT_OK = r"""
import json, sys
for ev in [
    {"kind": "status", "state": "running"},
    {"kind": "reasoning", "text": "thinking"},
    {"kind": "text", "text": "Hello "},
    {"kind": "text", "text": "world"},
    {"kind": "tool_start", "name": "noop"},
    {"kind": "tool_end", "name": "noop", "output": "ok"},
    {"kind": "usage", "input_tokens": 10, "output_tokens": 5},
    {"kind": "session", "session_id": "sess-123"},
    {"kind": "done", "final": "Hello world"},
]:
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()
"""

# 非零退出 + stderr 输出（异常退出 / stderr 测试）。
_FAIL_SCRIPT = r"""
import sys
sys.stderr.write("boom: something broke\n")
sys.stderr.flush()
sys.exit(3)
"""

# 永不退出（取消 / 超时测试）：持续 sleep。
_HANG_SCRIPT = r"""
import time
while True:
    time.sleep(0.05)
"""

# 输出一行后挂起（idle watchdog 测试）：先吐 status 再卡住。
_IDLE_SCRIPT = r"""
import json, sys, time
sys.stdout.write(json.dumps({"kind": "status", "state": "running"}) + "\n")
sys.stdout.flush()
time.sleep(60)
"""

# plain stdout（降级）：纯文本行。
_PLAIN_SCRIPT = r"""
import sys
for line in ["line one", "line two", "line three"]:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
"""


def _py(script: str) -> list[str]:
    return [sys.executable, "-c", script]


class _ScriptDriver(Driver):
    """把测试脚本输出的 dict 归一为 AgentRuntimeEvent。

    故意把 seq 填成 0、source 留空、event_id 留空，验证 Executor 会重盖顺序元数据。
    """

    def __init__(self, command: list[str]):
        self._command = command

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(runtime="script")

    def build_command(self, run_spec: RunSpec) -> list[str]:
        return self._command

    def parse_event(self, raw: object) -> AgentRuntimeEvent | None:
        if not isinstance(raw, dict):
            return None
        mapping = {
            "status": "status",
            "reasoning": "reasoning_delta",
            "text": "text_delta",
            "tool_start": "tool_call_started",
            "tool_end": "tool_call_completed",
            "usage": "usage",
            "done": "completed",
        }
        kind = raw.get("kind")
        type_ = mapping.get(kind)
        if type_ is None:
            return None  # session 行只供 extract_session_id，不产事件。
        return AgentRuntimeEvent(
            event_id="",          # 留空：Executor 应补全。
            run_id="ignored",     # 错值：Executor 应以请求 run_id 重盖。
            seq=0,                # 错值：Executor 应重盖单调 seq。
            type=type_,           # type: ignore[arg-type]
            source="",            # 留空：Executor 应补 family。
            timestamp="2026-06-19T00:00:00Z",
            payload={k: v for k, v in raw.items() if k != "kind"},
        )

    def extract_session_id(self, raw: object) -> str | None:
        if isinstance(raw, dict) and raw.get("kind") == "session":
            return raw.get("session_id")
        return None

    def extract_usage(self, raw: object) -> dict | None:
        if isinstance(raw, dict) and raw.get("kind") == "usage":
            return {k: v for k, v in raw.items() if k != "kind"}
        return None


class _PlainDriver(Driver):
    """plain 降级：每行 str → text_delta。"""

    def __init__(self, command: list[str]):
        self._command = command

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(runtime="plain")

    def build_command(self, run_spec: RunSpec) -> list[str]:
        return self._command

    def parse_event(self, raw: object) -> AgentRuntimeEvent | None:
        if not isinstance(raw, str):
            return None
        return AgentRuntimeEvent(
            event_id="", run_id="ignored", seq=0, type="text_delta",
            source="", timestamp="2026-06-19T00:00:00Z", payload={"text": raw},
        )

    def extract_session_id(self, raw: object) -> str | None:
        return None

    def extract_usage(self, raw: object) -> dict | None:
        return None


def _req(run_id="r1", timeout=None):
    return AgentRunRequest(
        run_id=run_id, tenant_id="t1",
        run_spec=RunSpec(model="m", timeout_seconds=timeout),
    )


def _execute(executor, request, driver):
    events: list[AgentRuntimeEvent] = []

    async def sink(ev):
        events.append(ev)

    result = asyncio.run(executor.execute(request, driver, sink))
    return events, result


# 一次性吐流的子进程执行器只剩 JsonStreamCli（line-delimited JSON）；ACP / codex app-server
# 为常驻 RPC 服务端，由各自真客户端执行器测试（test_acp_executor / test_codex_executor）。
_JSON_EXECUTORS = [JsonStreamCliExecutor]


def _ids(cls):
    return cls.__name__


# ---- 契约形状 ------------------------------------------------------------


def test_all_executors_are_executor_subclass():
    for cls in (*_JSON_EXECUTORS, PlainCliExecutor):
        assert issubclass(cls, Executor)
        assert isinstance(cls(), Executor)


# ---- golden：事件归一 ----------------------------------------------------


def test_json_executors_normalize_to_runtime_events_golden():
    for cls in _JSON_EXECUTORS:
        driver = _ScriptDriver(_py(_JSON_SCRIPT_OK))
        events, result = _execute(cls(), _req("run-golden"), driver)

        types = [e.type for e in events]
        assert types == [
            "status", "reasoning_delta", "text_delta", "text_delta",
            "tool_call_started", "tool_call_completed", "usage", "completed",
        ], f"{cls.__name__} golden type sequence mismatch"

        # Executor 是顺序元数据权威方：seq 单调、run_id 重盖、source 补 family、event_id 补全。
        assert [e.seq for e in events] == list(range(1, len(events) + 1))
        assert all(e.run_id == "run-golden" for e in events)
        assert all(e.source == cls.family for e in events)
        assert all(e.event_id for e in events)

        # payload 保真。
        text = "".join(e.payload["text"] for e in events if e.type == "text_delta")
        assert text == "Hello world"
        usage_ev = next(e for e in events if e.type == "usage")
        assert usage_ev.payload == {"input_tokens": 10, "output_tokens": 5}

        # 终态：成功 + session/usage 透传。
        assert result.success is True
        assert result.session_id == "sess-123"
        assert result.usage == {"input_tokens": 10, "output_tokens": 5}


def test_plain_executor_normalizes_lines_to_text_delta():
    driver = _PlainDriver(_py(_PLAIN_SCRIPT))
    events, result = _execute(PlainCliExecutor(), _req(), driver)
    assert [e.type for e in events] == ["text_delta", "text_delta", "text_delta"]
    assert [e.payload["text"] for e in events] == ["line one", "line two", "line three"]
    assert [e.seq for e in events] == [1, 2, 3]
    assert result.success is True


# ---- 异常退出 + stderr ---------------------------------------------------


def test_each_executor_reports_nonzero_exit_and_stderr():
    for cls in (*_JSON_EXECUTORS, PlainCliExecutor):
        driver = _ScriptDriver(_py(_FAIL_SCRIPT))
        events, result = _execute(cls(), _req("run-fail"), driver)
        assert result.success is False, cls.__name__
        assert "boom: something broke" in (result.error or ""), cls.__name__
        # 无 runtime 终态事件时，Executor 自产 error 事件。
        assert events and events[-1].type == "error"
        assert events[-1].payload.get("exit_code") == 3


# ---- 取消 ---------------------------------------------------------------


def test_each_executor_cancel_mid_run_terminates_process():
    for cls in (*_JSON_EXECUTORS, PlainCliExecutor):
        executor = cls()

        async def scenario():
            events: list[AgentRuntimeEvent] = []

            async def sink(ev):
                events.append(ev)
                # 收到第一个事件后立即取消。

            task = asyncio.create_task(
                executor.execute(_req("run-cancel"), _ScriptDriver(_py(_HANG_SCRIPT)), sink)
            )
            await asyncio.sleep(0.2)
            await executor.cancel("run-cancel")
            result = await asyncio.wait_for(task, timeout=5)
            return events, result

        events, result = asyncio.run(scenario())
        assert result.success is False, cls.__name__
        assert result.error == "cancelled", cls.__name__
        assert events and events[-1].type == "cancelled", cls.__name__


def test_cancel_before_execute_short_circuits():
    for cls in (*_JSON_EXECUTORS, PlainCliExecutor):
        executor = cls()

        async def scenario():
            await executor.cancel("run-pre")
            events: list[AgentRuntimeEvent] = []

            async def sink(ev):
                events.append(ev)

            result = await executor.execute(
                _req("run-pre"), _ScriptDriver(_py(_HANG_SCRIPT)), sink
            )
            return events, result

        events, result = asyncio.run(scenario())
        assert result.success is False, cls.__name__
        assert result.error == "cancelled", cls.__name__
        assert events[-1].type == "cancelled"


# ---- 超时（idle watchdog + 整体 timeout） -------------------------------


def test_idle_watchdog_kills_silent_runtime():
    """输出一行后挂起：idle watchdog 触发 → error('idle timeout')。"""
    for cls in _JSON_EXECUTORS:
        executor = cls()
        executor.default_idle_seconds = 0.3  # 收紧窗口加速测试。
        driver = _ScriptDriver(_py(_IDLE_SCRIPT))

        events, result = _execute(executor, _req("run-idle"), driver)
        assert result.success is False, cls.__name__
        assert result.error == "idle timeout", cls.__name__
        assert events[-1].type == "error"
        # 挂起前的 status 事件已归一。
        assert events[0].type == "status"


def test_overall_timeout_kills_long_runtime():
    """整体 timeout：无输出且超过 run_spec.timeout_seconds（契约为整数秒）。"""
    executor = JsonStreamCliExecutor()
    executor.default_idle_seconds = None  # 关 idle，单测整体 timeout。
    driver = _ScriptDriver(_py(_HANG_SCRIPT))
    events, result = _execute(executor, _req("run-timeout", timeout=1), driver)
    assert result.success is False
    assert result.error == "run timeout"
    assert events and events[-1].type == "error"
    assert events[-1].payload.get("message") == "run timeout"


# ---- spawn 失败 ----------------------------------------------------------


def test_spawn_failure_returns_error_not_crash():
    driver = _ScriptDriver(["/nonexistent/runtime/binary-xyz"])
    events, result = _execute(JsonStreamCliExecutor(), _req("run-nospawn"), driver)
    assert result.success is False
    assert "spawn failed" in (result.error or "")
    assert events and events[-1].type == "error"
