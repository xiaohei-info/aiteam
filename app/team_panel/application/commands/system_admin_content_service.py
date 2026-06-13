"""System-admin content commands for templates and industry solutions."""
from __future__ import annotations

import json
import uuid
from typing import Any

from ...domain.entities import AgentTemplate, AuditEvent, IndustrySolution, SolutionTemplateBinding


_SYSTEM_ACTOR_ID = "system_admin"
_SYSTEM_ENTERPRISE_ID = "platform"


def _json_dumps(value: Any, *, default: Any) -> str:
    if value is None:
        value = default
    return json.dumps(value, ensure_ascii=False)


def _normalize_publish_scope(value: Any) -> str:
    """Normalize a publish-scope payload into canonical JSON text.

    Accepted shapes:
      None / missing / {"mode":"all"}            → {"mode":"all"}
      {"mode":"selected","enterprise_ids":[...]} → selected with deduped ids
    Anything malformed falls back to all (fail-open: visible to everyone).
    """
    default = {"mode": "all"}
    if value in (None, ""):
        return json.dumps(default, ensure_ascii=False)
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return json.dumps(default, ensure_ascii=False)
    if not isinstance(value, dict):
        return json.dumps(default, ensure_ascii=False)
    mode = str(value.get("mode") or "all").strip()
    if mode != "selected":
        return json.dumps(default, ensure_ascii=False)
    raw_ids = value.get("enterprise_ids") or []
    if not isinstance(raw_ids, (list, tuple)):
        raw_ids = []
    enterprise_ids: list[str] = []
    seen: set[str] = set()
    for item in raw_ids:
        eid = str(item).strip()
        if eid and eid not in seen:
            seen.add(eid)
            enterprise_ids.append(eid)
    # selected with empty list is meaningless → treat as all to avoid hiding from everyone.
    if not enterprise_ids:
        return json.dumps(default, ensure_ascii=False)
    return json.dumps({"mode": "selected", "enterprise_ids": enterprise_ids}, ensure_ascii=False)


def _create_audit(
    uow,
    *,
    event_type: str,
    target_type: str,
    target_id: str,
    payload: dict[str, Any] | None = None,
    request_id: str | None = None,
) -> None:
    uow.audit_events().create(
        AuditEvent(
            id=f"ae_{uuid.uuid4().hex[:12]}",
            enterprise_id=_SYSTEM_ENTERPRISE_ID,
            actor_type="system",
            actor_id=_SYSTEM_ACTOR_ID,
            event_type=event_type,
            target_type=target_type,
            target_id=target_id,
            request_id=request_id,
            payload_json=json.dumps(payload or {}, ensure_ascii=False),
            created_by=_SYSTEM_ACTOR_ID,
        )
    )


def create_template(uow, body: dict | None) -> AgentTemplate:
    payload = body or {}
    name = (payload.get("name") or "").strip()
    role_name = (payload.get("role_name") or payload.get("role") or "").strip()
    if not name:
        raise ValueError("name is required")
    if not role_name:
        raise ValueError("role_name is required")

    template = AgentTemplate(
        id=payload.get("template_id") or f"tpl_{uuid.uuid4().hex[:12]}",
        name=name,
        category_code=(payload.get("category_code") or payload.get("category") or "").strip(),
        role_name=role_name,
        status="draft",
        prompt_pack_json=_json_dumps(payload.get("prompt_pack") or payload.get("prompt_pack_json"), default={}),
        default_model_json=_json_dumps(payload.get("default_model_ref") or payload.get("default_model_json"), default={}),
        default_binding_json=_json_dumps(payload.get("default_binding") or payload.get("default_binding_json"), default={}),
        version_no=int(payload.get("version_no") or 1),
        source_type="system",
        publish_scope_json=_normalize_publish_scope(payload.get("publish_scope")),
        created_by=_SYSTEM_ACTOR_ID,
        updated_by=_SYSTEM_ACTOR_ID,
    )
    uow.agent_templates().create(template)

    publish_action = (payload.get("publish_state") or payload.get("publish_action") or "").strip()
    if publish_action == "publish":
        template.status = "published"
        template.version_no += 1
        uow.agent_templates().update(template)
        _create_audit(
            uow,
            event_type="template.publish",
            target_type="template",
            target_id=template.id,
            payload={"from_status": "draft", "to_status": "published", "version_no": template.version_no},
        )
    else:
        _create_audit(
            uow,
            event_type="template.create",
            target_type="template",
            target_id=template.id,
            payload={"status": template.status, "version_no": template.version_no},
        )
    return template


