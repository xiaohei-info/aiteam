"""MemoryItem + MemoryReviewDecision repositories."""
from __future__ import annotations

import json
from typing import Iterable, Optional

from ..domain.entities import MemoryItem, MemoryReviewDecision


class MemoryReviewDecisionRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, item: MemoryReviewDecision) -> MemoryReviewDecision:
        self._cur.execute(
            "INSERT INTO memory_review_decision (id, enterprise_id, memory_item_id, reviewer_user_id, decision, comment, corrected_content, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                item.id,
                item.enterprise_id,
                item.memory_item_id,
                item.reviewer_user_id,
                item.decision,
                item.comment,
                item.corrected_content,
                item.created_by or None,
                item.updated_by or None,
            ),
        )
        return item

    def get_latest_by_memory_id(self, memory_item_id: str) -> Optional[MemoryReviewDecision]:
        self._cur.execute(
            "SELECT id, enterprise_id, memory_item_id, reviewer_user_id, decision, comment, corrected_content, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM memory_review_decision WHERE memory_item_id = %s AND deleted_at IS NULL "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (memory_item_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return _row_to_review_decision(row)

    def latest_by_memory_ids(self, memory_ids: Iterable[str]) -> dict[str, MemoryReviewDecision]:
        result: dict[str, MemoryReviewDecision] = {}
        for memory_id in memory_ids:
            decision = self.get_latest_by_memory_id(memory_id)
            if decision is not None:
                result[memory_id] = decision
        return result


class MemoryItemRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, item: MemoryItem) -> MemoryItem:
        self._cur.execute(
            "INSERT INTO memory_item (id, enterprise_id, employee_id, content, category, importance, source_type, tags_json, visibility_scope, runtime_ref_json, last_used_at, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb, %s, %s, %s)",
            (
                item.id,
                item.enterprise_id,
                item.employee_id,
                item.content,
                item.category,
                item.importance,
                item.source_type,
                item.tags_json,
                item.visibility_scope,
                item.runtime_ref_json,
                item.last_used_at or None,
                item.created_by or None,
                item.updated_by or None,
            ),
        )
        return item

    def get_by_id(self, memory_id: str, *, include_deleted: bool = False) -> Optional[MemoryItem]:
        sql = (
            "SELECT id, enterprise_id, employee_id, content, category, importance, source_type, tags_json, visibility_scope, runtime_ref_json, last_used_at, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM memory_item WHERE id = %s"
        )
        params: list[object] = [memory_id]
        if not include_deleted:
            sql += " AND deleted_at IS NULL"
        self._cur.execute(sql, params)
        row = self._cur.fetchone()
        if row is None:
            return None
        return _row_to_memory_item(row)

    def list_by_enterprise(
        self,
        enterprise_id: str,
        *,
        employee_id: str | None = None,
        search_query: str | None = None,
        tag: str | None = None,
        category: str | None = None,
        source_type: str | None = None,
        review_status: str | None = None,
        visibility_scope: str | None = None,
        limit: int = 100,
        offset: int = 0,
        sort_by: str = "importance",
        sort_order: str = "desc",
    ) -> list[MemoryItem]:
        sql = (
            "SELECT id, enterprise_id, employee_id, content, category, importance, source_type, tags_json, visibility_scope, runtime_ref_json, last_used_at, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM memory_item WHERE enterprise_id = %s AND deleted_at IS NULL"
        )
        params: list[object] = [enterprise_id]
        if employee_id:
            sql += " AND employee_id = %s"
            params.append(employee_id)
        if search_query:
            sql += " AND content ILIKE %s"
            params.append(f"%{search_query}%")
        if tag:
            sql += " AND tags_json ? %s"
            params.append(tag)
        if category:
            sql += " AND category = %s"
            params.append(category)
        if source_type:
            sql += " AND source_type = %s"
            params.append(source_type)
        if visibility_scope:
            sql += " AND visibility_scope = %s"
            params.append(visibility_scope)

        order_map = {
            "importance": "importance",
            "updated_at": "updated_at",
            "created_at": "created_at",
        }
        order_column = order_map.get(sort_by, "importance")
        order_dir = "ASC" if str(sort_order).lower() == "asc" else "DESC"
        sql += f" ORDER BY {order_column} {order_dir}, updated_at DESC LIMIT %s OFFSET %s"
        params.extend([limit, max(0, offset)])
        self._cur.execute(sql, params)
        items = [_row_to_memory_item(row) for row in self._cur.fetchall()]
        return self._filter_by_review_status(items, review_status=review_status)

    def count_by_enterprise(
        self,
        enterprise_id: str,
        *,
        employee_id: str | None = None,
        search_query: str | None = None,
        tag: str | None = None,
        category: str | None = None,
        source_type: str | None = None,
        review_status: str | None = None,
        visibility_scope: str | None = None,
    ) -> int:
        items = self.list_by_enterprise(
            enterprise_id,
            employee_id=employee_id,
            search_query=search_query,
            tag=tag,
            category=category,
            source_type=source_type,
            review_status=review_status,
            visibility_scope=visibility_scope,
            limit=1000000,
            offset=0,
        )
        return len(items)

    def update(self, item: MemoryItem) -> MemoryItem:
        self._cur.execute(
            "UPDATE memory_item SET content=%s, category=%s, importance=%s, source_type=%s, tags_json=%s::jsonb, visibility_scope=%s, runtime_ref_json=%s::jsonb, last_used_at=%s, updated_at=now(), updated_by=%s "
            "WHERE id = %s AND deleted_at IS NULL",
            (
                item.content,
                item.category,
                item.importance,
                item.source_type,
                item.tags_json,
                item.visibility_scope,
                item.runtime_ref_json,
                item.last_used_at or None,
                item.updated_by or None,
                item.id,
            ),
        )
        return item

    def delete(self, memory_id: str) -> None:
        self._cur.execute(
            "UPDATE memory_item SET deleted_at=now(), updated_at=now() WHERE id = %s AND deleted_at IS NULL",
            (memory_id,),
        )

    def bulk_delete(self, memory_ids: Iterable[str], *, enterprise_id: str, employee_id: str | None = None) -> None:
        memory_ids = list(memory_ids)
        if not memory_ids:
            return
        sql = (
            "UPDATE memory_item SET deleted_at=now(), updated_at=now() "
            "WHERE enterprise_id = %s AND id = ANY(%s) AND deleted_at IS NULL"
        )
        params: list[object] = [enterprise_id, memory_ids]
        if employee_id:
            sql += " AND employee_id = %s"
            params.append(employee_id)
        self._cur.execute(sql, params)

    def _filter_by_review_status(self, items: list[MemoryItem], *, review_status: str | None) -> list[MemoryItem]:
        review_repo = MemoryReviewDecisionRepo(self._cur)
        latest_reviews = review_repo.latest_by_memory_ids([item.id for item in items])

        filtered: list[MemoryItem] = []
        for item in items:
            review = latest_reviews.get(item.id)
            status = review.decision if review is not None else ("pending" if item.source_type == "extraction" else "not_required")
            if review_status:
                if status != review_status:
                    continue
            elif status == "rejected":
                continue
            filtered.append(item)
        return filtered


def _row_to_memory_item(row) -> MemoryItem:
    return MemoryItem(
        id=row[0],
        enterprise_id=row[1],
        employee_id=row[2],
        content=row[3],
        category=row[4],
        importance=row[5],
        source_type=row[6],
        tags_json=json.dumps(row[7], ensure_ascii=False) if row[7] is not None and not isinstance(row[7], str) else (row[7] or "[]"),
        visibility_scope=row[8],
        runtime_ref_json=json.dumps(row[9], ensure_ascii=False) if row[9] is not None and not isinstance(row[9], str) else (row[9] or "{}"),
        last_used_at=str(row[10]) if row[10] else None,
        created_at=str(row[11]),
        updated_at=str(row[12]),
        created_by=row[13] or "",
        updated_by=row[14] or "",
        deleted_at=str(row[15]) if row[15] else None,
    )


def _row_to_review_decision(row) -> MemoryReviewDecision:
    return MemoryReviewDecision(
        id=row[0],
        enterprise_id=row[1],
        memory_item_id=row[2],
        reviewer_user_id=row[3],
        decision=row[4],
        comment=row[5],
        corrected_content=row[6],
        created_at=str(row[7]),
        updated_at=str(row[8]) if row[8] else "",
        created_by=row[9] or "",
        updated_by=row[10] or "",
        deleted_at=str(row[11]) if row[11] else None,
    )
