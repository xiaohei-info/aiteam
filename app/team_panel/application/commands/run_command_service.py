"""Run command service -- write-side operations for TeamRun lifecycle."""
import json
import uuid

from agent_gateway.contracts import SingleAgentRunRequest
from agent_gateway.runtime_dispatcher import dispatch
from team_panel.domain.entities import ConversationMessage, TeamRun


def create_run(uow, conversation_id: str, employee_id: str | None,
               message_text: str, idempotency_key: str,
               *, message_payload: dict | None = None) -> dict:
    """Persist a TeamRun with idempotency and route it through Gateway accept."""
    existing = _find_run_by_idempotency(uow, idempotency_key)
    if existing is not None:
        run = uow.team_runs().get_by_id(existing)
        if run is not None:
            binding = uow.runtime_bindings().get_by_owner("team_run", run.id)
            return {
                "run_id": run.id,
                "status": run.status,
                "conversation_id": run.conversation_id,
                "stream_url": f"/api/team/runs/{run.id}/stream?cursor=0",
                "events_url": f"/api/team/runs/{run.id}/events?cursor=0",
                "runtime_handle": {
                    "kind": "session",
                    "profile_name": binding.profile_name if binding else (run.entry_employee_id or ""),
                    "session_id": binding.runtime_session_id if binding else None,
                },
            }

    conv = uow.conversations().get_by_id(conversation_id)
    if conv is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    if not message_text.strip():
        raise ValueError("message.text is required")

    enterprise_id = conv.enterprise_id
    run_id = f"run_{uuid.uuid4().hex[:12]}"

    normalized_message_payload = _normalize_message_payload(message_payload, message_text)

    run = TeamRun(
        id=run_id,
        enterprise_id=enterprise_id,
        conversation_id=conversation_id,
        trigger_type="private_message" if employee_id else "manual_run",
        execution_mode="single_agent",
        status="queued",
        entry_employee_id=employee_id,
        idempotency_key=idempotency_key,
        input_message_json=json.dumps(normalized_message_payload, ensure_ascii=False),
        created_by=employee_id or "system",
    )
    knowledge_preview = build_knowledge_preview_for_employees(uow, [employee_id or conv.entry_employee_id or ""])
    if knowledge_preview is not None:
        run.result_summary_json = json.dumps(knowledge_preview, ensure_ascii=False)
    uow.team_runs().create(run)

    message_id = f"msg_{uuid.uuid4().hex[:12]}"
    uow.conversation_messages().create(
        ConversationMessage(
            id=message_id,
            conversation_id=conversation_id,
            run_id=run_id,
            sender_id=employee_id or conv.entry_employee_id or "user",
            sender_type="user",
            message_text=message_text,
            message_json=json.dumps(normalized_message_payload, ensure_ascii=False),
        )
    )

    conv.latest_run_id = run_id
    conv.latest_message_id = message_id
    conv.last_message_preview = message_text[:200] if message_text else None
    uow.conversations().update_latest_run(conv.id, run_id, message_id, conv.last_message_preview or "")

    gw_response = dispatch(
        uow,
        SingleAgentRunRequest(
            run_id=run_id,
            employee_id=employee_id or conv.entry_employee_id or "",
            conversation_id=conversation_id,
            message_text=message_text,
            enterprise_id=enterprise_id,
            profile_name=employee_id or conv.entry_employee_id or "",
            idempotency_key=idempotency_key,
        ),
    )

    return {
        "run_id": run_id,
        "status": run.status,
        "conversation_id": conversation_id,
        "stream_url": gw_response.stream_url,
        "events_url": gw_response.events_url,
        "runtime_handle": {
            "kind": gw_response.runtime_handle.kind,
            "profile_name": gw_response.runtime_handle.profile_name,
            "session_id": gw_response.runtime_handle.session_id,
        },
    }


def build_knowledge_preview_for_employees(uow, employee_ids: list[str]) -> dict | None:
    citations = []
    seen = set()
    for employee_id in employee_ids:
        if not employee_id or employee_id in seen:
            continue
        seen.add(employee_id)
        bindings = [
            binding
            for binding in uow.employee_knowledge_bindings().list_by_employee(employee_id)
            if getattr(binding, "enabled", True)
        ]
        for binding in bindings:
            kb = uow.knowledge_bases().get_by_id(binding.knowledge_base_id)
            docs = uow.knowledge_documents().list_by_kb(binding.knowledge_base_id, status="ready")
            for doc in docs[:1]:
                citations.append(
                    {
                        "title": doc.display_name or doc.file_name or (kb.name if kb is not None else binding.knowledge_base_id),
                        "knowledge_base_id": binding.knowledge_base_id,
                        "document_id": doc.id,
                        "source_type": "knowledge_document",
                    }
                )
    if not citations:
        return None

    return {
        "summary": "已参考知识库内容整理初步回答。",
        "citations": citations,
    }


def _find_run_by_idempotency(uow, idempotency_key: str) -> str | None:
    """Return run_id if a run with this idempotency_key exists, else None."""
    existing = uow.team_runs().get_by_idempotency_key(idempotency_key)
    return existing.id if existing else None


def _normalize_message_payload(message_payload: dict | None, message_text: str) -> dict:
    payload = dict(message_payload or {})
    payload["message_text"] = message_text
    attachments = payload.get("attachments")
    if not isinstance(attachments, list):
        payload["attachments"] = []
    else:
        payload["attachments"] = [item for item in attachments if isinstance(item, dict)]
    for key in ("quote_message_id", "reference_message_id", "reply_to_message_id"):
        value = payload.get(key)
        if value in (None, ""):
            payload.pop(key, None)
        elif not isinstance(value, str):
            payload[key] = str(value)
    return payload
