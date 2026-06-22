"""真实 runtime 端到端 smoke（opt-in，会真起进程/真消耗 provider 配额）。

默认 **不跑**（CI/普通 pytest 跳过）：需 `RUNTIME_SMOKE=1` 显式开启,且对应二进制在场。
经真实 Gateway（build_runner → 真实 Driver+Executor）跑一条最小 run,断言产出归一事件。

现状（2026-06-22 真实实测）：
- claude_code ✅ 真跑通（一次性 stream-json）。
- codex / hermes ❌ 标 xfail：`codex app-server` / `hermes acp` 是 JSON-RPC/ACP **服务端**,
  需客户端握手驱动（initialize→session→prompt→stream→shutdown）,当前 fire-and-forget
  executor 驱动不了；codex 命令 flag 亦不符真实 CLI。真实驱动见后续 issue。
"""

import asyncio
import os
import shutil

import pytest

from agent_gateway.factory import build_runner
from shared.contracts.runspec import AgentRunRequest, RunSpec

pytestmark = pytest.mark.skipif(
    os.getenv("RUNTIME_SMOKE") != "1",
    reason="opt-in 真实 runtime smoke：设 RUNTIME_SMOKE=1 开启",
)


def _smoke(selection: str, model: str | None):
    runner = build_runner(selection)
    req = AgentRunRequest(
        run_id=f"smoke_{selection}", tenant_id="t1",
        run_spec=RunSpec(model=model, timeout_seconds=120),
        input_messages=[{"role": "user", "content": "Reply with exactly the word: OK"}],
    )
    return asyncio.run(runner.run_and_collect(req))


@pytest.mark.skipif(not shutil.which("claude"), reason="claude CLI 未安装")
def test_claude_code_live_smoke():
    result, events = _smoke("claude_code", "claude-haiku-4-5-20251001")
    types = [e.type for e in events]
    assert result.success, result.error
    assert "text_delta" in types
    assert "completed" in types


@pytest.mark.xfail(reason="codex app-server 是 JSON-RPC 服务端，需客户端握手；flag 亦不符真实 CLI（#185）", strict=False)
@pytest.mark.skipif(not shutil.which("codex"), reason="codex CLI 未安装")
def test_codex_live_smoke():
    result, _ = _smoke("codex", "gpt-5-codex")
    assert result.success, result.error


@pytest.mark.xfail(reason="hermes acp 是 ACP 服务端，需 ACP 客户端握手驱动（#184）", strict=False)
@pytest.mark.skipif(not shutil.which("hermes"), reason="hermes CLI 未安装")
def test_hermes_live_smoke():
    result, _ = _smoke("hermes", None)
    assert result.success, result.error
