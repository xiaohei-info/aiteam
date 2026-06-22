"""真实 runtime 端到端 smoke（opt-in，会真起进程/真消耗 provider 配额）。

默认 **不跑**（CI/普通 pytest 跳过）：需 `RUNTIME_SMOKE=1` 显式开启,且对应二进制在场。
经真实 Gateway（build_runner → 真实 Driver+Executor）跑一条最小 run,断言产出归一事件。

现状（2026-06-22 真实实测，全部真跑通）：
- claude_code ✅ 一次性 stream-json（文本/工具/思考深度 live）。
- codex ✅ CodexAppServerExecutor（真 app-server JSON-RPC 客户端；文本/思考深度 live）。
- hermes ✅ AcpClientExecutor（真 ACP SDK 客户端；文本/工具/模型选择 live）。
- 端到端：codex 经 MainlineService.start_run → 真实 SSE 生成器流出归一业务事件（test_codex_end_to_end_service_to_sse）。
"""

import asyncio
import json
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


@pytest.mark.skipif(not shutil.which("claude"), reason="claude CLI 未安装")
def test_claude_code_live_tool_call():
    """#187：headless（bypassPermissions + §13 沙箱）下工具真执行，断言工具输入/输出归一可得。"""
    runner = build_runner("claude_code")
    req = AgentRunRequest(
        run_id="smoke_cc_tool", tenant_id="t1",
        run_spec=RunSpec(model="claude-haiku-4-5-20251001", timeout_seconds=180),
        input_messages=[{"role": "user", "content":
                         "Run the bash command `echo hello-claude`, then reply DONE."}],
    )
    result, events = asyncio.run(runner.run_and_collect(req))
    types = [e.type for e in events]
    assert result.success, result.error
    assert "tool_call_started" in types
    assert "tool_call_completed" in types


@pytest.mark.skipif(not shutil.which("claude"), reason="claude CLI 未安装")
def test_claude_code_live_thinking_depth():
    """#187：切换思考深度（--effort high）经 flag 注入，断言跑通并产出思考块。"""
    runner = build_runner("claude_code")
    req = AgentRunRequest(
        run_id="smoke_cc_effort", tenant_id="t1",
        run_spec=RunSpec(model="claude-haiku-4-5-20251001", thinking_level="high",
                         timeout_seconds=180),
        input_messages=[{"role": "user", "content": "What is 17 * 23? Think, then answer."}],
    )
    result, events = asyncio.run(runner.run_and_collect(req))
    assert result.success, result.error
    assert "completed" in [e.type for e in events]


@pytest.mark.skipif(not shutil.which("codex"), reason="codex CLI 未安装")
def test_codex_live_smoke():
    """#185：经真实 CodexAppServerExecutor 驱动 codex app-server，断言流式文本 + 终态。"""
    result, events = _smoke("codex", None)
    types = [e.type for e in events]
    assert result.success, result.error
    assert "text_delta" in types
    assert "completed" in types


@pytest.mark.skipif(not shutil.which("codex"), reason="codex CLI 未安装")
def test_codex_live_thinking_depth():
    """#185：切换思考深度（effort=high）经 turn/start 注入，断言跑通（reasoning 视模型/配置而定）。"""
    runner = build_runner("codex")
    req = AgentRunRequest(
        run_id="smoke_codex_effort", tenant_id="t1",
        run_spec=RunSpec(model=None, thinking_level="high", timeout_seconds=180),
        input_messages=[{"role": "user", "content": "What is 17 * 23? Think, then answer."}],
    )
    result, events = asyncio.run(runner.run_and_collect(req))
    assert result.success, result.error
    assert "completed" in [e.type for e in events]


@pytest.mark.skipif(not shutil.which("hermes"), reason="hermes CLI 未安装")
def test_hermes_live_smoke():
    """#184：经真实 AcpClientExecutor 驱动 hermes acp，断言流式文本 + 终态。"""
    result, events = _smoke("hermes", None)
    types = [e.type for e in events]
    assert result.success, result.error
    assert "text_delta" in types       # 流式消息
    assert "completed" in types        # 终态


