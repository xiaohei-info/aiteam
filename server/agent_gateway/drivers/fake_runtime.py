"""Fake runtime（C0.4）。

实现 Executor/Driver 契约，产出事件最小集（06 §7.1），让 Track A 在真实 runtime 接入前
即可开发/测试本地主链与 timeline 映射（10 Phase 1 验收：fake runtime 产生
text/reasoning/tool/usage/completed 并映射为本地 timeline）。

**不是生产 runtime**；真实 Driver/Executor 由 Track G 落地（11 §4）。
"""

from __future__ import annotations

import itertools

from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, EventSink, Executor, RunResult, RuntimeCapability, RuntimeHealth
from shared.contracts.runspec import AgentRunRequest, RunSpec

# 固定时间戳：契约脚本不依赖真实时钟（保持可复现）。
_FAKE_TS = "2026-06-19T00:00:00Z"


class FakeDriver(Driver):
    """最简 driver：直通解析，声明支持 MCP/resume。"""

    runtime_name = "fake"

    def capabilities(self) -> RuntimeCapability:
        return RuntimeCapability(
            runtime=self.runtime_name,
            supports_native_skills=False,
            supports_native_memory=False,
            supports_resume=True,
            supports_mcp=True,
            system_prompt_injection="flag",
            model_catalog_mode="static",
        )

    def build_command(self, run_spec: RunSpec) -> list[str]:
        return ["fake-runtime", "--model", run_spec.model or "default"]

    def runtime_health(self) -> RuntimeHealth:
        """Fake runtime 无真实 CLI，恒 ready（仅供 dev/测试，生产禁用——见 readiness 校验）。"""
        return RuntimeHealth(
            status="ready",
            runtime=self.runtime_name,
            capabilities=self.capabilities(),
        )

    def parse_event(self, raw: object) -> AgentRuntimeEvent | None:
        return raw if isinstance(raw, AgentRuntimeEvent) else None

    def extract_session_id(self, raw: object) -> str | None:
        return "fake-session"

    def extract_usage(self, raw: object) -> dict | None:
        if isinstance(raw, AgentRuntimeEvent) and raw.type == "usage":
            return raw.payload
        return None


class FakeExecutor(Executor):
    """脚本化执行器：把固定事件序列经 on_event 回流，返回成功终态。"""

    def __init__(self) -> None:
        self._cancelled: set[str] = set()
        self._seq = itertools.count(1)

    def _ev(self, run_id: str, type_: str, payload: dict) -> AgentRuntimeEvent:
        return AgentRuntimeEvent(
            event_id=f"ev_{run_id}_{next(self._seq)}",
            run_id=run_id,
            seq=next(self._seq),
            type=type_,  # type: ignore[arg-type]
            source="fake",
            timestamp=_FAKE_TS,
            payload=payload,
        )

    async def execute(self, request: AgentRunRequest, driver: Driver, on_event: EventSink) -> RunResult:
        run_id = request.run_id
        script: list[tuple[str, dict]] = [
            ("status", {"state": "running"}),
            ("reasoning_delta", {"text": "thinking..."}),
            ("text_delta", {"text": "Hello "}),
            ("text_delta", {"text": "world"}),
            ("tool_call_started", {"name": "noop", "input": {}}),
            ("tool_call_completed", {"name": "noop", "output": "ok"}),
            ("usage", {"input_tokens": 10, "output_tokens": 5}),
            ("completed", {"final_text": "Hello world"}),
        ]
        usage: dict | None = None
        for type_, payload in script:
            if run_id in self._cancelled:
                await on_event(self._ev(run_id, "cancelled", {}))
                return RunResult(run_id=run_id, success=False, error="cancelled",
                                 session_id=driver.extract_session_id(None))
            ev = self._ev(run_id, type_, payload)
            if type_ == "usage":
                usage = payload
            await on_event(ev)
        return RunResult(
            run_id=run_id, success=True,
            session_id=driver.extract_session_id(None), usage=usage,
        )

    async def cancel(self, run_id: str) -> None:
        self._cancelled.add(run_id)