def update_template(uow, template_id: str, body: dict | None) -> AgentTemplate:
    payload = body or {}
    template = uow.agent_templates().get_by_id(template_id)
    if template is None or template.deleted_at is not None:
        raise LookupError(template_id)

    changed_fields: list[str] = []
    for key, attr in (("name", "name"), ("category_code", "category_code"), ("role_name", "role_name")):
        if key in payload and payload[key] is not None:
            value = str(payload[key]).strip()
            if getattr(template, attr) != value:
                setattr(template, attr, value)
                changed_fields.append(key)

    if "prompt_pack" in payload or "prompt_pack_json" in payload:
        new_json = _json_dumps(payload.get("prompt_pack") or payload.get("prompt_pack_json"), default={})
        if template.prompt_pack_json != new_json:
            template.prompt_pack_json = new_json
            changed_fields.append("prompt_pack")
    if "default_model_ref" in payload or "default_model_json" in payload:
        new_json = _json_dumps(payload.get("default_model_ref") or payload.get("default_model_json"), default={})
        if template.default_model_json != new_json:
            template.default_model_json = new_json
            changed_fields.append("default_model_ref")
    if "default_binding" in payload or "default_binding_json" in payload:
        new_json = _json_dumps(payload.get("default_binding") or payload.get("default_binding_json"), default={})
        if template.default_binding_json != new_json:
            template.default_binding_json = new_json
            changed_fields.append("default_binding")
    if "publish_scope" in payload:
        new_scope = _normalize_publish_scope(payload.get("publish_scope"))
        if template.publish_scope_json != new_scope:
            template.publish_scope_json = new_scope
            changed_fields.append("publish_scope")

    from_status = template.status
    publish_action = (payload.get("publish_state") or payload.get("publish_action") or "").strip()
    if publish_action == "publish" and template.status != "published":
        template.status = "published"
        changed_fields.append("status")
    elif publish_action == "unpublish" and template.status != "retired":
        template.status = "retired"
        changed_fields.append("status")

    if changed_fields:
        template.version_no += 1
        template.updated_by = _SYSTEM_ACTOR_ID
        uow.agent_templates().update(template)
        _create_audit(
            uow,
            event_type=("template.publish" if publish_action == "publish" else "template.unpublish" if publish_action == "unpublish" else "template.update"),
            target_type="template",
            target_id=template.id,
            payload={
                "changed_fields": changed_fields,
                "from_status": from_status,
                "to_status": template.status,
                "version_no": template.version_no,
            },
        )
    return template


def create_solution(uow, body: dict | None) -> IndustrySolution:
    payload = body or {}
    name = (payload.get("name") or "").strip()
    if not name:
        raise ValueError("name is required")

    template_ids = payload.get("template_ids") or []
    _validate_template_ids(uow, template_ids)

    solution = IndustrySolution(
        id=payload.get("solution_id") or f"sol_{uuid.uuid4().hex[:12]}",
        name=name,
        status="draft",
        tags_json=_json_dumps(payload.get("tags"), default=[]),
        default_kb_blueprint_json=_json_dumps(payload.get("default_kb_blueprint") or payload.get("default_kb_blueprint_json"), default={}),
        default_skill_bundle_json=_json_dumps(payload.get("default_skill_bundle") or payload.get("default_skill_bundle_json"), default={}),
        default_collaboration_template_ref=payload.get("default_collaboration_template_ref"),
        publish_scope_json=_normalize_publish_scope(payload.get("publish_scope")),
        planner_prompt=str(payload.get("planner_prompt") or ""),
        subtask_prompt=str(payload.get("subtask_prompt") or ""),
        aggregate_prompt=str(payload.get("aggregate_prompt") or ""),
        created_by=_SYSTEM_ACTOR_ID,
        updated_by=_SYSTEM_ACTOR_ID,
    )
    uow.industry_solutions().create(solution)
    _replace_solution_bindings(uow, solution.id, template_ids)

    publish_action = (payload.get("publish_state") or payload.get("publish_action") or "").strip()
    if publish_action == "publish":
        solution.status = "published"
        uow.industry_solutions().update(solution)
        _create_audit(
            uow,
            event_type="solution.publish",
            target_type="solution",
            target_id=solution.id,
            payload={"from_status": "draft", "to_status": "published", "template_ids": template_ids},
        )
    else:
        _create_audit(
            uow,
            event_type="solution.create",
            target_type="solution",
            target_id=solution.id,
            payload={"status": solution.status, "template_ids": template_ids},
        )
    return solution


