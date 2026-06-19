"""Executor 协议族（06 §7.2，D7）。

按**协议族**复用执行器，不按 runtime 品牌堆 adapter：

| Executor | 协议形态 | 适用 runtime |
|---|---|---|
| `AcpExecutor`          | ACP / JSON-RPC over stdio          | Hermes 等 ACP agent |
| `JsonRpcStdioExecutor` | 自定义 JSON-RPC over stdio          | Codex app-server 等 |
| `JsonStreamCliExecutor`| JSONL / stream-json stdout         | Claude Code / OpenCode / OpenClaw |
| `PlainCliExecutor`     | 普通 stdout/stderr（降级，非首选） | 仅降级能力 |

Executor 负责**通用机制**：进程启动/退出、stdin/stdout/stderr 管理、超时、取消、
idle watchdog、原始日志/事件读取、终态归类。**不懂 runtime 差异**——原始记录的语义
解析、session_id/usage 提取、命令翻译全部收口在 Driver（06 §7.3，铁律）。

四个协议族的唯一差异是「如何把一行 stdout 切成一条 raw record」（framing）。其余生命周期
共享在 `_SubprocessExecutor`，子类只实现 `_frame_line`。这样消除「每个 runtime 一整套
executor」的重复，也避免把 JSON stream / JSON-RPC / ACP 混成一个模糊抽象。

只 import `shared.contracts.*`（gateway.Executor / events.AgentRuntimeEvent），禁重定义。
本模块不定义任何业务对象（企业/员工/权限/账单），不直写 runtime 原生 profile 文件。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone

from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, EventSink, Executor, RunResult
from shared.contracts.runspec import AgentRunRequest

# 进程优雅退出 → 强杀的等待窗口（取消/超时清理用）。
_TERM_GRACE_SECONDS = 5.0

# 单 run 内的终态归一事件（出现即认为本 run 已收尾，Executor 不再补发自产终态）。
_TERMINAL_TYPES = ("completed", "error", "cancelled")


class _ReadTimeout(Exception):
    """读流期间超时（idle watchdog 或整体 run timeout），携带归类原因。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class _SeqCounter:
    """单 run 内单调递增序号。"""

    __slots__ = ("_n",)

    def __init__(self) -> None:
        self._n = 0

    def next(self) -> int:
        self._n += 1
        return self._n


def _new_event_id(run_id: str) -> str:
    return f"ev_{run_id}_{uuid.uuid4().hex[:12]}"


class _RunHandle:
    """单 run 的运行期句柄：进程 + 取消标志（cancel 与 execute 跨调用共享）。"""

    __slots__ = ("process", "cancelled")

    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.cancelled = False


