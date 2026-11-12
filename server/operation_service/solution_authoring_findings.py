"""行业文档生成：敏感项与草稿正文的对齐规则（纯函数，无 I/O，可在草稿行锁内调用）。

两类发现项：
- 正文项（`field_path` 非空）：这段内容原样出现在会发布的正文里。可 redact / remove / accept_public；
  正文被改掉后自动记为 removed，被改回来则重新打开。
- 提示项（`field_path` 为空）：内容不在正文里（Agent 对资料的提醒、未识别的图片）。只能 acknowledge。
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from shared.errors import Conflict
from shared.solution_authoring.schemas import AgentFinding, SourceChunk
from shared.solution_authoring.sensitive_scan import fields_containing, mask, scan_solution

from .solution_authoring_repository import FindingRow

IMAGE_UNRECOGNIZED = "image_unrecognized"
_REOPENED = {"status": "open", "resolved_by": None, "resolved_at": None}


def _rule_findings(package: dict[str, Any], known: set[str], draft_id: str, now: datetime) -> list[FindingRow]:
    rows: list[FindingRow] = []
    for match in scan_solution(package):
        if match.excerpt in known:
            continue
        known.add(match.excerpt)
        rows.append(FindingRow(
            finding_id=str(uuid.uuid4()), draft_id=draft_id, kind=match.kind, origin="rule", created_at=now,
            field_path=match.field_path, excerpt=match.excerpt, masked=match.masked,
        ))
    return rows


def initial_findings(
    package: dict[str, Any], agent_findings: Sequence[AgentFinding], chunks: Mapping[str, SourceChunk],
    *, draft_id: str, now: datetime,
) -> list[FindingRow]:
    """一次生成成功后的全部发现项：规则扫描命中 + Agent 标注（同一段内容只记一条）。"""
    known: set[str] = set()
    rows = _rule_findings(package, known, draft_id, now)
    for item in agent_findings:
        if item.excerpt in known:
            continue
        known.add(item.excerpt)
        present = fields_containing(package, item.excerpt)
        chunk = chunks.get(item.chunk_id)
        rows.append(FindingRow(
            finding_id=str(uuid.uuid4()), draft_id=draft_id, kind=item.kind, origin="agent", created_at=now,
            field_path=present[0] if present else "", excerpt=item.excerpt, masked=mask(item.excerpt),
            chunk_id=item.chunk_id if chunk else "", locator=f"{chunk.source_name} · {chunk.locator}" if chunk else "",
            note=item.note,
        ))
    return rows


def reconcile_findings(
    package: dict[str, Any], findings: Sequence[FindingRow], *, draft_id: str, actor_id: str, now: datetime,
) -> tuple[dict[str, dict[str, Any]], list[FindingRow]]:
    """正文变更后重扫：返回（已有发现项的更新，新增的发现项）。"""
    updates: dict[str, dict[str, Any]] = {}
    known: set[str] = set()
    for row in findings:
        if not row.field_path:
            continue
        known.add(row.excerpt)
        present = fields_containing(package, row.excerpt)
        if present:
            changes: dict[str, Any] = {}
            if row.field_path not in present:
                changes["field_path"] = present[0]
            if row.status in ("redacted", "removed"):
                changes.update(_REOPENED)
            if changes:
                updates[row.finding_id] = changes
        elif row.status == "open":
            updates[row.finding_id] = {"status": "removed", "resolved_by": actor_id, "resolved_at": now}
    return updates, _rule_findings(package, known, draft_id, now)


def assert_no_unresolved(package: dict[str, Any], findings: Sequence[FindingRow]) -> None:
    """提交审核 / 通过 / 发布前的闸门：没有待处理项，且正文里每个规则命中都已被确认可公开。"""
    if any(row.status == "open" for row in findings):
        raise Conflict("resolve every open finding before continuing")
    accepted = {row.excerpt for row in findings if row.status == "accepted_public"}
    if any(match.excerpt not in accepted for match in scan_solution(package)):
        raise Conflict("the draft content contains sensitive items that have not been reviewed; edit the draft to re-scan it")
