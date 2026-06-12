"""Orchestration prompt templates — defaults + enterprise-configured overrides.

The planner/subtask/aggregate prompts used by ``orchestration_executor`` were
previously hardcoded f-strings. They now live here as named default templates
with ``{placeholder}`` slots, and an enterprise may override them via the
``collaboration_template`` table (admin UI). ``resolve_templates`` reads the
enterprise's default row and falls back to these defaults field-by-field, so a
partially-filled override still works and an absent table/row is harmless.

Placeholders:
  planner   : {roster} {message_text} {max_subtasks}
  subtask   : {message_text} {task_title} {task_desc} {dep_block}
  aggregate : {message_text} {subtask_results}
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

DEFAULT_PLANNER_PROMPT = (
    "你是本次群聊协作的主持人, 请把任务拆解为子任务并分配给可用成员。\n\n"
    "可用成员（assignee 必须使用 employee_id）:\n{roster}\n\n"
    "任务: {message_text}\n\n"
    "要求: 2 到 {max_subtasks} 个子任务; depends_on 填依赖的子任务序号(从0开始), 无依赖填 []。\n"
    "不要使用任何工具, 立即基于任务本身规划。"
    "只输出 JSON, 不要任何其他文字, 格式:\n"
    '{{"subtasks": [{{"title": "...", "description": "...", '
    '"assignee": "<employee_id>", "depends_on": []}}]}}'
)

DEFAULT_SUBTASK_PROMPT = (
    "[群聊协作任务]\n"
    "原始任务: {message_text}\n\n"
    "你负责的子任务: {task_title}{task_desc}\n\n"
    "{dep_block}"
    "请直接给出你这个子任务的成果, 不要复述任务本身。"
    "优先基于你已有的专业知识快速完成; 如需查证可少量使用工具, 但不要进行大范围联网检索, "
    "在数分钟内给出结构清晰的结果即可。"
)

DEFAULT_AGGREGATE_PROMPT = (
    "你是本次群聊协作的主持人。以下是各成员子任务的执行结果, "
    "请汇总为面向用户的最终交付, 直接输出结果本身。\n\n"
    "原始任务: {message_text}\n\n"
    "子任务结果:\n{subtask_results}"
)


def resolve_templates(conn, enterprise_id: str) -> dict:
    """Return {planner, subtask, aggregate} prompt templates for an enterprise.

    Reads the enterprise's default collaboration_template row; any empty field
    falls back to the built-in default. Never raises — on any error returns all
    defaults, preserving the legacy hardcoded behavior.
    """
    templates = {
        "planner": DEFAULT_PLANNER_PROMPT,
        "subtask": DEFAULT_SUBTASK_PROMPT,
        "aggregate": DEFAULT_AGGREGATE_PROMPT,
    }
    if not enterprise_id:
        return templates
    try:
        from team_panel.transactions.uow import UnitOfWork
        with UnitOfWork(conn) as uow:
            row = uow.collaboration_templates().get_default(enterprise_id)
        if row is not None:
            if (row.planner_prompt or "").strip():
                templates["planner"] = row.planner_prompt
            if (row.subtask_prompt or "").strip():
                templates["subtask"] = row.subtask_prompt
            if (row.aggregate_prompt or "").strip():
                templates["aggregate"] = row.aggregate_prompt
    except Exception:  # noqa: BLE001 — config read must never break execution
        logger.exception("[orch-tmpl] resolve failed; using defaults")
    return templates


def render(template: str, **kwargs) -> str:
    """Render a template with placeholders; tolerant of unknown/missing keys.

    A misconfigured template (stray brace or unknown placeholder) degrades to a
    best-effort substitution rather than crashing the orchestration run.
    """
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError, ValueError):
        out = template
        for key, value in kwargs.items():
            out = out.replace("{" + key + "}", str(value))
        return out