class _SubprocessExecutor(Executor):
    """协议族执行器的通用基类：拥有整段子进程生命周期。

    子类只实现 `_frame_line`（把一行 stdout 解析成「交给 Driver 的 raw record」），
    其余（spawn / 读流 / 超时 / idle watchdog / 取消 / stderr / 终态）全部共享。
    """

    #: 协议族标识（也作为归一事件兜底 source）。
    family: str = "subprocess"

    #: idle watchdog 默认窗口（秒）：防 runtime 卡死无输出。None=禁用。
    default_idle_seconds: float | None = None

    def __init__(self) -> None:
        self._runs: dict[str, _RunHandle] = {}

    # ---- 子类钩子 ------------------------------------------------------

    def _frame_line(self, line: str) -> object | None:
        """把一行 stdout 切成一条交给 Driver 的 raw record；返回 None 表示忽略该行。"""
        raise NotImplementedError

    # ---- Executor 契约 -------------------------------------------------

    async def execute(
        self,
        request: AgentRunRequest,
        driver: Driver,
        on_event: EventSink,
    ) -> RunResult:
        run_id = request.run_id
        handle = self._runs.setdefault(run_id, _RunHandle())
        seq = _SeqCounter()

        # 取消可能先于 execute 到达（与 fake_runtime 同语义）：直接短路。
        if handle.cancelled:
            await self._emit(on_event, run_id, "cancelled", {}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error="cancelled")

        proc = await self._spawn(driver.build_command(request.run_spec), request, on_event, run_id, seq)
        if proc is None:
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error="spawn failed")
        handle.process = proc

        session_id: str | None = None
        usage: dict | None = None
        terminal_seen = False
        timed_out: str | None = None  # None | "idle timeout" | "run timeout"

        # 整体 timeout 形成读流绝对截止时刻；idle watchdog 是每行无输出窗口。
        # 二者统一为每次 readline 的 min(idle, remaining)，并按谁先到归类，
        # 消除「无 idle 时挂死进程读流永不返回」的特殊情况。
        timeout = request.run_spec.timeout_seconds
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout if timeout is not None else None

        try:
            async for raw in self._read_records(proc, self.default_idle_seconds, deadline):
                if handle.cancelled:
                    break
                session_id = driver.extract_session_id(raw) or session_id
                got_usage = driver.extract_usage(raw)
                if got_usage is not None:
                    usage = got_usage
                event = driver.parse_event(raw)
                if event is None:
                    continue  # 无法映射的原始事件不静默伪造（契约语义）。
                event = self._stamp(event, run_id, seq)
                if event.type in _TERMINAL_TYPES:
                    terminal_seen = True
                await on_event(event)
        except _ReadTimeout as exc:
            timed_out = exc.reason

        return await self._finalize(
            proc, request, on_event, run_id, seq,
            handle=handle, session_id=session_id, usage=usage,
            terminal_seen=terminal_seen, timed_out=timed_out,
        )

    async def cancel(self, run_id: str) -> None:
        handle = self._runs.setdefault(run_id, _RunHandle())
        handle.cancelled = True
        if handle.process is not None:
            await self._terminate(handle.process)

    # ---- 生命周期分段 --------------------------------------------------

    async def _spawn(self, command, request, on_event, run_id, seq):
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, ValueError) as exc:
            await self._emit(on_event, run_id, "error", {"message": f"spawn failed: {exc}"}, seq)
            return None
        await self._feed_stdin(proc, request)
        return proc

    async def _finalize(
        self, proc, request, on_event, run_id, seq, *,
        handle, session_id, usage, terminal_seen, timed_out,
    ) -> RunResult:
        """统一收尾：取消 > 超时 > 退出码。归一终态事件 + RunResult。"""
        # 取消优先（标志可能在读流期间或之后被置）。
        if handle.cancelled:
            await self._terminate(proc)
            await self._emit(on_event, run_id, "cancelled", {}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error="cancelled", session_id=session_id)

        if timed_out is not None:  # "idle timeout" 或 "run timeout"。
            await self._terminate(proc)
            await self._emit(on_event, run_id, "error", {"message": timed_out}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error=timed_out, session_id=session_id)

        return_code = await proc.wait()  # 读流已读到 EOF，进程即将/已退出。
        stderr_text = await self._drain_stderr(proc)
        self._runs.pop(run_id, None)

        if return_code != 0:
            detail = stderr_text.strip() or f"exit code {return_code}"
            if not terminal_seen:
                await self._emit(on_event, run_id, "error",
                                 {"message": detail, "exit_code": return_code}, seq)
            return RunResult(run_id=run_id, success=False, error=detail,
                             session_id=session_id, usage=usage)

        return RunResult(run_id=run_id, success=True, session_id=session_id, usage=usage)

    # ---- 通用机制实现 --------------------------------------------------

    async def _feed_stdin(self, proc: asyncio.subprocess.Process, request: AgentRunRequest) -> None:
        if proc.stdin is None:
            return
        try:
            if request.input_messages:
                payload = json.dumps(request.input_messages, ensure_ascii=False) + "\n"
                proc.stdin.write(payload.encode())
                await proc.stdin.drain()
            proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass

    async def _read_records(
        self, proc: asyncio.subprocess.Process, idle: float | None, deadline: float | None
    ):
        """按行读 stdout，逐行 framing。

        每次 readline 的等待窗口 = min(idle watchdog, 距整体 deadline 的剩余)；
        谁先到就抛 `_ReadTimeout` 并标明 reason，由 finalize 统一处置（kill + 归一 error）。
        """
        assert proc.stdout is not None
        loop = asyncio.get_running_loop()
        while True:
            wait, reason = self._next_wait(idle, deadline, loop.time())
            if wait is not None and wait <= 0:
                raise _ReadTimeout(reason)
            try:
                if wait is None:
                    line_bytes = await proc.stdout.readline()
                else:
                    line_bytes = await asyncio.wait_for(proc.stdout.readline(), timeout=wait)
            except asyncio.TimeoutError:
                raise _ReadTimeout(reason) from None
            if not line_bytes:
                break  # EOF
            line = line_bytes.decode(errors="replace").rstrip("\n")
            if not line:
                continue
            record = self._frame_line(line)
            if record is not None:
                yield record

    @staticmethod
    def _next_wait(
        idle: float | None, deadline: float | None, now: float
    ) -> tuple[float | None, str]:
        """求下一次 readline 的等待窗口与「先到的超时原因」。"""
        remaining = None if deadline is None else deadline - now
        if idle is None and remaining is None:
            return None, "idle timeout"
        if remaining is None:
            return idle, "idle timeout"
        if idle is None or remaining <= idle:
            return remaining, "run timeout"
        return idle, "idle timeout"

    async def _drain_stderr(self, proc: asyncio.subprocess.Process) -> str:
        if proc.stderr is None:
            return ""
        try:
            data = await proc.stderr.read()
        except (ValueError, OSError):
            return ""
        return data.decode(errors="replace")

    async def _terminate(self, proc: asyncio.subprocess.Process) -> None:
        """优雅 terminate → 等待 → 强杀，确保不留孤儿进程。"""
        if proc.returncode is not None:
            return
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=_TERM_GRACE_SECONDS)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()

    # ---- 归一事件辅助 --------------------------------------------------

    def _stamp(self, event: AgentRuntimeEvent, run_id: str, seq: _SeqCounter) -> AgentRuntimeEvent:
        """Executor 是单 run 内事件顺序元数据（seq/event_id/source）的权威方。

        Driver 只懂 type/payload/source 语义；全局 seq 是通用机制，由 Executor 重盖，
        消除「Driver 必须知道全局序号」的特殊情况。run_id 同样以请求为准；
        event_id/source 留空时由 Executor 补全。
        """
        return event.model_copy(update={
            "run_id": run_id,
            "seq": seq.next(),
            "event_id": event.event_id or _new_event_id(run_id),
            "source": event.source or self.family,
        })

    async def _emit(
        self,
        on_event: EventSink,
        run_id: str,
        type_: str,
        payload: dict,
        seq: _SeqCounter,
    ) -> None:
        """Executor 自产的生命周期事件（terminal/error），不经 Driver。"""
        await on_event(AgentRuntimeEvent(
            event_id=_new_event_id(run_id),
            run_id=run_id,
            seq=seq.next(),
            type=type_,  # type: ignore[arg-type]
            source=self.family,
            timestamp=datetime.now(timezone.utc),
            payload=payload,
        ))


