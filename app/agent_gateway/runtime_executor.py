"""Runtime executor — drives real Hermes execution for accepted runs.

Primary path (per 业务解决方案设计 §5.2-J "复用 Hermes WebUI 会话承接和后端
接入框架"): the run executes through the WebUI's own chat chain via
``webui_runtime_adapter`` — full provider/OAuth resolution, session
persistence, streaming deltas and tool-call surfacing come from the existing
base, not from a re-implementation. Fallback path: one-shot ``hermes -z`` CLI
(used when the WebUI loopback is unreachable, e.g. unit tests).

Responsibilities:
- employee persona: EmployeePrompt.system_prompt → profile SOUL.md (§5.2-B)
- employee model mapping: Employee.model_name/model_provider → chat request
- knowledge injection: enabled KB bindings → LightRAG chunks in prompt (场景①)
- 结果回流主链: token/tool/reasoning events stream live into run_event via
  ``event_ingest_service`` AND are broadcast to SSE subscribers via
  ``event_hydrator``; status machine queued→running→terminal
- SSE 实时推送: on_event callback simultaneously pushes RunTimelineEvent
  to the per-run StreamChannel so northbound SSE subscribers receive events
  in real-time (§9.4 Event Hydrator pattern)
- 会话承接: the WebUI session_id is persisted on a conversation-scoped
  RuntimeBinding so follow-up turns share context.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)

RUN_TIMEOUT_SECONDS = int(os.getenv("AITEAM_RUN_TIMEOUT_SECONDS", "300"))
_DELTA_FLUSH_CHARS = 300
_DELTA_FLUSH_SECONDS = 1.5


# ── Hermes environment resolution (app/.env contract) ────────────────────

def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()


def _hermes_bin() -> str:
    agent_dir = os.getenv("HERMES_WEBUI_AGENT_DIR", "").strip()
    candidates = []
    if agent_dir:
        candidates.append(Path(agent_dir) / "venv" / "bin" / "hermes")
    # Working CLI lives in the WebUI venv (sibling of HERMES_WEBUI_PYTHON);
    # the agent dir has no venv. Check it before a bare ``hermes`` that the
    # server process PATH won't resolve.
    webui_python = os.getenv("HERMES_WEBUI_PYTHON", "").strip()
    if webui_python:
        candidates.append(Path(webui_python).parent / "hermes")
    candidates.append(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "hermes")
    for c in candidates:
        if c.is_file():
            return str(c)
    return "hermes"


def _profile_home(profile_name: str) -> Path:
    return _hermes_home() / "profiles" / profile_name


# ── Public entrypoint ─────────────────────────────────────────────────────

def execute_run_async(run_id: str) -> None:
    """Fire-and-forget execution; POST /runs stays synchronous-contract."""
    t = threading.Thread(
        target=_execute_run_safe, args=(run_id,),
        name=f"run-exec-{run_id}", daemon=True,
    )
    t.start()


def _execute_run_safe(run_id: str) -> None:
    try:
        _execute_run(run_id)
    except Exception:  # noqa: BLE001 — last-resort guard for the thread
        logger.exception("[executor] run %s crashed", run_id)
        try:
            _finalize(run_id, success=False,
                      output="executor internal error", error="EXECUTOR_CRASH")
        except Exception:
            logger.exception("[executor] run %s finalize failed", run_id)


# ── Execution pipeline ────────────────────────────────────────────────────

def _connect():
    import psycopg2
    from team_panel.transactions.db import get_database_url
    return psycopg2.connect(get_database_url())


def _execute_run(run_id: str) -> None:
    from team_panel.transactions.uow import UnitOfWork

    conn = _connect()
    try:
        # Phase 0 — 群聊多智能体编排走专用执行器 (真实多员工拆解/并行/汇总链).
        # 差异备案: 2026-06-11-AI Team-Gateway执行链路实现口径与设计差异备案 §3.
        with UnitOfWork(conn) as uow:
            probe = uow.team_runs().get_by_id(run_id)
        if probe is not None and probe.execution_mode == "kanban_orchestration":
            from agent_gateway.orchestration_executor import execute_orchestration
            execute_orchestration(conn, run_id)
            return

        # Phase 1 — load context, mark running, emit run_started.
        with UnitOfWork(conn) as uow:
            run = uow.team_runs().get_by_id(run_id)
            if run is None:
                logger.warning("[executor] run %s not found", run_id)
                return
            if run.status not in ("queued", "routing", "submitting"):
                logger.info("[executor] run %s already %s; skip", run_id, run.status)
                return
            employee_id = run.entry_employee_id or ""
            employee = uow.employees().get_by_id(employee_id) if employee_id else None
            prompt = uow.employee_prompts().get_by_employee(employee_id) if employee_id else None
            message_text = _input_message_text(run)
            profile_name = (employee.profile_name if employee and employee.profile_name else employee_id) or "default"
            model_name = (employee.model_name if employee else "") or ""
            model_provider = (employee.model_provider if employee else "") or ""
            conv_binding = uow.runtime_bindings().get_by_owner("conversation", run.conversation_id)
            webui_session_id = (conv_binding.runtime_session_id if conv_binding else "") or ""

            run.status = "running"
            uow.team_runs().update_status(run)
            _ingest(uow, run, "run_started", preview="员工开始处理任务",
                    payload={"profile_name": profile_name, "model": model_name},
                    employee_id=employee_id)

        # Phase 2 — persona provisioning + knowledge MCP injection, then execute.
        # 知识检索改为 agentic：员工 LLM 经 knowledge MCP 工具按需调用，不再预注入。
        system_prompt = (prompt.system_prompt if prompt else "") or ""
        _provision_profile(profile_name, system_prompt, employee_id)
        full_prompt = _compose_prompt(system_prompt, message_text)

        success, output, error, session_id, usage = _run_turn_streaming(
            conn, run_id, employee_id,
            profile=profile_name, prompt_text=full_prompt,
            model=model_name, model_provider=model_provider,
            webui_session_id=webui_session_id,
        )

        # Persist conversation-scoped session for 会话承接.
        if session_id:
            _persist_conversation_session(conn, run_id, profile_name, session_id)

        # Phase 3 — result write-back (message + terminal event + status + usage).
        _finalize(run_id, success=success, output=output, error=error,
                  employee_id=employee_id, usage=usage, conn=conn)
    finally:
        conn.close()


def _input_message_text(run) -> str:
    try:
        payload = json.loads(run.input_message_json or "{}")
        return str(payload.get("message_text") or "")
    except (TypeError, json.JSONDecodeError):
        return ""


def _compose_prompt(system_prompt: str, message_text: str) -> str:
    parts = []
    if system_prompt.strip():
        parts.append(f"[你的角色设定]\n{system_prompt.strip()}")
    parts.append(message_text.strip())
    return "\n\n".join(parts)


def _current_event_cursor(conn, run_id: str) -> int:
    """Return the last persisted run_event cursor for a run, best-effort."""
    if conn is None:
        return 0
    from team_panel.transactions.uow import UnitOfWork
    try:
        with UnitOfWork(conn) as uow:
            binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
            return int(binding.event_cursor or 0) if binding is not None else 0
    except Exception:  # noqa: BLE001 — live streaming must still proceed.
        logger.exception("[executor] failed to read current event cursor for run %s", run_id)
        return 0


# ── Turn execution: WebUI chain first, CLI fallback ───────────────────────

def _run_turn_streaming(conn, run_id: str, employee_id: str, *,
                        profile: str, prompt_text: str,
                        model: str, model_provider: str,
                        webui_session_id: str) -> tuple[bool, str, str, str, dict]:
    """Returns (success, final_text, error, webui_session_id, usage)."""
    from agent_gateway import webui_runtime_adapter as webui
    from agent_gateway.event_hydrator import get_hydrator
    from agent_gateway.contracts import (
        RunTimelineEvent, TimelineEventType, REASONING_PAYLOAD_KIND,
        TOOL_CALL_DONE_KEY, TOOL_CALL_RESULT_KEY, TOOL_CALL_IS_ERROR_KEY,
    )

    hydrator = get_hydrator()
    hydrator.register_stream(run_id)

    # Per-run SSE cursor counter (monotonic, mirrors _ingest cursor logic).
    _sse_cursor = [_current_event_cursor(conn, run_id)]
    _sse_cursor_lock = threading.Lock()

    def _next_sse_cursor() -> int:
        with _sse_cursor_lock:
            _sse_cursor[0] += 1
            return _sse_cursor[0]

    def _push_timeline(event_type: TimelineEventType, preview: str,
                       payload: dict) -> None:
        """Push a RunTimelineEvent to SSE subscribers (no DB wait)."""
        cursor = _next_sse_cursor()
        tl = RunTimelineEvent(
            event_id=f"evt_{run_id}_{cursor}",
            event_cursor=cursor,
            run_id=run_id,
            event_type=event_type,
            source_type="session",
            source_id=webui_session_id,
            employee_id=employee_id,
            preview=preview,
            payload=payload,
        )
        hydrator.push_event(run_id, tl)

    def _push_flushed_delta(delta: str, payload: dict) -> None:
        _push_timeline(TimelineEventType.MESSAGE_DELTA, delta[:200], payload)

    flusher = _DeltaFlusher(conn, run_id, employee_id, on_flush=_push_flushed_delta)

    def on_event(kind: str, payload: dict) -> None:
        if kind == "reasoning":
            reasoning_text = str(payload.get("text") or "")
            if reasoning_text:
                flusher.flush()
                _ingest_standalone(conn, run_id, "message_delta",
                                   preview=reasoning_text[:200],
                                   payload={"delta": reasoning_text,
                                            "kind": REASONING_PAYLOAD_KIND},
                                   employee_id=employee_id)
                _push_timeline(TimelineEventType.MESSAGE_DELTA,
                               reasoning_text[:200],
                               {"delta": reasoning_text,
                                "kind": REASONING_PAYLOAD_KIND})
        elif kind == "token":
            token_text = str(payload.get("text") or "")
            if token_text:
                flusher.add(token_text)
        elif kind == "tool":
            flusher.flush()
            tool_payload = {"tool": payload.get("name", ""),
                            "args": payload.get("args") or {},
                            "tid": payload.get("tid", ""),
                            TOOL_CALL_DONE_KEY: False}
            _ingest_standalone(conn, run_id, "tool_call",
                               preview=f"调用工具 {payload.get('name', '')}",
                               payload=tool_payload,
                               employee_id=employee_id)
            _push_timeline(TimelineEventType.TOOL_CALL,
                           f"调用工具 {payload.get('name', '')}",
                           tool_payload)
        elif kind == "tool_complete":
            flusher.flush()
            tc_payload = {"tool": payload.get("name", ""),
                          "args": payload.get("args") or {},
                          "tid": payload.get("tid", ""),
                          TOOL_CALL_DONE_KEY: True,
                          TOOL_CALL_RESULT_KEY: payload.get("preview") or "",
                          TOOL_CALL_IS_ERROR_KEY: bool(payload.get("is_error", False))}
            _ingest_standalone(conn, run_id, "tool_call",
                               preview=f"工具 {payload.get('name', '')} 完成",
                               payload=tc_payload,
                               employee_id=employee_id)
            _push_timeline(TimelineEventType.TOOL_CALL,
                           f"工具 {payload.get('name', '')} 完成",
                           tc_payload)

    try:
        result = webui.run_turn(
            profile=profile, message=prompt_text,
            model=model, model_provider=model_provider,
            session_id=webui_session_id or None,
            on_event=on_event, timeout_seconds=RUN_TIMEOUT_SECONDS,
        )
        flusher.flush()
        return result.success, result.text, result.error, result.session_id, (result.usage or {})
    except OSError as exc:
        # WebUI loopback unreachable — degrade to one-shot CLI execution.
        logger.warning("[executor] webui loopback unavailable (%s); CLI fallback", exc)
        flusher.flush()
        ok, out = _invoke_hermes_cli(profile, prompt_text)
        if ok and out:
            payload = {"delta": out}
            _ingest_standalone(conn, run_id, "message_delta",
                               preview=out[:200], payload=payload,
                               employee_id=employee_id)
            _push_timeline(TimelineEventType.MESSAGE_DELTA, out[:200], payload)
        return ok, out, ("" if ok else out), "", {}
    finally:
        hydrator.close_stream(run_id)


class _DeltaFlusher:
    """Batches streamed tokens into message_delta events (避免逐 token 写库)."""

    def __init__(self, conn, run_id: str, employee_id: str, on_flush=None):
        self._conn = conn
        self._run_id = run_id
        self._employee_id = employee_id
        self._on_flush = on_flush
        self._buf: list[str] = []
        self._chars = 0
        self._last_flush = time.time()

    def add(self, chunk: str) -> None:
        if not chunk:
            return
        self._buf.append(chunk)
        self._chars += len(chunk)
        if self._chars >= _DELTA_FLUSH_CHARS or (time.time() - self._last_flush) >= _DELTA_FLUSH_SECONDS:
            self.flush()

    def flush(self) -> None:
        if not self._buf:
            return
        delta = "".join(self._buf)
        self._buf = []
        self._chars = 0
        self._last_flush = time.time()
        payload = {"delta": delta}
        _ingest_standalone(self._conn, self._run_id, "message_delta",
                           preview=delta[:200], payload=payload,
                           employee_id=self._employee_id)
        if self._on_flush is not None:
            self._on_flush(delta, payload)


def _ingest_standalone(conn, run_id: str, event_type: str, *,
                       preview: str, payload: dict, employee_id: str) -> None:
    from team_panel.transactions.uow import UnitOfWork
    try:
        with UnitOfWork(conn) as uow:
            run = uow.team_runs().get_by_id(run_id)
            if run is not None:
                _ingest(uow, run, event_type, preview=preview,
                        payload=payload, employee_id=employee_id)
    except Exception:  # noqa: BLE001 — streaming write must not kill the run
        logger.exception("[executor] streaming ingest failed (%s)", event_type)


def _persist_conversation_session(conn, run_id: str, profile_name: str,
                                  session_id: str) -> None:
    from team_panel.domain.entities import RuntimeBinding
    from team_panel.transactions.uow import UnitOfWork
    try:
        with UnitOfWork(conn) as uow:
            run = uow.team_runs().get_by_id(run_id)
            if run is None:
                return
            binding = uow.runtime_bindings().get_by_owner("conversation", run.conversation_id)
            if binding is None:
                uow.runtime_bindings().create(RuntimeBinding(
                    id=f"binding_{uuid.uuid4().hex[:8]}",
                    enterprise_id=run.enterprise_id,
                    owner_type="conversation",
                    owner_id=run.conversation_id,
                    profile_name=profile_name,
                    runtime_kind="session",
                    runtime_session_id=session_id,
                ))
            elif binding.runtime_session_id != session_id:
                binding.runtime_session_id = session_id
                binding.mark_synced()
                uow.runtime_bindings().update_sync(binding)
    except Exception:  # noqa: BLE001 — continuity is best-effort
        logger.exception("[executor] conversation session persist failed")


# ── Profile provisioning + persona mapping (§5.2-B minimal) ──────────────

def _knowledge_mcp_url() -> str:
    """Resolve the in-process knowledge MCP endpoint (D2)."""
    port = os.getenv("KNOWLEDGE_MCP_PORT", "9701")
    return os.getenv("AITEAM_KNOWLEDGE_MCP_URL", f"http://127.0.0.1:{port}/mcp")


def _provision_profile(profile_name: str, system_prompt: str,
                       employee_id: str = "") -> None:
    from agent_gateway.profile_provisioner import ensure_profile, set_profile_mcp

    home = _hermes_home()
    try:
        ensure_profile(profile_name, home)
    except Exception as exc:  # noqa: BLE001 — degraded: run on shared home
        logger.warning("[executor] profile create failed for %s: %s", profile_name, exc)
    profile_dir = _profile_home(profile_name)
    if profile_dir.is_dir() and system_prompt.strip():
        try:
            (profile_dir / "SOUL.md").write_text(system_prompt.strip() + "\n", encoding="utf-8")
        except OSError as exc:
            logger.warning("[executor] SOUL.md write failed for %s: %s", profile_name, exc)
    # Inject knowledge MCP (token = employee_id). Must run after ensure_profile,
    # which re-seeds config.yaml from root on every call.
    if profile_dir.is_dir() and employee_id:
        try:
            set_profile_mcp(profile_dir, _knowledge_mcp_url(), employee_id)
        except Exception as exc:  # noqa: BLE001 — degraded: agentic retrieval off
            logger.warning("[executor] MCP inject failed for %s: %s", profile_name, exc)


# ── CLI fallback (used when WebUI loopback unreachable) ───────────────────

def _invoke_hermes_cli(profile_name: str, prompt: str) -> tuple[bool, str]:
    cmd = [_hermes_bin(), "-z", prompt, "--cli"]
    env = dict(os.environ)
    profile_dir = _profile_home(profile_name)
    env["HERMES_HOME"] = str(profile_dir if (profile_dir / "config.yaml").is_file() else _hermes_home())
    started = time.time()
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=RUN_TIMEOUT_SECONDS, env=env,
        )
    except subprocess.TimeoutExpired:
        return False, f"执行超时（>{RUN_TIMEOUT_SECONDS}s）"
    except OSError as exc:
        return False, f"Hermes 启动失败: {exc}"
    elapsed = time.time() - started
    output = (proc.stdout or "").strip()
    if proc.returncode != 0:
        detail = (proc.stderr or output or "unknown error").strip()
        logger.warning("[executor] hermes rc=%s in %.1fs: %s",
                       proc.returncode, elapsed, detail[:300])
        return False, detail[:2000]
    logger.info("[executor] hermes ok in %.1fs (%d chars)", elapsed, len(output))
    return True, output


# ── Result write-back (结果回流主链) ──────────────────────────────────────

def _finalize(run_id: str, *, success: bool, output: str,
              employee_id: str = "", citations: list[dict] | None = None,
              error: str = "", usage: dict | None = None, conn=None) -> None:
    from team_panel.domain.entities import ConversationMessage
    from team_panel.transactions.uow import UnitOfWork

    own_conn = conn is None
    if own_conn:
        conn = _connect()
    try:
        with UnitOfWork(conn) as uow:
            run = uow.team_runs().get_by_id(run_id)
            if run is None:
                return
            employee_id = employee_id or run.entry_employee_id or ""

            # Persist token usage into the run summary so billing_view_service
            # materializes a non-zero usage_ledger (场景⑤ Token 消耗实时统计).
            if usage:
                try:
                    summary = json.loads(run.result_summary_json or "{}")
                except (TypeError, json.JSONDecodeError):
                    summary = {}
                in_tok = int(usage.get("input_tokens") or 0)
                out_tok = int(usage.get("output_tokens") or 0)
                summary["usage"] = {
                    "input_tokens": in_tok,
                    "output_tokens": out_tok,
                    "total_tokens": int(usage.get("total_tokens") or (in_tok + out_tok)),
                    "cost_cents": int(round(float(usage.get("estimated_cost") or 0) * 100)),
                }
                run.result_summary_json = json.dumps(summary, ensure_ascii=False)
                uow.team_runs().update_status(run)

            if success and output:
                message_id = f"msg_{uuid.uuid4().hex[:12]}"
                uow.conversation_messages().create(ConversationMessage(
                    id=message_id,
                    conversation_id=run.conversation_id,
                    run_id=run.id,
                    sender_id=employee_id or "assistant",
                    sender_type="employee",
                    message_text=output,
                    message_json=json.dumps(
                        {"message_text": output, "citations": citations or []},
                        ensure_ascii=False),
                ))
                uow.conversations().update_latest_run(
                    run.conversation_id, run.id, message_id, output[:200])

            terminal = "run_succeeded" if success else "run_failed"
            _ingest(uow, run, terminal,
                    preview=output[:200] if success else (error or output[:200] or "执行失败"),
                    payload={"success": success, "error": error,
                             "citations": citations or []},
                    employee_id=employee_id)
            run.status = "succeeded" if success else "failed"
            uow.team_runs().update_status(run)
    finally:
        if own_conn:
            conn.close()
        # Clean up hydrator stream after finalize.
        from agent_gateway.event_hydrator import get_hydrator
        get_hydrator().remove_stream(run_id)


def _ingest(uow, run, event_type: str, *, preview: str = "",
            payload: dict | None = None, employee_id: str = "") -> None:
    from team_panel.integration.event_ingest_service import ingest_timeline_event

    binding = uow.runtime_bindings().get_by_owner("team_run", run.id)
    next_cursor = (binding.event_cursor if binding else 0) + 1
    ingest_timeline_event(uow, {
        "id": f"evt_{run.id}_{next_cursor}",
        "enterprise_id": run.enterprise_id,
        "run_id": run.id,
        "cursor_no": next_cursor,
        "event_type": event_type,
        "source_type": "session",
        "source_id": (binding.runtime_session_id if binding else "") or "",
        "employee_id": employee_id or None,
        "event_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "preview_text": preview,
        "payload_json": json.dumps(payload or {}, ensure_ascii=False),
    })
