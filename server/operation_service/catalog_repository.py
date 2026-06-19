"""运营端目录仓储（oper 库的最小骨架，05 F03）。

持有**模板真相态**：专家模板 / 行业方案模板及其生命周期与可见范围（D1 / F03，
"Operator 持模板真相"）。单写者：目录表唯一写端是 Operator（CLAUDE/AGENTS §3.2）。

骨架期用进程内存实现；详设接 PostgreSQL（oper 库），接口形状不变。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from shared.contracts.enums import CatalogStatus, CatalogType
from shared.errors import Conflict, NotFound


@dataclass(frozen=True)
class CatalogEntry:
    """目录项记录（模板真相态）。专家/方案共用一张表，按 catalog_type 区分。"""

    catalog_type: CatalogType
    template_id: str
    version: str
    display_name: str
    status: CatalogStatus = CatalogStatus.DRAFT
    visible_scope: dict | None = None
    payload: dict = field(default_factory=dict)


def _key(catalog_type: CatalogType, template_id: str) -> tuple[str, str]:
    return (catalog_type.value, template_id)


class CatalogRepository:
    """目录项进程内仓储。线程隔离留详设；骨架满足单端测试与流程闭环。"""

    def __init__(self) -> None:
        self._entries: dict[tuple[str, str], CatalogEntry] = {}

    def create(self, entry: CatalogEntry) -> CatalogEntry:
        key = _key(entry.catalog_type, entry.template_id)
        if key in self._entries:
            raise Conflict(f"catalog entry already exists: {entry.template_id}")
        self._entries[key] = entry
        return entry

    def get(self, catalog_type: CatalogType, template_id: str) -> CatalogEntry:
        entry = self._entries.get(_key(catalog_type, template_id))
        if entry is None:
            raise NotFound(f"catalog entry not found: {template_id}")
        return entry

    def update(self, entry: CatalogEntry, **changes) -> CatalogEntry:
        updated = replace(entry, **changes)
        self._entries[_key(updated.catalog_type, updated.template_id)] = updated
        return updated

    def list(
        self,
        *,
        catalog_type: CatalogType | None = None,
        status: CatalogStatus | None = None,
    ) -> list[CatalogEntry]:
        return [
            e
            for e in self._entries.values()
            if (catalog_type is None or e.catalog_type == catalog_type)
            and (status is None or e.status == status)
        ]
