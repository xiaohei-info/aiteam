"""ACP 客户端执行器（06 §7.2，#184）。

真正"会说 ACP"的 Executor：用官方 `agent-client-protocol` SDK 作客户端,拉起 ACP agent
子进程（如 `hermes acp`）,完成 **initialize → new_session →（指定模型/思考深度）→ prompt →
流式消费 session/update → 终态** 的双向握手驱动。与 fire-and-forget 的 `_SubprocessExecutor`
本质不同（那只单向读流,驱动不了常驻 RPC 服务端）。

ACP 是标准协议,故"typed update → 归一 AgentRuntimeEvent"的映射是**协议级共享逻辑**,落在
本执行器（任何 ACP agent 复用）；runtime 特有的命令/能力声明仍归各 Driver。

§13 隔离：子进程经沙箱在隔离 cwd + 脱敏 env 下启动；工具调用经 session/update 审计入 timeline。
"""

from __future__ import annotations

from datetime import datetime, timezone

from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, EventSink, RunResult
from shared.contracts.gateway import Executor
from shared.contracts.runspec import AgentRunRequest

from .sandbox import SandboxPolicy, build_env, prepare_run_dir


def _text_of(content: object) -> str:
    """从 ACP content（TextContentBlock / 其列表 / ContentToolCallContent 包裹）抽纯文本。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        return "".join(_text_of(c) for c in content)
    inner = getattr(content, "content", None)
    if inner is not None and inner is not content:
        return _text_of(inner)
    return getattr(content, "text", "") or ""


def map_acp_update(update: object) -> tuple[str, dict] | None:
    """ACP session/update（typed）→ (归一事件类型, 净荷)。无法映射返回 None（不静默伪造）。

    纯函数,便于 golden 测试直接喂真实 ACP 对象断言。
    """
    kind = getattr(update, "session_update", None)
    if kind == "agent_message_chunk":
        return "text_delta", {"text": _text_of(getattr(update, "content", None))}
    if kind == "agent_thought_chunk":
        return "reasoning_delta", {"text": _text_of(getattr(update, "content", None))}
    if kind == "tool_call":
        return "tool_call_started", {
            "tool_id": getattr(update, "tool_call_id", None),
            "name": getattr(update, "title", None) or getattr(update, "kind", None),
            "input": getattr(update, "raw_input", None) or {},
        }
    if kind == "tool_call_update":
        status = getattr(update, "status", None)
        if status in ("completed", "failed"):
            return "tool_call_completed", {
                "tool_id": getattr(update, "tool_call_id", None),
                "output": _text_of(getattr(update, "content", None))
                or getattr(update, "raw_output", None),
                "is_error": status == "failed",
            }
        return None  # pending/in_progress 不产终态事件
    if kind == "usage_update":
        return "usage", {
            "used": getattr(update, "used", None),
            "size": getattr(update, "size", None),
            "cost": getattr(update, "cost", None),
        }
    return None


def _user_text(request: AgentRunRequest) -> str:
    """取最后一条 user 消息文本作 prompt（私聊主路径）。"""
    for msg in reversed(request.input_messages):
        if msg.get("role") == "user":
            return str(msg.get("content", ""))
    return request.input_messages[-1].get("content", "") if request.input_messages else ""


class AcpClientExecutor(Executor):
    """ACP 协议族执行器：经 ACP SDK 客户端驱动 agent 子进程。"""

    family = "acp"

    def __init__(self, *, sandbox: SandboxPolicy | None = None, skill_cache=None) -> None:
        self._sandbox = sandbox
        # run_id -> (connection, session_id) 供 cancel 透传。
        self._active: dict[str, tuple[object, str]] = {}

    async def execute(
        self, request: AgentRunRequest, driver: Driver, on_event: EventSink
    ) -> RunResult:
        import acp
        from acp.helpers import text_block
        from acp.schema import RequestPermissionResponse
        from acp.stdio import spawn_agent_process

        run_id = request.run_id
        command = driver.build_command(request.run_spec)
        cwd = None
        env = None
        if self._sandbox is not None:
            cwd = prepare_run_dir(self._sandbox, run_id)
            env = build_env(self._sandbox)

        seq = {"n": 0}

        def _emit(type_: str, payload: dict) -> AgentRuntimeEvent:
            seq["n"] += 1
            return AgentRuntimeEvent(
                event_id=f"acp_{run_id}_{seq['n']}",
                run_id=run_id,
                seq=seq["n"],
                type=type_,  # type: ignore[arg-type]
                source=getattr(driver, "runtime_name", "acp"),
                timestamp=datetime.now(timezone.utc),
                payload=payload,
            )

        usage_holder: dict = {}

        class _GatewayClient(acp.Client):
            async def session_update(self, session_id: str, update: object, **kw) -> None:
                mapped = map_acp_update(update)
                if mapped is None:
                    return
                type_, payload = mapped
                if type_ == "usage":
                    usage_holder.update({k: v for k, v in payload.items() if v is not None})
                await on_event(_emit(type_, payload))

            async def request_permission(self, options, session_id, tool_call, **kw):
                # 自动批准首个选项，安全性依赖沙箱隔离（隔离 cwd + 脱敏 env，§13）：
                # 注入 SandboxPolicy 时工具在隔离工作目录内执行；sandbox=None（dev 默认）
                # 则工具未隔离运行，仅限可信本机 dev。工具调用经 session/update 审计入 timeline。
                opt_id = options[0].option_id if options else "allow"
                return RequestPermissionResponse(
                    outcome={"outcome": "selected", "optionId": opt_id}
                )

        try:
            async with spawn_agent_process(
                _GatewayClient(), command[0], *command[1:], env=env, cwd=cwd
            ) as (conn, _proc):
                await conn.initialize(protocol_version=acp.PROTOCOL_VERSION)
                session = await conn.new_session(cwd=cwd or ".", mcp_servers=[])
                session_id = session.session_id
                self._active[run_id] = (conn, session_id)

                await self._apply_model(conn, session, session_id, request.run_spec.model)

                resp = await conn.prompt(
                    prompt=[text_block(_user_text(request))], session_id=session_id
                )
                stop = getattr(resp, "stop_reason", None)
        except Exception as exc:  # noqa: BLE001 — 归一为 error 终态,不向上抛裸异常
            await on_event(_emit("error", {"message": f"acp run failed: {exc}"}))
            self._active.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error=str(exc))

        self._active.pop(run_id, None)
        session_id = session.session_id
        if stop in ("cancelled", "refusal"):
            await on_event(_emit("cancelled", {"stop_reason": stop}))
            return RunResult(run_id=run_id, success=False, error=stop, session_id=session_id,
                             usage=usage_holder or None)
        await on_event(_emit("completed", {"stop_reason": stop}))
        return RunResult(run_id=run_id, success=True, session_id=session_id,
                         usage=usage_holder or None)

    @staticmethod
    async def _apply_model(conn, session, session_id: str, model: str | None) -> None:
        """指定模型（best-effort）：在 new_session 返回的 available_models 里按 id 匹配后切换。"""
        if not model:
            return
        models = getattr(getattr(session, "models", None), "available_models", None) or []
        match = next((m for m in models if getattr(m, "model_id", None) == model
                      or getattr(m, "name", None) == model), None)
        if match is None:
            return  # 未知 model 不静默切换,也不致 run 失败（保留 runtime 默认）
        try:
            await conn.set_session_model(session_id=session_id,
                                         model_id=getattr(match, "model_id", model))
        except Exception:  # noqa: BLE001 — 模型切换不支持时不阻塞 run
            pass

    async def cancel(self, run_id: str) -> None:
        active = self._active.get(run_id)
        if active is None:
            return
        conn, session_id = active
        try:
            await conn.cancel(session_id=session_id)
        except Exception:  # noqa: BLE001
            pass
