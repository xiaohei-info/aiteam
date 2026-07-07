\
'''Terminal / command execution capability (issue #415 / 06 section7.4 Local Worker,
section13 isolation).

One-shot command execution: one request == one bash command; emits
command_started -> command_output (stdout/stderr) -> completed | error | cancelled.
Uses pre-existing event types (06 section7.1); no shared-contract change.

Isolation (section13 hard constraint):
- per-run cwd via SandboxPolicy.prepare_run_dir
- env allowlist + minimal extra_env injection via SandboxPolicy.build_env
- overall timeout + idle watchdog + cancel flag, graceful-then-force kill
- output sanitization in Driver only; Executor unaware.
'''

from __future__ import annotations

import asyncio
import signal
import uuid
from datetime import datetime, timezone

from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.gateway import Driver, EventSink, Executor, RunResult
from shared.contracts.runspec import AgentRunRequest

from .sandbox import SandboxPolicy, build_env, prepare_run_dir

TERM_GRACE_SECONDS = 5.0
_TERMINAL_TYPES = frozenset({'completed', 'error', 'cancelled'})


class _ReadTimeout(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class _SeqCounter:
    __slots__ = ('_n',)

    def __init__(self) -> None:
        self._n = 0

    def next(self) -> int:
        self._n += 1
        return self._n


class _RunHandle:
    __slots__ = ('process', 'cancelled')

    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.cancelled = False


def _event_id(run_id: str) -> str:
    return f'ev_{run_id}_{uuid.uuid4().hex[:12]}'


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _extract_command(request: AgentRunRequest) -> str:
    spec = request.run_spec
    if spec.custom_args:
        return str(spec.custom_args[0] or '').strip()
    for msg in reversed(request.input_messages):
        if msg.get('role') == 'user':
            return str(msg.get('content', '')).strip()
    return ''


class TerminalExecutor(Executor):
    family = 'terminal'
    default_idle_seconds: float | None = 300.0

    def __init__(self, *, sandbox: SandboxPolicy | None = None, skill_cache=None) -> None:
        self._runs: dict[str, _RunHandle] = {}
        self._sandbox = sandbox

    async def execute(self, request: AgentRunRequest, driver: Driver, on_event: EventSink) -> RunResult:
        run_id = request.run_id
        handle = self._runs.setdefault(run_id, _RunHandle())
        seq = _SeqCounter()

        if handle.cancelled:
            await self._emit(on_event, run_id, 'cancelled', {}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error='cancelled')

        command = _extract_command(request)
        if not command:
            await self._emit(on_event, run_id, 'error', {'message': 'empty command'}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error='empty command')

        await self._emit(on_event, run_id, 'command_started',
                        {'command': command, 'started_at': _now().isoformat()}, seq)

        proc = await self._spawn(driver.build_command(request.run_spec), run_id)
        if proc is None:
            await self._emit(on_event, run_id, 'error', {'message': 'spawn failed'}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error='spawn failed')
        handle.process = proc

        session_id: str | None = None
        usage: dict | None = None
        terminal_seen = False
        timed_out: str | None = None
        captured_stderr: list[str] = []
        timeout = request.run_spec.timeout_seconds
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout if timeout is not None else None

        try:
            async for raw in self._read_chunks(proc, self.default_idle_seconds, deadline):
                if handle.cancelled:
                    break
                session_id = driver.extract_session_id(raw) or session_id
                got_usage = driver.extract_usage(raw)
                if got_usage is not None:
                    usage = got_usage
                event = driver.parse_event(raw)
                if event is None:
                    continue
                if isinstance(raw, tuple) and len(raw) == 2 and raw[0] == 'stderr':
                    captured_stderr.append(raw[1])
                event = self._stamp(event, run_id, seq)
                if event.type in _TERMINAL_TYPES:
                    terminal_seen = True
                await on_event(event)
        except _ReadTimeout as exc:
            timed_out = exc.reason

        return await self._finalize(proc, on_event, run_id, seq,
                                    handle=handle, session_id=session_id, usage=usage,
                                    terminal_seen=terminal_seen, timed_out=timed_out,
                                    captured_stderr=captured_stderr)

    async def cancel(self, run_id: str) -> None:
        # cancel has no seq; but _emit requires seq. Use a throwaway counter (seq unused for cancel-only).
        seq = _SeqCounter()
        handle = self._runs.setdefault(run_id, _RunHandle())
        handle.cancelled = True
        if handle.process is not None:
            await self._terminate(handle.process)
        # best-effort: record cancel only if run already removed-case not applicable here

    async def _spawn(self, command, run_id):
        cwd = None
        env = None
        if self._sandbox is not None:
            cwd = prepare_run_dir(self._sandbox, run_id)
            env = build_env(self._sandbox)
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
            )
        except (OSError, ValueError):
            return None
        return proc

    async def _finalize(self, proc, on_event, run_id, seq, *, handle, session_id,
                        usage, terminal_seen, timed_out,
                        captured_stderr=()) -> RunResult:
        if handle.cancelled:
            await self._terminate(proc)
            if not terminal_seen:
                await self._emit(on_event, run_id, 'cancelled', {}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error='cancelled', session_id=session_id)
        if timed_out is not None:
            await self._terminate(proc)
            if not terminal_seen:
                await self._emit(on_event, run_id, 'error', {'message': timed_out}, seq)
            self._runs.pop(run_id, None)
            return RunResult(run_id=run_id, success=False, error=timed_out, session_id=session_id)
        return_code = await proc.wait()
        stderr_text = await self._drain_stderr(proc)
        self._runs.pop(run_id, None)
        if return_code != 0:
            streamed_stderr = '\n'.join(s for s in captured_stderr).strip()
            stderr_text = stderr_text.strip() or streamed_stderr
            detail = stderr_text or f'exit code {return_code}'
            if not terminal_seen:
                await self._emit(on_event, run_id, 'error',
                                {'message': detail, 'exit_code': return_code}, seq)
            return RunResult(run_id=run_id, success=False, error=detail,
                             session_id=session_id, usage=usage)
        if not terminal_seen:
            await self._emit(on_event, run_id, 'completed',
                            {'exit_code': return_code, 'finished_at': _now().isoformat()}, seq)
        return RunResult(run_id=run_id, success=True, session_id=session_id, usage=usage)

    async def _read_chunks(self, proc, idle, deadline):
        assert proc.stdout is not None and proc.stderr is not None
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()

        async def _reader(name: str, stream: asyncio.StreamReader) -> None:
            try:
                while True:
                    line = await stream.readline()
                    if not line:
                        break
                    await queue.put((name, line.decode(errors='replace')))
            except (ValueError, OSError):
                pass
            finally:
                await queue.put(None)  # end-of-stream sentinel

        stdout_task = asyncio.create_task(_reader('stdout', proc.stdout))
        stderr_task = asyncio.create_task(_reader('stderr', proc.stderr))
        pending = 2
        try:
            while pending > 0:
                wait, reason = self._next_wait(idle, deadline, loop.time())
                if wait is not None and wait <= 0:
                    raise _ReadTimeout(reason)
                try:
                    if wait is None:
                        item = await queue.get()
                    else:
                        item = await asyncio.wait_for(queue.get(), timeout=wait)
                except asyncio.TimeoutError:
                    raise _ReadTimeout(reason) from None
                if item is None:
                    pending -= 1
                    continue
                yield item
        finally:
            for t in (stdout_task, stderr_task):
                if not t.done():
                    t.cancel()

    @staticmethod
    def _next_wait(idle, deadline, now):
        remaining = None if deadline is None else deadline - now
        if idle is None and remaining is None:
            return None, 'idle timeout'
        if remaining is None:
            return idle, 'idle timeout'
        if idle is None or remaining <= idle:
            return remaining, 'run timeout'
        return idle, 'idle timeout'

    async def _drain_stderr(self, proc) -> str:
        if proc.stderr is None:
            return ''
        try:
            data = await proc.stderr.read()
        except (ValueError, OSError):
            return ''
        return data.decode(errors='replace')

    async def _terminate(self, proc) -> None:
        if proc.returncode is not None:
            return
        try:
            proc.send_signal(signal.SIGTERM)
        except (ProcessLookupError, OSError):
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=TERM_GRACE_SECONDS)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
            await proc.wait()

    def _stamp(self, event, run_id, seq):
        return event.model_copy(update={
            'run_id': run_id,
            'seq': seq.next(),
            'event_id': event.event_id or _event_id(run_id),
            'source': event.source or self.family,
        })

    async def _emit(self, on_event, run_id, type_, payload, seq) -> None:
        await on_event(AgentRuntimeEvent(
            event_id=_event_id(run_id),
            run_id=run_id,
            seq=seq.next(),
            type=type_,  # type: ignore[arg-type]
            source=self.family,
            timestamp=_now(),
            payload=payload,
        ))


__all__ = ['TerminalExecutor']