def update_solution(uow, solution_id: str, body: dict | None) -> IndustrySolution:
    payload = body or {}
    solution = uow.industry_solutions().get_by_id(solution_id)
    if solution is None or solution.deleted_at is not None:
        raise LookupError(solution_id)

    changed_fields: list[str] = []
    if "name" in payload and payload["name"] is not None:
        value = str(payload["name"]).strip()
        if value and solution.name != value:
            solution.name = value
            changed_fields.append("name")
    if "tags" in payload:
        new_json = _json_dumps(payload.get("tags"), default=[])
        if solution.tags_json != new_json:
            solution.tags_json = new_json
            changed_fields.append("tags")

    if "default_kb_blueprint" in payload or "default_kb_blueprint_json" in payload:
        new_json = _json_dumps(payload.get("default_kb_blueprint") or payload.get("default_kb_blueprint_json"), default={})
        if solution.default_kb_blueprint_json != new_json:
            solution.default_kb_blueprint_json = new_json
            changed_fields.append("default_kb_blueprint")
    if "default_skill_bundle" in payload or "default_skill_bundle_json" in payload:
        new_json = _json_dumps(payload.get("default_skill_bundle") or payload.get("default_skill_bundle_json"), default={})
        if solution.default_skill_bundle_json != new_json:
            solution.default_skill_bundle_json = new_json
            changed_fields.append("default_skill_bundle")
    if "default_collaboration_template_ref" in payload:
        value = payload.get("default_collaboration_template_ref")
        if solution.default_collaboration_template_ref != value:
            solution.default_collaboration_template_ref = value
            changed_fields.append("default_collaboration_template_ref")
    if "publish_scope" in payload:
        new_scope = _normalize_publish_scope(payload.get("publish_scope"))
        if solution.publish_scope_json != new_scope:
            solution.publish_scope_json = new_scope
            changed_fields.append("publish_scope")
    for _prompt_field in ("planner_prompt", "subtask_prompt", "aggregate_prompt"):
        if _prompt_field in payload:
            value = str(payload.get(_prompt_field) or "")
            if getattr(solution, _prompt_field) != value:
                setattr(solution, _prompt_field, value)
                changed_fields.append(_prompt_field)

    if "template_ids" in payload:
        template_ids = payload.get("template_ids") or []
        _validate_template_ids(uow, template_ids)
        _replace_solution_bindings(uow, solution.id, template_ids)
        changed_fields.append("template_ids")

    from_status = solution.status
    publish_action = (payload.get("publish_state") or payload.get("publish_action") or "").strip()
    if publish_action == "publish" and solution.status != "published":
        solution.status = "published"
        changed_fields.append("status")
    elif publish_action == "unpublish" and solution.status != "retired":
        solution.status = "retired"
        changed_fields.append("status")

    if changed_fields:
        solution.updated_by = _SYSTEM_ACTOR_ID
        uow.industry_solutions().update(solution)
        _create_audit(
            uow,
            event_type=("solution.publish" if publish_action == "publish" else "solution.unpublish" if publish_action == "unpublish" else "solution.update"),
            target_type="solution",
            target_id=solution.id,
            payload={
                "changed_fields": changed_fields,
                "from_status": from_status,
                "to_status": solution.status,
                "template_ids": payload.get("template_ids"),
            },
        )
    return solution


def _validate_template_ids(uow, template_ids: list[str]) -> None:
    seen: set[str] = set()
    for template_id in template_ids:
        if template_id in seen:
            continue
        seen.add(template_id)
        template = uow.agent_templates().get_by_id(template_id)
        if template is None or template.deleted_at is not None:
            raise ValueError(f"template_id {template_id} not found")


def _replace_solution_bindings(uow, solution_id: str, template_ids: list[str]) -> None:
    uow.solution_template_bindings().delete_by_solution(solution_id)
    for idx, template_id in enumerate(template_ids, start=1):
        uow.solution_template_bindings().create(
            SolutionTemplateBinding(
                id=f"stb_{uuid.uuid4().hex[:12]}",
                solution_id=solution_id,
                template_id=template_id,
                sequence_no=idx,
                enabled=True,
                created_by=_SYSTEM_ACTOR_ID,
                updated_by=_SYSTEM_ACTOR_ID,
            )
        )
