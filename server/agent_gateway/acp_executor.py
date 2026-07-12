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

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, EventSink, RunResult
from shared.contracts.gateway import Executor
from shared.contracts.runspec import AgentRunRequest, McpServerConfig

from .sandbox import SandboxPolicy, build_env, prepare_run_dir


def _acp_mcp_servers(configs: list[McpServerConfig]) -> list[object]:
    """把中立 MCP 配置映射为 ACP ``session/new`` 参数。

    配置只存在本次 ACP RPC 内存中，绝不写 Hermes profile。RunSpec 无 SSE transport
    字段，因此 URL 类型按 ACP HTTP transport 处理。
    """
    if not configs:
        return []

    from acp.schema import EnvVariable, McpServerHttp, McpServerStdio

    servers: list[object] = []
    for config in configs:
        if config.command:
            servers.append(McpServerStdio(
                name=config.name,
                command=config.command,
                args=list(config.args),
                env=[EnvVariable(name=name, value=value) for name, value in config.env.items()],
            ))
            continue
        if config.url:
            servers.append(McpServerHttp(name=config.name, url=config.url, headers=[]))
            continue
        raise ValueError(f"MCP server {config.name!r} requires command or url")
    return servers


def _prepare_hermes_skill_home(cwd: str, env: dict[str, str]) -> None:
    """为单次 Hermes run 创建仅含技能目录映射的临时 Home。

    Hermes 通过 ``skills.external_dirs`` 发现外部技能，ACP 没有对应会话字段。这里复制
    AITeam 已显式传入的隔离 Home 配置，新增本 run 的 skills 映射；绝不修改来源 Home。
    """
    source_home = env.get("HERMES_HOME")
    if not source_home:
        raise RuntimeError("Hermes skill injection requires an isolated HERMES_HOME")
    source_config = Path(source_home).expanduser() / "config.yaml"
    if not source_config.is_file():
        raise RuntimeError(f"Hermes config not found in isolated HERMES_HOME: {source_config}")

    skill_root = str((Path(cwd) / ".agent_context" / "skills").resolve())
    text = source_config.read_text(encoding="utf-8")
    skills_match = re.search(r"(?m)^skills:\s*(?:#.*)?\n", text)
    if skills_match is None:
        text = text.rstrip() + f"\n\nskills:\n  external_dirs:\n  - {json.dumps(skill_root)}\n"
    else:
        start = skills_match.end()
        next_section = re.search(r"(?m)^[^ \t#][^:\n]*:\s*(?:#.*)?$", text[start:])
        end = start + next_section.start() if next_section else len(text)
        block = text[start:end]
        existing_dirs = re.search(r"(?m)^  external_dirs:\s*(?:#.*)?\n((?:^  - .*\n)*)", block)
        preserved = existing_dirs.group(1) if existing_dirs else ""
        external_dirs = f"  external_dirs:\n  - {json.dumps(skill_root)}\n{preserved}"
        # 仅移除 skills.external_dirs 本身和紧随的二级列表项，其他 skills 设置原样保留。
        block = re.sub(r"(?m)^  external_dirs:\s*(?:#.*)?\n(?:^  - .*\n)*", "", block)
        text = text[:start] + external_dirs + block + text[end:]

    run_home = Path(cwd) / ".aiteam-hermes-home"
    run_home.mkdir(parents=True, exist_ok=True)
    (run_home / "config.yaml").write_text(text, encoding="utf-8")
    env["HERMES_HOME"] = str(run_home)


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


def _prompt_text(request: AgentRunRequest) -> str:
    """在 ACP 标准 prompt 通道传递专家指令与用户输入。

    当前 ACP ``session/new`` schema 未定义 systemPrompt 字段；因此不写 runtime profile，
    只在本次协议 prompt 中明确分隔可信的 Manager 快照 persona 与用户内容。
    """
    user_text = _user_text(request)
    system_prompt = (request.run_spec.system_prompt or "").strip()
    if not system_prompt:
        return user_text
    return (
        "【专家执行指令（来自企业已授权快照，必须优先遵守）】\n"
        f"{system_prompt}\n\n"
        "【用户请求】\n"
        f"{user_text}"
    )


class AcpClientExecutor(Executor):
    """ACP 协议族执行器：经 ACP SDK 客户端驱动 agent 子进程。"""

    family = "acp"

    def __init__(self, *, sandbox: SandboxPolicy | None = None, skill_cache=None) -> None:
        self._sandbox = sandbox
        self._skill_projector = None
        if skill_cache is not None:
            from agent_service.capabilities.skill_projector import SkillProjector

            self._skill_projector = SkillProjector(skill_cache)
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
        skill_error: str | None = None
        if self._sandbox is not None:
            cwd = prepare_run_dir(self._sandbox, run_id)
            env = build_env(self._sandbox)
            # provider_ref 已在业务层解析为最小凭据集合；ACP 子进程同样必须显式注入，
            # 不能依赖宿主环境继承（D18）。
            env.update(request.provider_env)
            if self._skill_projector is not None and request.skill_refs:
                from agent_service.capabilities.skill_projector import MissingSkillError

                try:
                    projection = self._skill_projector.project(
                        run_id=run_id,
                        work_dir=cwd,
                        runtime=request.runtime_selection or getattr(driver, "runtime_name", ""),
                        skill_refs=list(request.skill_refs),
                    )
                except MissingSkillError as exc:
                    skill_error = str(exc)
                else:
                    env.update(projection.env_overrides)
                    if getattr(driver, "runtime_name", None) == "hermes":
                        try:
                            _prepare_hermes_skill_home(cwd, env)
                        except RuntimeError as exc:
                            skill_error = str(exc)

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

        if skill_error is not None:
            await on_event(_emit("error", {"message": skill_error}))
            return RunResult(run_id=run_id, success=False, error=skill_error)

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
                session = await conn.new_session(
                    cwd=cwd or ".",
                    mcp_servers=_acp_mcp_servers(request.run_spec.mcp_config),
                )
                session_id = session.session_id
                self._active[run_id] = (conn, session_id)

                await self._apply_model(conn, session, session_id, request.run_spec.model)

                resp = await conn.prompt(
                    prompt=[text_block(_prompt_text(request))], session_id=session_id
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
        model_state = getattr(session, "models", None)
        current_model_id = getattr(model_state, "current_model_id", None)
        # Hermes custom provider 会以 ``custom:<model>`` 作为当前 model id。
        # RunSpec 仍保持 runtime 中立的裸 model id；二者短名相同意味着 Driver 已通过
        # 临时 HERMES_HOME 映射到正确 provider，不应再从同名候选（如 OpenRouter）中误切换。
        if isinstance(current_model_id, str) and current_model_id.rsplit(":", 1)[-1] == model:
            return
        models = getattr(model_state, "available_models", None) or []
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
