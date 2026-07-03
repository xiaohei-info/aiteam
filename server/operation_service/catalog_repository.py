"""运营端目录仓储（oper 库的最小骨架，05 F03）。

持有**模板真相态**：专家模板 / 行业方案模板及其生命周期与可见范围（D1 / F03，
"Operator 持模板真相"）。单写者：目录表唯一写端是 Operator（CLAUDE/AGENTS §3.2）。

骨架期用进程内存实现；详设接 PostgreSQL（oper 库），接口形状不变。
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from shared.contracts.enums import CatalogStatus, CatalogType
from abc import ABC, abstractmethod
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


class CatalogRepositoryBase(ABC):
    """Common shape for the catalog template repository."""
    @abstractmethod
    def create(self, entry): ...
    @abstractmethod
    def get(self, catalog_type, template_id): ...
    @abstractmethod
    def update(self, entry, **changes): ...
    @abstractmethod
    def list(self, *, catalog_type=None, status=None): ...


class CatalogRepository(CatalogRepositoryBase):
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


class PgCatalogRepository(CatalogRepositoryBase):
    """Postgres-backed catalog template repository (oper library)."""

    def __init__(self, dsn):
        self._dsn = dsn

    @staticmethod
    def _row_to_entry(row):
        return CatalogEntry(
            catalog_type=CatalogType(row[0]), template_id=row[1], version=row[2],
            display_name=row[3], status=CatalogStatus(row[4]),
            visible_scope=row[5], payload=row[6],
        )

    def _exists(self, catalog_type, template_id):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM catalog_template WHERE catalog_type = %s AND template_id = %s",
                    (catalog_type.value, template_id),
                )
                return cur.fetchone() is not None

    def create(self, entry):
        import psycopg
        if self._exists(entry.catalog_type, entry.template_id):
            raise Conflict(f"catalog entry already exists: {entry.template_id}")
        with psycopg.connect(self._dsn, autocommit=False) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO catalog_template (catalog_type, template_id, version, display_name, status, visible_scope, payload) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (entry.catalog_type.value, entry.template_id, entry.version,
                     entry.display_name, entry.status.value, entry.visible_scope, entry.payload),
                )
            conn.commit()
        return entry

    def get(self, catalog_type, template_id):
        import psycopg
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT catalog_type, template_id, version, display_name, status, visible_scope, payload "
                    "FROM catalog_template WHERE catalog_type = %s AND template_id = %s",
                    (catalog_type.value, template_id),
                )
                row = cur.fetchone()
        if row is None:
            raise NotFound(f"catalog entry not found: {template_id}")
        return self._row_to_entry(row)

    def update(self, entry, **changes):
        import psycopg
        updated = replace(entry, **changes)
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE catalog_template SET version = %s, display_name = %s, status = %s, "
                    "visible_scope = %s, payload = %s, updated_at = now() "
                    "WHERE catalog_type = %s AND template_id = %s",
                    (updated.version, updated.display_name, updated.status.value,
                     updated.visible_scope, updated.payload,
                     updated.catalog_type.value, updated.template_id),
                )
        return updated

    def list(self, *, catalog_type=None, status=None):
        import psycopg
        where, args = [], []
        if catalog_type is not None:
            where.append("catalog_type = %s"); args.append(catalog_type.value)
        if status is not None:
            where.append("status = %s"); args.append(status.value)
        sql = "SELECT catalog_type, template_id, version, display_name, status, visible_scope, payload FROM catalog_template"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY template_id"
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, args); rows = cur.fetchall()
        return [self._row_to_entry(r) for r in rows]