@pytest.mark.skipif(not shutil.which("hermes"), reason="hermes CLI 未安装")
def test_hermes_live_model_selection():
    """#184：指定模型经 ACP set_session_model RPC 注入——发现一个可用模型并据其跑通。

    env 仅配单模型时退化为同模型 set（仍证 RPC 路径不破坏 run）；多模型时为真切换。
    """
    import acp
    from acp.schema import RequestPermissionResponse
    from acp.stdio import spawn_agent_process

    async def _discover_model() -> str | None:
        class _C(acp.Client):
            async def session_update(self, session_id, update, **kw):  # noqa: ARG002
                return None

            async def request_permission(self, options, session_id, tool_call, **kw):  # noqa: ARG002
                oid = options[0].option_id if options else "allow"
                return RequestPermissionResponse(outcome={"outcome": "selected", "optionId": oid})

        async with spawn_agent_process(_C(), "hermes", "acp") as (conn, _proc):
            await conn.initialize(protocol_version=acp.PROTOCOL_VERSION)
            sess = await conn.new_session(cwd=".", mcp_servers=[])
            models = getattr(getattr(sess, "models", None), "available_models", None) or []
            return getattr(models[0], "name", None) if models else None

    model = asyncio.run(_discover_model())
    if not model:
        pytest.skip("hermes 未配置可用模型")
    result, events = _smoke("hermes", model)
    types = [e.type for e in events]
    assert result.success, result.error
    assert "completed" in types


@pytest.mark.skipif(not shutil.which("hermes"), reason="hermes CLI 未安装")
def test_hermes_live_tool_call():
    """#184：让 hermes 用工具，断言工具调用的输入/输出都能拿到。"""
    runner = build_runner("hermes")
    req = AgentRunRequest(
        run_id="smoke_hermes_tool", tenant_id="t1",
        run_spec=RunSpec(model=None, timeout_seconds=120),
        input_messages=[{"role": "user", "content":
                         "Run the shell command `echo hello-acp`, then reply DONE."}],
    )
    result, events = asyncio.run(runner.run_and_collect(req))
    types = [e.type for e in events]
    assert "tool_call_started" in types
    assert "tool_call_completed" in types


# ---- 端到端：真实 runtime → MainlineService.start_run → SSE 流 -------------
# 证明「真实 runtime 的回答/工具/终态」确实经 service 链路（on_event→mapper→timeline→broker）
# 由真实 SSE 生成器序列化流出。用 codex（自带 provider key，不耗 Claude 配额）。

@pytest.mark.skipif(not shutil.which("codex"), reason="codex CLI 未安装")
def test_codex_end_to_end_service_to_sse(tmp_path):
    from agent_service.mainline.factory import build_mainline_service
    from agent_service.mainline.models import MessageRole, RunStatus
    from agent_service.mainline.routes import sse_event_stream

    # provider 凭据须经 §13 沙箱 extra_env 放行（否则脱敏后 runtime 无法鉴权）。
    # 放行宿主 env 里的 *_API_KEY（codex newapi 等用之）；可经 SMOKE_ENV_PASSTHROUGH 覆盖。
    passthrough = tuple(
        os.getenv("SMOKE_ENV_PASSTHROUGH", "").split(",")
    ) if os.getenv("SMOKE_ENV_PASSTHROUGH") else tuple(
        k for k in os.environ if k.endswith("_API_KEY") or k.endswith("_KEY")
    )
    svc = build_mainline_service(
        runtime_selection="codex", runs_root=str(tmp_path),
        runtime_env_passthrough=passthrough,
    )
    conv = svc.create_conversation()
    svc.add_message(conv.id, role=MessageRole.USER, content="Reply with exactly the word: OK")

    async def scenario():
        run = await svc.start_run(conv.id, run_spec=RunSpec(timeout_seconds=180))
        # 历史段：经真实 SSE 生成器把已落 timeline 序列化成 text/event-stream 帧。
        frames = []
        gen = sse_event_stream(svc, conv.id, 0)
        for _ in range(len(svc.read_timeline(conv.id, 0))):
            frames.append(await gen.__anext__())
        await gen.aclose()
        return run, frames

    run, frames = asyncio.run(scenario())
    assert run.status is RunStatus.COMPLETED, run.error
    assert all(f.startswith("event: timeline\ndata: ") for f in frames)
    payloads = [json.loads(f.split("data: ", 1)[1].strip()) for f in frames]
    types = [p["event"]["type"] for p in payloads if p["kind"] == "timeline"]
    assert "message_delta" in types       # 回答经 SSE 流出
    assert types[-1] == "run_succeeded"   # 终态经 SSE 流出
    # runtime 原生归一名不外泄前端（D6）。
    assert "text_delta" not in types and "completed" not in types
