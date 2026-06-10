"""Runtime executor — drives real Hermes execution for accepted runs.

Per 业务解决方案设计 §5.2 (Hermes 统一执行底座) and 技术概要设计 §4.3 主链:
Team Panel accepts the run → Gateway translates → **this module** invokes the
Hermes runtime (one-shot ``hermes -z`` agent loop) and feeds the resulting
events back through ``event_ingest_service`` (结果回流主链).

Scope (Phase 1, 私聊闭环 per CLAUDE.md):
- single-agent runs: real LLM execution through Hermes' full agent loop
- employee persona: EmployeePrompt.system_prompt written to the profile's
  SOUL.md (minimal 上下文系统 mapping per §5.2-B)
- knowledge injection: enabled KB bindings are queried through the LightRAG
  service and retrieved chunks are prepended as context (演示场景①)

Environment contract (CLAUDE.md §3.2): hermes binary and home resolve from
``HERMES_WEBUI_AGENT_DIR`` / ``HERMES_HOME`` in app/.env.
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


# ── Hermes environment resolution (app/.env contract) ────────────────────

def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()


def _hermes_bin() -> str:
    agent_dir = os.getenv("HERMES_WEBUI_AGENT_DIR", "").strip()
    candidates = []
    if agent_dir:
        candidates.append(Path(agent_dir) / "venv" / "bin" / "hermes")
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
            kb_ids = [
                b.knowledge_base_id
                for b in (uow.employee_knowledge_bindings().list_by_employee(employee_id) if employee_id else [])
                if getattr(b, "enabled", True)
            ]
            message_text = _input_message_text(run)
            profile_name = (employee.profile_name if employee and employee.profile_name else employee_id) or "default"

            run.status = "running"
            uow.team_runs().update_status(run)
            _ingest(uow, run, "run_started", preview="员工开始处理任务",
                    payload={"profile_name": profile_name}, employee_id=employee_id)

        # Phase 2 — context assembly (persona + knowledge) and Hermes call.
        system_prompt = (prompt.system_prompt if prompt else "") or ""
        _provision_profile(profile_name, system_prompt)
        knowledge_block, citations = _retrieve_knowledge(kb_ids, message_text)
        full_prompt = _compose_prompt(system_prompt, knowledge_block, message_text)

        if knowledge_block:
            with UnitOfWork(conn) as uow:
                run = uow.team_runs().get_by_id(run_id)
                _ingest(uow, run, "tool_call",
                        preview=f"知识库检索命中 {len(citations)} 段内容",
                        payload={"tool": "knowledge_retrieval", "citations": citations},
                        employee_id=employee_id)

        success, output = _invoke_hermes(profile_name, full_prompt)

        # Phase 3 — result write-back (message + terminal event + status).
        _finalize(run_id, success=success, output=output,
                  employee_id=employee_id, citations=citations, conn=conn)
    finally:
        conn.close()


def _input_message_text(run) -> str:
    try:
        payload = json.loads(run.input_message_json or "{}")
        return str(payload.get("message_text") or "")
    except (TypeError, json.JSONDecodeError):
        return ""


def _compose_prompt(system_prompt: str, knowledge_block: str, message_text: str) -> str:
    parts = []
    if system_prompt.strip():
        parts.append(f"[你的角色设定]\n{system_prompt.strip()}")
    if knowledge_block:
        parts.append(
            "[企业知识库检索结果 — 回答时优先引用以下内容]\n" + knowledge_block
        )
    parts.append(message_text.strip())
    return "\n\n".join(parts)


# ── Profile provisioning + persona mapping (§5.2-B minimal) ──────────────

def _provision_profile(profile_name: str, system_prompt: str) -> None:
    from agent_gateway.profile_provisioner import ensure_profile

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


def _runtime_env(profile_name: str) -> dict:
    env = dict(os.environ)
    profile_dir = _profile_home(profile_name)
    # Run inside the profile home only when it is a usable Hermes home;
    # otherwise fall back to the shared home (persona still in the prompt).
    if (profile_dir / "config.yaml").is_file():
        env["HERMES_HOME"] = str(profile_dir)
    else:
        env["HERMES_HOME"] = str(_hermes_home())
    return env


# ── Knowledge retrieval (LightRAG, 演示场景①) ─────────────────────────────

def _retrieve_knowledge(kb_ids: list[str], question: str) -> tuple[str, list[dict]]:
    if not kb_ids or not question.strip():
        return "", []
    from team_panel.integration import lightrag_service

    blocks: list[str] = []
    citations: list[dict] = []
    for kb_id in kb_ids[:3]:
        try:
            result = lightrag_service.query(kb_id, question, top_k=3)
        except Exception as exc:  # noqa: BLE001 — retrieval is best-effort
            logger.warning("[executor] kb %s retrieval failed: %s", kb_id, exc)
            continue
        for chunk in result.get("chunks", []):
            content = (chunk.get("content") or "").strip()
            if not content:
                continue
            source = chunk.get("file_name") or chunk.get("doc_id") or kb_id
            blocks.append(f"- ({source}) {content}")
            citations.append({
                "knowledge_base_id": kb_id,
                "document_id": chunk.get("doc_id") or "",
                "title": source,
                "snippet": content[:200],
                "source_type": "knowledge_document",
            })
    return "\n".join(blocks), citations


# ── Hermes invocation ─────────────────────────────────────────────────────

def _invoke_hermes(profile_name: str, prompt: str) -> tuple[bool, str]:
    cmd = [_hermes_bin(), "-z", prompt, "--cli"]
    env = _runtime_env(profile_name)
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
              error: str = "", conn=None) -> None:
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

            if success and output:
                _ingest(uow, run, "message_delta", preview=output[:200],
                        payload={"delta": output, "citations": citations or []},
                        employee_id=employee_id)
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
                    payload={"success": success, "error": error},
                    employee_id=employee_id)
            run.status = "succeeded" if success else "failed"
            uow.team_runs().update_status(run)
    finally:
        if own_conn:
            conn.close()


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
