"""#173 验收：带沙箱的真实子进程集成（§13 隔离落到实处）。

用可控 stub 子进程（python 吐 JSONL），不依赖真实 runtime 二进制，验证：
- 子进程 cwd 落在 per-run 隔离工作目录；
- 子进程 env 已脱敏（allowlist 外的 os.environ 不泄漏）+ extra_env 已注入。
"""

import asyncio
import os
import sys
from datetime import datetime, timezone

from agent_gateway.executors import JsonStreamCliExecutor
from agent_gateway.sandbox import SandboxPolicy
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, RuntimeCapability
from shared.contracts.runspec import AgentRunRequest, RunSpec

# stub runtime：回显 cwd 与两个 env 探针，再发 done。
_SCRIPT = r"""
import json, os
print(json.dumps({"kind": "env",
                  "cwd": os.getcwd(),
                  "injected": os.environ.get("INJECTED"),
                  "leak": os.environ.get("SECRET_LEAK")}), flush=True)
print(json.dumps({"kind": "done"}), flush=True)
"""


class _EnvProbeDriver(Driver):
    """把 stub 的 env 行归一为 status 事件（payload 直通），done → completed。"""

    def __init__(self, command):
        self._command = command

    def capabilities(self):
        return RuntimeCapability(runtime="envprobe")

    def build_command(self, run_spec):
        return self._command

    def parse_event(self, raw):
        if not isinstance(raw, dict):
            return None
        kind = raw.get("kind")
        type_ = {"env": "status", "done": "completed"}.get(kind)
        if type_ is None:
            return None
        return AgentRuntimeEvent(
            event_id="", run_id="", seq=0, type=type_, source="",  # type: ignore[arg-type]
            timestamp=datetime.now(tz=timezone.utc), payload=raw,
        )

    def extract_session_id(self, raw):
        return None

    def extract_usage(self, raw):
        return None


def _run(executor, request, driver):
    events: list[AgentRuntimeEvent] = []

    async def sink(ev):
        events.append(ev)

    result = asyncio.run(executor.execute(request, driver, sink))
    return events, result


def test_subprocess_runs_in_isolated_cwd_with_scrubbed_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_LEAK", "must-not-leak")
    sandbox = SandboxPolicy(runs_root=str(tmp_path), extra_env={"INJECTED": "yes"})
    executor = JsonStreamCliExecutor(sandbox=sandbox)
    driver = _EnvProbeDriver([sys.executable, "-c", _SCRIPT])
    request = AgentRunRequest(run_id="run_x", tenant_id="t1", run_spec=RunSpec())

    events, result = _run(executor, request, driver)

    assert result.success is True
    status = next(e for e in events if e.type == "status")
    # 工作目录隔离：cwd == runs_root/run_x。
    assert status.payload["cwd"] == os.path.join(str(tmp_path.resolve()), "run_x")
    # 最小注入：extra_env 进了子进程。
    assert status.payload["injected"] == "yes"
    # 环境脱敏：allowlist 外的 SECRET_LEAK 没泄漏给子进程。
    assert status.payload["leak"] is None


def test_subprocess_without_sandbox_inherits_cwd(tmp_path):
    """无沙箱（默认）：继承当前进程 cwd（向后兼容，既有行为不变）。"""
    executor = JsonStreamCliExecutor()  # sandbox=None
    driver = _EnvProbeDriver([sys.executable, "-c", _SCRIPT])
    request = AgentRunRequest(run_id="run_y", tenant_id="t1", run_spec=RunSpec())
    events, result = _run(executor, request, driver)
    status = next(e for e in events if e.type == "status")
    assert status.payload["cwd"] == os.getcwd()
