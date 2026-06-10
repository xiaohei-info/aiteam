"""Workbench view service — aggregates workbench home page data."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict
from datetime import date

from ...domain.entities import Conversation, TeamRun
from ...domain.enums import EnterpriseRole, EmployeeStatus
from ...transactions.uow import UnitOfWork
from ...views.assemblers import assemble_workbench, compute_display_state, _parse_tokens_from_json
from ...views.schemas import WorkbenchConversationItem, WorkbenchEmployeeItem, WorkbenchView


class WorkbenchAccessError(ValueError):
    """Raised when a caller role is not allowed to view the enterprise workbench."""


_ALLOWED_WORKBENCH_ROLES = {
    EnterpriseRole.OWNER,
    EnterpriseRole.ENTERPRISE_ADMIN,
    EnterpriseRole.FINANCE_ADMIN,
    EnterpriseRole.MEMBER,
}



def get_workbench_view(
    uow: UnitOfWork,
    enterprise_id: str,
    *,
    role: str = EnterpriseRole.MEMBER,
    user_id: str | None = None,
) -> WorkbenchView:
    """Build the workbench aggregate view for an enterprise."""
    normalized_role = _normalize_role(role)
    if normalized_role not in _ALLOWED_WORKBENCH_ROLES:
        raise WorkbenchAccessError(f"role '{role}' cannot access workbench")

    employees = uow.employees().list_by_enterprise(enterprise_id)
    conversations = uow.conversations().list_by_enterprise(enterprise_id)
    runs = uow.team_runs().list_by_enterprise(enterprise_id)

    today_str = str(date.today())
    today_runs = [r for r in runs if r.created_at[:10] == today_str]
    today_tokens = sum(_parse_tokens_from_json(r.result_summary_json) for r in today_runs)

    tasks_by_run = {run.id: uow.team_tasks().list_by_run(run.id) for run in runs}
    latest_event_by_run = {
        run.id: uow.run_events().get_latest_for_run(run.id)
        for run in runs
    }

    knowledge_counts = _knowledge_counts_by_employee(uow, employees)
    latest_run_by_employee = _latest_run_by_employee(runs)
    latest_run_by_conversation = _latest_run_by_conversation(runs)
    running_task_counts_by_employee = _running_task_counts(tasks_by_run)
    task_digest_by_run = _task_digest_by_run(tasks_by_run)
    conversation_member_counts = _conversation_member_counts(
        uow,
        [conversation.id for conversation in conversations if conversation.type == "group"],
    )
    starred_employee_ids = _starred_employee_ids(uow, enterprise_id, user_id)
    unread_counts = _conversation_unread_counts(uow, enterprise_id, user_id, conversations)

    sorted_conversations = sorted(
        conversations,
        key=lambda conversation: (
            conversation.last_message_at or conversation.updated_at or conversation.created_at,
            conversation.id,
        ),
        reverse=True,
    )

    conversation_items = [
        _build_conversation_item(
            conversation,
            latest_run=latest_run_by_conversation.get(conversation.id),
            latest_event=latest_event_by_run.get((latest_run_by_conversation.get(conversation.id) or TeamRun(id="", enterprise_id="")).id),
            member_count=conversation_member_counts.get(conversation.id, 0),
            task_digest=task_digest_by_run.get((latest_run_by_conversation.get(conversation.id) or TeamRun(id="", enterprise_id="")).id, _empty_task_digest()),
            unread_count=unread_counts.get(conversation.id, 0),
        )
        for conversation in sorted_conversations
    ]
    group_items = [item for item in conversation_items if item.conv_type == "group"]

    conversation_by_employee = {
        conversation.entry_employee_id: conversation
        for conversation in sorted_conversations
        if conversation.entry_employee_id and conversation.type == "private"
    }
    employee_items = [
        _build_employee_item(
            employee,
            conversation=conversation_by_employee.get(employee.id),
            latest_run=latest_run_by_employee.get(employee.id),
            knowledge_base_count=knowledge_counts.get(employee.id, 0),
            running_task_count=running_task_counts_by_employee.get(employee.id, 0),
            unread_count=unread_counts.get(conversation_by_employee.get(employee.id).id, 0) if conversation_by_employee.get(employee.id) is not None else 0,
            is_starred=employee.id in starred_employee_ids,
        )
        for employee in employees
    ]

    task_status_digest = _merge_task_digests(task_digest_by_run.values())
    office_digest = {
        "online_employee_count": sum(1 for item in employee_items if item.status == EmployeeStatus.ACTIVE),
        "running_task_count": task_status_digest["running"],
        "running_run_count": sum(1 for run in runs if run.status == "running"),
        "waiting_run_count": sum(1 for run in runs if run.status == "waiting_human"),
        "busy_employee_count": sum(1 for item in employee_items if item.presence in {"busy", "waiting_reply"}),
    }

    permissions = {
        "role": str(normalized_role),
        "can_view_workbench": True,
        "can_view_admin": normalized_role in {EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN},
        "visible_nav": ["talent", "group", "org", "knowledge", "office"],
    }

    navigation = {
        "talent": {
            "label": "人才市场",
            "target": "/app/marketplace",
            "badge_count": len(uow.agent_templates().list_all()),
        },
        "group": {
            "label": "群聊协作",
            "target": group_items[0].navigation_target if group_items else "/app/workbench",
            "badge_count": len(group_items),
        },
        "org": {
            "label": "我的团队" if permissions["can_view_admin"] is False else "组织视图",
            "target": "/app/org" if permissions["can_view_admin"] else "/app/workbench",
            "badge_count": len(employee_items),
        },
        "knowledge": {
            "label": "知识库",
            "target": "/app/knowledge",
            "badge_count": sum(knowledge_counts.values()),
        },
        "office": {
            "label": "办公室动态",
            "target": "/app/office",
            "badge_count": office_digest["running_task_count"],
        },
    }

    empty_state = None
    if not employee_items:
        empty_state = {
            "code": "NO_EMPLOYEES",
            "title": "你还没有数字员工",
            "message": "先去人才市场招募第一位成员。",
            "cta_label": "前往人才市场",
            "cta_target": "/app/marketplace",
        }

    return assemble_workbench(
        enterprise_id=enterprise_id,
        employees=employees,
        conversations=sorted_conversations,
        today_runs=today_runs,
        today_tokens=today_tokens,
        team_items=employee_items,
        conversation_items=conversation_items,
        group_items=group_items,
        navigation=navigation,
        task_status_digest=task_status_digest,
        office_digest=office_digest,
        empty_state=empty_state,
        permissions=permissions,
    )



def serialize_workbench_view(view: WorkbenchView, *, enterprise_name: str, plan_tier: str = "mvp") -> dict:
    payload = asdict(view)
    payload["employees"] = [_serialize_workbench_employee_item(item) for item in view.employees]
    payload["my_team"] = {
        **(payload.get("my_team") or {}),
        "items": [_serialize_workbench_employee_item(item) for item in view.my_team.get("items", [])],
    }
    payload["groups"] = [_serialize_workbench_group_item(item) for item in view.groups]
    payload["enterprise"] = {
        "enterprise_id": view.enterprise_id,
        "name": enterprise_name,
        "plan_tier": plan_tier,
    }
    return payload



def _normalize_role(role: str) -> EnterpriseRole | str:
    try:
        return EnterpriseRole(role)
    except ValueError:
        return role



def _latest_run_by_employee(runs: list[TeamRun]) -> dict[str, TeamRun]:
    latest: dict[str, TeamRun] = {}
    for run in runs:
        if run.entry_employee_id and run.entry_employee_id not in latest:
            latest[run.entry_employee_id] = run
    return latest



def _latest_run_by_conversation(runs: list[TeamRun]) -> dict[str, TeamRun]:
    latest: dict[str, TeamRun] = {}
    for run in runs:
        if run.conversation_id and run.conversation_id not in latest:
            latest[run.conversation_id] = run
    return latest



def _knowledge_counts_by_employee(uow: UnitOfWork, employees) -> dict[str, int]:
    counts: dict[str, int] = {}
    for employee in employees:
        bindings = uow.employee_knowledge_bindings().list_by_employee(employee.id)
        counts[employee.id] = sum(1 for binding in bindings if binding.enabled)
    return counts



def _running_task_counts(tasks_by_run: dict[str, list]) -> dict[str, int]:
    counts: Counter = Counter()
    for tasks in tasks_by_run.values():
        for task in tasks:
            if task.assignee_employee_id and task.status == "running":
                counts[task.assignee_employee_id] += 1
    return dict(counts)



def _task_digest_by_run(tasks_by_run: dict[str, list]) -> dict[str, dict]:
    digests: dict[str, dict] = {}
    for run_id, tasks in tasks_by_run.items():
        digest = _empty_task_digest()
        for task in tasks:
            digest["total"] += 1
            digest[task.status] = digest.get(task.status, 0) + 1
        digests[run_id] = digest
    return digests



def _merge_task_digests(digests) -> dict:
    merged = _empty_task_digest()
    for digest in digests:
        for key, value in digest.items():
            merged[key] = merged.get(key, 0) + value
    return merged



def _empty_task_digest() -> dict:
    return {
        "total": 0,
        "planned": 0,
        "queued": 0,
        "running": 0,
        "waiting_deps": 0,
        "succeeded": 0,
        "failed": 0,
        "cancelled": 0,
    }



def _conversation_member_counts(uow: UnitOfWork, conversation_ids: list[str]) -> dict[str, int]:
    if not conversation_ids:
        return {}
    cur = uow.cur
    cur.execute(
        "SELECT conversation_id, COUNT(*) "
        "FROM conversation_member "
        "WHERE conversation_id = ANY(%s) AND status = 'active' "
        "GROUP BY conversation_id",
        (conversation_ids,),
    )
    return {conversation_id: count for conversation_id, count in cur.fetchall()}


def _starred_employee_ids(uow: UnitOfWork, enterprise_id: str, user_id: str | None) -> set[str]:
    if not user_id:
        return set()
    return uow.workbench_employee_preferences().list_starred_employee_ids(enterprise_id, user_id)


def _conversation_unread_counts(
    uow: UnitOfWork,
    enterprise_id: str,
    user_id: str | None,
    conversations: list[Conversation],
) -> dict[str, int]:
    if not user_id:
        return {}
    state_map = uow.conversation_read_states().list_by_user(
        enterprise_id,
        user_id,
        [conversation.id for conversation in conversations],
    )
    unread_counts: dict[str, int] = {}
    for conversation in conversations:
        last_message_at = conversation.last_message_at or conversation.updated_at or conversation.created_at
        if not last_message_at or not conversation.last_message_preview:
            unread_counts[conversation.id] = 0
            continue
        state = state_map.get(conversation.id)
        if state is None or not state.last_read_at:
            unread_counts[conversation.id] = 1
            continue
        unread_counts[conversation.id] = 1 if last_message_at > state.last_read_at else 0
    return unread_counts



def _build_employee_item(employee, *, conversation: Conversation | None, latest_run: TeamRun | None,
                         knowledge_base_count: int, running_task_count: int,
                         unread_count: int, is_starred: bool) -> WorkbenchEmployeeItem:
    presence = "idle"
    latest_run_status = latest_run.status if latest_run else None
    if employee.status != EmployeeStatus.ACTIVE:
        presence = "offline"
    elif latest_run_status == "running":
        presence = "busy"
    elif latest_run_status == "waiting_human":
        presence = "waiting_reply"

    conversation_id = conversation.id if conversation else None
    navigation_target = f"/app/chat/{conversation_id}" if conversation_id else "/app/workbench"
    last_active_at = ""
    if conversation is not None:
        last_active_at = conversation.last_message_at or conversation.updated_at or conversation.created_at
    if not last_active_at and latest_run is not None:
        last_active_at = latest_run.finished_at or latest_run.started_at or latest_run.updated_at or latest_run.created_at
    if not last_active_at:
        last_active_at = employee.updated_at or employee.created_at or ""
    return WorkbenchEmployeeItem(
        employee_id=employee.id,
        display_name=employee.display_name,
        role_name=employee.role_name,
        status=employee.status,
        presence=presence,
        avatar_url=employee.avatar_url,
        last_message_preview=(conversation.last_message_preview or "") if conversation else "",
        unread_count=unread_count,
        pinned=is_starred,
        is_starred=is_starred,
        conversation_id=conversation_id,
        last_active_at=last_active_at,
        latest_run_status=latest_run_status,
        running_task_count=running_task_count,
        knowledge_base_count=knowledge_base_count,
        navigation_target=navigation_target,
    )



def _build_conversation_item(conversation: Conversation, *, latest_run: TeamRun | None, latest_event,
                             member_count: int, task_digest: dict, unread_count: int) -> WorkbenchConversationItem:
    latest_run_status = latest_run.status if latest_run else None
    has_delta = latest_event is not None and latest_event.event_type == "message_delta"
    target_prefix = "/app/group" if conversation.type == "group" else "/app/chat"
    return WorkbenchConversationItem(
        id=conversation.id,
        title=conversation.title,
        conv_type=conversation.type,
        status=conversation.status,
        display_state=compute_display_state(conversation.status, latest_run_status, has_recent_delta=has_delta),
        last_preview=conversation.last_message_preview or "",
        updated_at=conversation.updated_at or conversation.last_message_at or conversation.created_at,
        navigation_target=f"{target_prefix}/{conversation.id}",
        latest_run_status=latest_run_status,
        unread_count=unread_count,
        member_count=member_count,
        task_status_digest=task_digest,
    )


def _serialize_workbench_employee_item(item: WorkbenchEmployeeItem | dict) -> dict:
    payload = dict(item) if isinstance(item, dict) else asdict(item)
    payload["is_starred"] = bool(payload.get("is_starred", payload.get("pinned", False)))
    payload["last_active_at"] = str(payload.get("last_active_at") or "")
    payload["unread_count"] = int(payload.get("unread_count") or 0)
    return payload


def _serialize_workbench_group_item(item: WorkbenchConversationItem | dict) -> dict:
    payload = dict(item) if isinstance(item, dict) else asdict(item)
    digest = payload.get("task_status_digest") or {}
    return {
        "conversation_id": payload.get("id"),
        "title": payload.get("title", ""),
        "member_count": int(payload.get("member_count") or 0),
        "running_count": int(digest.get("running") or 0),
        "last_message_preview": payload.get("last_preview", ""),
        "unread_count": int(payload.get("unread_count") or 0),
        "navigation_target": payload.get("navigation_target", ""),
    }