# ---- 协议族子类（唯一差异：framing） -----------------------------------


def _parse_json_line(line: str) -> object | None:
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None  # 非 JSON 行（日志噪声）忽略，不中断流，语义留给 Driver。


class JsonStreamCliExecutor(_SubprocessExecutor):
    """JSONL / stream-json stdout（Claude Code / OpenCode / OpenClaw JSON 模式）。

    每行一个 JSON 对象 → dict raw record 交给 Driver。
    """

    family = "json_stream_cli"
    default_idle_seconds: float | None = 300.0

    def _frame_line(self, line: str) -> object | None:
        return _parse_json_line(line)


class JsonRpcStdioExecutor(_SubprocessExecutor):
    """自定义 JSON-RPC over stdio（Codex app-server 等）。

    line-delimited JSON-RPC envelope（method/params 或 result/error）→ dict 交给 Driver。
    JSON-RPC 与 JSON stream 的传输 framing 一致；语义差异（method 路由 / 请求-响应匹配）
    收口在 Driver，不在 Executor。
    """

    family = "json_rpc_stdio"
    default_idle_seconds: float | None = 300.0

    def _frame_line(self, line: str) -> object | None:
        return _parse_json_line(line)


class AcpExecutor(_SubprocessExecutor):
    """ACP / JSON-RPC over stdio（Hermes 及兼容 ACP 的 agent）。

    ACP 是 JSON-RPC over stdio 的一个 profile：传输层 framing 与 `JsonRpcStdioExecutor`
    相同（line-delimited JSON）。ACP 的握手/session 语义（session/new、session/set_model、
    session/update 通知等）全部由 `HermesAcpDriver`（G2）解析翻译，**Executor 不碰 ACP 语义**。
    """

    family = "acp"
    default_idle_seconds: float | None = 300.0

    def _frame_line(self, line: str) -> object | None:
        return _parse_json_line(line)


class PlainCliExecutor(_SubprocessExecutor):
    """普通 stdout/stderr（降级能力，非生产首选）。

    无结构 framing：每行原样作为 raw record（str）交给 Driver，由 Driver 决定如何包成
    text_delta 等归一事件。仅作降级，能力声明上低于 JSON 协议族。
    """

    family = "plain_cli"
    default_idle_seconds: float | None = 600.0

    def _frame_line(self, line: str) -> object | None:
        return line


__all__ = [
    "AcpExecutor",
    "JsonRpcStdioExecutor",
    "JsonStreamCliExecutor",
    "PlainCliExecutor",
]
