"""Codex app-server 执行器（06 §7.2，#185）。

真正"会说 codex app-server JSON-RPC"的 Executor：拉起 `codex app-server` 子进程，作客户端
完成 **initialize → initialized → thread/start →（model/effort）turn/start → 流式消费
notification → turn/completed** 的双向握手。与 fire-and-forget 的 `_SubprocessExecutor`
本质不同（那只单向读流，驱动不了常驻 JSON-RPC 服务端）。

codex app-server 的方法名（thread/start / turn/start）是 codex 专有方言，故"notification → 归一
AgentRuntimeEvent"的映射落在本执行器；runtime 命令/能力声明仍归 `CodexJsonRpcDriver`。

B 类能力经 **turn/start 协议字段**注入（非 flag、非文件，D16）：
- model         → turn/start `model`
- thinking_level→ turn/start `effort`（中立档位 → codex ReasoningEffort 枚举）
- system_prompt → thread/start `developerInstructions`

§13 隔离：子进程经沙箱在隔离 cwd + 脱敏 env 下启动；approvalPolicy=never 下无审批往返，
工具仍受本端沙箱约束；server→client 审批请求兜底自动批准。
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, EventSink, Executor, RunResult
from shared.contracts.runspec import AgentRunRequest, RunSpec

from .sandbox import SandboxPolicy, build_env, prepare_run_dir

# 被视为工具调用的 thread item 类型（item/started、item/completed 携带）。
_TOOL_ITEM_TYPES = frozenset(
    {"commandExecution", "mcpToolCall", "dynamicToolCall", "webSearch", "fileChange"}
)

# 中立 thinking_level → codex ReasoningEffort 枚举（none|minimal|low|medium|high|xhigh）。
_EFFORT_MAP = {
    "off": "none",
    "none": "none",
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "max": "xhigh",
    "xhigh": "xhigh",
}


def _tool_name(item: dict) -> str | None:
    t = item.get("type")
    if t == "commandExecution":
        return item.get("command") or "shell"
    if t in ("mcpToolCall", "dynamicToolCall"):
        return item.get("tool")
    if t == "webSearch":
        return "web_search"
    if t == "fileChange":
        return "apply_patch"
    return t


def _tool_input(item: dict) -> dict:
    t = item.get("type")
    if t == "commandExecution":
        return {"command": item.get("command"), "cwd": item.get("cwd")}
    if t in ("mcpToolCall", "dynamicToolCall"):
        return item.get("arguments") or {}
    if t == "webSearch":
        return {"query": item.get("query")}
    if t == "fileChange":
        return {"changes": item.get("changes")}
    return {}


def _tool_output(item: dict) -> object:
    t = item.get("type")
    if t == "commandExecution":
        return item.get("aggregatedOutput")
    if t == "mcpToolCall":
        return item.get("result")
    if t == "dynamicToolCall":
        return item.get("contentItems")
    return item.get("result") or item.get("aggregatedOutput")


_TOOL_FAILED_STATUS = frozenset({"failed", "aborted", "error", "canceled", "cancelled"})


def _tool_is_error(item: dict) -> bool:
    if item.get("exitCode") not in (None, 0):
        return True
    if item.get("status") in _TOOL_FAILED_STATUS:
        return True
    if item.get("error"):
        return True
    return item.get("success") is False


def map_codex_notification(method: str, params: dict) -> tuple[str, dict] | None:
    """codex notification → (归一事件类型, 净荷)。无法映射返回 None（不静默伪造）。

    纯函数，便于 golden 测试直接喂真实 codex notification 断言。
    turn/completed 与 error 为终态信号，由执行器处理，不在此产流式事件。
    """
    if method == "item/agentMessage/delta":
        return "text_delta", {"text": params.get("delta") or ""}
    if method in ("item/reasoning/textDelta", "item/reasoning/summaryTextDelta"):
        return "reasoning_delta", {"text": params.get("delta") or ""}
    if method == "item/started":
        item = params.get("item") or {}
        if item.get("type") in _TOOL_ITEM_TYPES:
            return "tool_call_started", {
                "tool_id": item.get("id"),
                "name": _tool_name(item),
                "input": _tool_input(item),
            }
        return None
    if method == "item/completed":
        item = params.get("item") or {}
        if item.get("type") in _TOOL_ITEM_TYPES:
            return "tool_call_completed", {
                "tool_id": item.get("id"),
                "output": _tool_output(item),
                "is_error": _tool_is_error(item),
            }
        return None
    if method == "thread/tokenUsage/updated":
        total = (params.get("tokenUsage") or {}).get("total") or {}
        return "usage", dict(total)
    return None


def _effort_of(thinking_level: str | None) -> str | None:
    """中立 thinking_level → codex effort 枚举；未知/空返回 None（不注入，保留默认）。"""
    if not thinking_level:
        return None
    return _EFFORT_MAP.get(thinking_level.strip().lower())


def _user_text(request: AgentRunRequest) -> str:
    """取最后一条 user 消息文本作 prompt（私聊主路径）。"""
    for msg in reversed(request.input_messages):
        if msg.get("role") == "user":
            return str(msg.get("content", ""))
    return request.input_messages[-1].get("content", "") if request.input_messages else ""


def _err_text(err: object) -> str:
    if isinstance(err, dict):
        return str(err.get("message") or err.get("detail") or err)
    return str(err)


class _JsonRpcStdio:
    """line-delimited JSON-RPC over stdio 的最小异步客户端。

    - request(): 发请求并按 id await 结果。
    - notify(): 发通知（无 id）。
    - 读循环分发：响应→唤醒 future；server→client 请求→交 handler 并回响应；通知→交 handler。
    """

    def __init__(self, proc, on_notification, on_server_request) -> None:
        self._proc = proc
        self._on_notification = on_notification
        self._on_server_request = on_server_request
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader: asyncio.Task | None = None

    def start(self) -> None:
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        stdout = self._proc.stdout
        assert stdout is not None
        try:
            while True:
                line = await stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue  # 非 JSON 行（日志噪声）忽略。
                await self._dispatch(msg)
        finally:
            # EOF 或被 cancel：兜底唤醒所有 pending future，避免请求方挂死到超时。
            self._fail_pending(RuntimeError("codex app-server closed"))

    def _fail_pending(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def _dispatch(self, msg: dict) -> None:
        if "id" in msg and ("result" in msg or "error" in msg):
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(RuntimeError(_err_text(msg["error"])))
                else:
                    fut.set_result(msg.get("result"))
            return
        method = msg.get("method")
        if method is None:
            return
        if "id" in msg:  # server→client 请求：必须回响应，否则 server 卡住。
            result = await self._on_server_request(method, msg.get("params") or {})
            await self._send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
            return
        await self._on_notification(method, msg.get("params") or {})

    async def _send(self, obj: dict) -> None:
        stdin = self._proc.stdin
        if stdin is None:
            return
        stdin.write((json.dumps(obj) + "\n").encode())
        await stdin.drain()

    async def request(self, method: str, params: dict, timeout: float):
        self._id += 1
        rid = self._id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return await asyncio.wait_for(fut, timeout)

    async def notify(self, method: str, params: dict | None = None) -> None:
        msg: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        await self._send(msg)

    async def aclose(self) -> None:
        if self._reader is not None:
            self._reader.cancel()
            try:
                await self._reader  # 等 reader 退出，其 finally 兜底 fail pending。
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._fail_pending(RuntimeError("codex app-server closed"))


# server→client 审批类请求：approvalPolicy=never 下一般不触发，兜底自动批准（依赖本端沙箱）。
_APPROVAL_METHODS = frozenset(
    {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "applyPatchApproval",
        "execCommandApproval",
    }
)


class CodexAppServerExecutor(Executor):
    """codex app-server 协议执行器：经 JSON-RPC 客户端驱动 codex 子进程。"""

    family = "json_rpc_stdio"

    def __init__(self, *, sandbox: SandboxPolicy | None = None, skill_cache=None) -> None:
        self._sandbox = sandbox
        # run_id -> (client, thread_id, turn_id) 供 cancel 透传。
        self._active: dict[str, tuple[_JsonRpcStdio, str, str | None]] = {}
        self._cancelled: set[str] = set()

    async def execute(
        self, request: AgentRunRequest, driver: Driver, on_event: EventSink
    ) -> RunResult:
        run_id = request.run_id
        seq = {"n": 0}

        def _emit(type_: str, payload: dict) -> AgentRuntimeEvent:
            seq["n"] += 1
            return self._event(driver, run_id, seq["n"], type_, payload)

        if run_id in self._cancelled:
            self._cancelled.discard(run_id)
            await on_event(_emit("cancelled", {}))
            return RunResult(run_id=run_id, success=False, error="cancelled")

        command = driver.build_command(request.run_spec)
        cwd = None
        env = None
        if self._sandbox is not None:
            cwd = prepare_run_dir(self._sandbox, run_id)
            env = build_env(self._sandbox)
            # provider_ref 已在业务层解析为最小凭据集合；Codex app-server 子进程同样必须
            # 显式注入，避免沙箱脱敏后丢失运行所需的 provider key（D18）。
            env.update(request.provider_env)

        usage_holder: dict = {}
        terminal: dict = {"type": None, "error": None}
        done = asyncio.Event()

        async def on_notification(method: str, params: dict) -> None:
            if method == "turn/completed":
                err = (params.get("turn") or {}).get("error")
                if err:
                    terminal.update(type="error", error=_err_text(err))
                else:
                    terminal.update(type="completed", error=None)
                done.set()
                return
            if method == "error":
                terminal.update(type="error", error=_err_text(params))
                done.set()
                return
            mapped = map_codex_notification(method, params)
            if mapped is None:
                return
            type_, payload = mapped
            if type_ == "usage":
                usage_holder.update({k: v for k, v in payload.items() if v is not None})
            await on_event(_emit(type_, payload))

        async def on_server_request(method: str, params: dict) -> dict:
            # approvalPolicy=never 下一般不触发；兜底自动批准的安全前提是沙箱隔离生效。
            # sandbox=None（dev 默认）时工具未隔离运行，仅限可信本机 dev。
            if method in _APPROVAL_METHODS:
                return {"decision": "approved"}
            return {}

        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )
        except (OSError, ValueError) as exc:
            await on_event(_emit("error", {"message": f"spawn failed: {exc}"}))
            return RunResult(run_id=run_id, success=False, error=f"spawn failed: {exc}")

        # 有界 stderr 收集：保留启动失败/panic 根因（避免 DEVNULL 抹掉诊断，§10.6）。
        stderr_tail: dict = {"text": ""}
        stderr_task = asyncio.create_task(self._collect_stderr(proc, stderr_tail))

        client = _JsonRpcStdio(proc, on_notification, on_server_request)
        client.start()
        thread_id = ""
        # spawn 成功即登记，使取消在握手期间也能尽早介入（turn_id 待 turn/start 回填）。
        self._active[run_id] = (client, "", None)
        timeout = float(request.run_spec.timeout_seconds or 300)
        try:
            await client.request(
                "initialize",
                {"clientInfo": {"name": "aiteam-gateway", "version": "1.0"}},
                30,
            )
            await client.notify("initialized")
            ts = await client.request("thread/start", self._thread_params(request, cwd), 30)
            thread_id = (ts.get("thread") or {}).get("id") or ""
            tr = await client.request(
                "turn/start", self._turn_params(request, thread_id), 30
            )
            turn_id = (tr.get("turn") or {}).get("id")
            self._active[run_id] = (client, thread_id, turn_id)
            await asyncio.wait_for(done.wait(), timeout)
        except asyncio.TimeoutError:
            terminal.update(type="error", error="run timeout")
        except Exception as exc:  # noqa: BLE001 — 归一为 error 终态，不抛裸异常
            detail = str(exc)
            tail = stderr_tail["text"].strip()
            if tail:
                detail = f"{detail}: {tail}"
            terminal.update(type="error", error=detail)
        finally:
            self._active.pop(run_id, None)
            stderr_task.cancel()
            await self._teardown(client, proc)

        if run_id in self._cancelled:
            self._cancelled.discard(run_id)
            await on_event(_emit("cancelled", {}))
            return RunResult(run_id=run_id, success=False, error="cancelled",
                             session_id=thread_id or None, usage=usage_holder or None)
        if terminal["type"] == "completed":
            await on_event(_emit("completed", {}))
            return RunResult(run_id=run_id, success=True, session_id=thread_id or None,
                             usage=usage_holder or None)
        error = terminal["error"] or "codex run failed"
        await on_event(_emit("error", {"message": error}))
        return RunResult(run_id=run_id, success=False, error=error,
                         session_id=thread_id or None, usage=usage_holder or None)

    async def cancel(self, run_id: str) -> None:
        self._cancelled.add(run_id)
        active = self._active.get(run_id)
        if active is None:
            return
        client, thread_id, turn_id = active
        if turn_id:
            try:
                await client.request(
                    "turn/interrupt", {"threadId": thread_id, "turnId": turn_id}, 10
                )
            except Exception:  # noqa: BLE001 — 取消尽力而为
                pass

    # ---- 协议参数构造（B 类经协议字段注入，D16）-----------------------

    @staticmethod
    def _thread_params(request: AgentRunRequest, cwd: str | None) -> dict:
        params: dict = {"cwd": cwd or ".", "approvalPolicy": "never"}
        if request.run_spec.system_prompt:
            params["developerInstructions"] = request.run_spec.system_prompt
        return params

    @staticmethod
    def _turn_params(request: AgentRunRequest, thread_id: str) -> dict:
        spec: RunSpec = request.run_spec
        params: dict = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": _user_text(request)}],
        }
        if spec.model:
            params["model"] = spec.model
        effort = _effort_of(spec.thinking_level)
        if effort:
            params["effort"] = effort
        return params

    # ---- 辅助 ----------------------------------------------------------

    @staticmethod
    def _event(driver: Driver, run_id: str, n: int, type_: str, payload: dict) -> AgentRuntimeEvent:
        return AgentRuntimeEvent(
            event_id=f"codex_{run_id}_{n}",
            run_id=run_id,
            seq=n,
            type=type_,  # type: ignore[arg-type]
            source=getattr(driver, "runtime_name", "codex"),
            timestamp=datetime.now(timezone.utc),
            payload=payload,
        )

    @staticmethod
    async def _collect_stderr(proc, holder: dict, *, cap: int = 8192) -> None:
        """持续 drain stderr 到有界缓冲（防 PIPE 写满阻塞子进程；保留尾部根因）。"""
        if proc.stderr is None:
            return
        try:
            while True:
                chunk = await proc.stderr.read(4096)
                if not chunk:
                    break
                holder["text"] = (holder["text"] + chunk.decode(errors="replace"))[-cap:]
        except (asyncio.CancelledError, ValueError, OSError):
            return

    @staticmethod
    async def _teardown(client: _JsonRpcStdio, proc) -> None:
        await client.aclose()
        if proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
