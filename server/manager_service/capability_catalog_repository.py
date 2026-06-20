"""技能/连接器/记忆策略 目录租户作用域数据访问（M4，04 §6.6，D17/D22）。

铁律：与 EmployeeConfigRepository 一致——所有方法以 TenantContext 为隔离边界，tenant_id 只从
ctx 读取，SQL 不接受调用方手写 tenant 过滤字符串（D22）。RLS 强制跨租户隔离（04 §6.1.1）。

红线（issue #38）：
- ① 仅管理面真相，实际执行在用户端本地（本卡不实现执行）。
- ② 不绕 tenant；③ 不做连接器对外调用/技能执行（本卡只 CRUD 管理面真相）。

三表（skill_catalog / connector_catalog / memory_policy_catalog）分别写显式 SQL（列结构差异大，
显式 SELECT 比动态拼接更清晰、更可控——好品味：消除动态列拼接的特殊情况）。每表一个行模型 +
一套 CRUD；列表/删除按 resource_kind 路由到对应表。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

ResourceKind = Literal["skill", "connector", "memory_policy"]

_TABLE = {
    "skill": "skill_catalog",
    "connector": "connector_catalog",
    "memory_policy": "memory_policy_catalog",
}
_ID_COL = {"skill": "skill_id", "connector": "connector_id", "memory_policy": "policy_id"}


@dataclass(frozen=True)
class SkillCatalogRow:
    """技能目录行（runtime 无关，D16）。resource_id 即 skill_id。"""

    catalog_id: str
    skill_id: str
    display_name: str
    version: str
    install_policy: str
    binding_policy: str
    visibility: str
    config: dict
    catalog_version: int


@dataclass(frozen=True)
class ConnectorCatalogRow:
    """连接器目录行（runtime 无关，D16）。resource_id 即 connector_id。

    grant_scope 是凭据授权范围元数据（谁能用）；凭据本体归 M5（D18）。
    """

    catalog_id: str
    connector_id: str
    display_name: str
    visibility: str
    grant_scope: str
    config: dict
    catalog_version: int


@dataclass(frozen=True)
class MemoryPolicyCatalogRow:
    """记忆策略目录行（runtime 无关，D17）。resource_id 即 policy_id。

    seed_memories 是策略级种子；记忆数据本体（mem0 运行时记忆）在用户端 local_memory_store。
    """

    catalog_id: str
    policy_id: str
    display_name: str
    policy: dict
    seed_memories: list[Any]
    retention_days: int | None
    visibility: str
    config: dict
    catalog_version: int


_SKILL_COLS = "id, skill_id, display_name, version, install_policy, binding_policy, visibility, config, catalog_version"


def _row_to_skill(row: Any) -> SkillCatalogRow:
    return SkillCatalogRow(
        catalog_id=str(row[0]), skill_id=row[1], display_name=row[2], version=row[3],
        install_policy=row[4], binding_policy=row[5], visibility=row[6], config=row[7] or {},
        catalog_version=row[8],
    )


_CONNECTOR_COLS = "id, connector_id, display_name, visibility, grant_scope, config, catalog_version"


def _row_to_connector(row: Any) -> ConnectorCatalogRow:
    return ConnectorCatalogRow(
        catalog_id=str(row[0]), connector_id=row[1], display_name=row[2], visibility=row[3],
        grant_scope=row[4], config=row[5] or {}, catalog_version=row[6],
    )


_MEMORY_COLS = (
    "id, policy_id, display_name, policy, seed_memories, retention_days, visibility, config, catalog_version"
)


def _row_to_memory(row: Any) -> MemoryPolicyCatalogRow:
    return MemoryPolicyCatalogRow(
        catalog_id=str(row[0]), policy_id=row[1], display_name=row[2], policy=row[3] or {},
        seed_memories=list(row[4] or []), retention_days=row[5], visibility=row[6], config=row[7] or {},
        catalog_version=row[8],
    )


class CapabilityCatalogRepository:
    """能力目录的租户内读写（skill/connector/memory_policy 三表）。

    tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）；runtime 中立（D16/D17）。
    """

    def __init__(self, router: PgTenantRouter):
        self._router = router

    # ---- skill ----

    def create_skill(self, ctx: TenantContext, *, skill_id: str, display_name: str, version: str,
                     install_policy: str, binding_policy: str, visibility: str, config: dict) -> SkillCatalogRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO skill_catalog "
                "(tenant_id, skill_id, display_name, version, install_policy, binding_policy, visibility, config) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING " + _SKILL_COLS,
                (ctx.tenant_id, skill_id, display_name, version, install_policy, binding_policy, visibility,
                 json.dumps(config)),
            ).fetchone()
        return _row_to_skill(row)

    def update_skill(self, ctx: TenantContext, *, catalog_id: str, display_name: str, version: str,
                     install_policy: str, binding_policy: str, visibility: str, config: dict) -> SkillCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE skill_catalog SET display_name = %s, version = %s, install_policy = %s, "
                "binding_policy = %s, visibility = %s, config = %s WHERE id = %s RETURNING " + _SKILL_COLS,
                (display_name, version, install_policy, binding_policy, visibility, json.dumps(config), catalog_id),
            ).fetchone()
        return _row_to_skill(row) if row is not None else None

    def get_skill(self, ctx: TenantContext, *, catalog_id: str) -> SkillCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute("SELECT " + _SKILL_COLS + " FROM skill_catalog WHERE id = %s", (catalog_id,)).fetchone()
        return _row_to_skill(row) if row is not None else None

    def get_skill_by_id(self, ctx: TenantContext, *, skill_id: str) -> SkillCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _SKILL_COLS + " FROM skill_catalog WHERE skill_id = %s", (skill_id,),
            ).fetchone()
        return _row_to_skill(row) if row is not None else None

    def list_skills(self, ctx: TenantContext) -> list[SkillCatalogRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _SKILL_COLS + " FROM skill_catalog ORDER BY created_at",
            ).fetchall()
        return [_row_to_skill(r) for r in rows]

    # ---- connector ----

    def create_connector(self, ctx: TenantContext, *, connector_id: str, display_name: str, visibility: str,
                         grant_scope: str, config: dict) -> ConnectorCatalogRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO connector_catalog "
                "(tenant_id, connector_id, display_name, visibility, grant_scope, config) "
                "VALUES (%s, %s, %s, %s, %s, %s) RETURNING " + _CONNECTOR_COLS,
                (ctx.tenant_id, connector_id, display_name, visibility, grant_scope, json.dumps(config)),
            ).fetchone()
        return _row_to_connector(row)

    def update_connector(self, ctx: TenantContext, *, catalog_id: str, display_name: str, visibility: str,
                         grant_scope: str, config: dict) -> ConnectorCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE connector_catalog SET display_name = %s, visibility = %s, grant_scope = %s, "
                "config = %s WHERE id = %s RETURNING " + _CONNECTOR_COLS,
                (display_name, visibility, grant_scope, json.dumps(config), catalog_id),
            ).fetchone()
        return _row_to_connector(row) if row is not None else None

    def get_connector(self, ctx: TenantContext, *, catalog_id: str) -> ConnectorCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _CONNECTOR_COLS + " FROM connector_catalog WHERE id = %s", (catalog_id,),
            ).fetchone()
        return _row_to_connector(row) if row is not None else None

    def get_connector_by_id(self, ctx: TenantContext, *, connector_id: str) -> ConnectorCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _CONNECTOR_COLS + " FROM connector_catalog WHERE connector_id = %s", (connector_id,),
            ).fetchone()
        return _row_to_connector(row) if row is not None else None

    def list_connectors(self, ctx: TenantContext) -> list[ConnectorCatalogRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _CONNECTOR_COLS + " FROM connector_catalog ORDER BY created_at",
            ).fetchall()
        return [_row_to_connector(r) for r in rows]

    # ---- memory_policy ----

    def create_memory_policy(self, ctx: TenantContext, *, policy_id: str, display_name: str, policy: dict,
                             seed_memories: list[Any], retention_days: int | None, visibility: str,
                             config: dict) -> MemoryPolicyCatalogRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO memory_policy_catalog "
                "(tenant_id, policy_id, display_name, policy, seed_memories, retention_days, visibility, config) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING " + _MEMORY_COLS,
                (ctx.tenant_id, policy_id, display_name, json.dumps(policy), json.dumps(seed_memories),
                 retention_days, visibility, json.dumps(config)),
            ).fetchone()
        return _row_to_memory(row)

    def update_memory_policy(self, ctx: TenantContext, *, catalog_id: str, display_name: str, policy: dict,
                             seed_memories: list[Any], retention_days: int | None, visibility: str,
                             config: dict) -> MemoryPolicyCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "UPDATE memory_policy_catalog SET display_name = %s, policy = %s, seed_memories = %s, "
                "retention_days = %s, visibility = %s, config = %s WHERE id = %s RETURNING " + _MEMORY_COLS,
                (display_name, json.dumps(policy), json.dumps(seed_memories), retention_days, visibility,
                 json.dumps(config), catalog_id),
            ).fetchone()
        return _row_to_memory(row) if row is not None else None

    def get_memory_policy(self, ctx: TenantContext, *, catalog_id: str) -> MemoryPolicyCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _MEMORY_COLS + " FROM memory_policy_catalog WHERE id = %s", (catalog_id,),
            ).fetchone()
        return _row_to_memory(row) if row is not None else None

    def get_memory_policy_by_id(self, ctx: TenantContext, *, policy_id: str) -> MemoryPolicyCatalogRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _MEMORY_COLS + " FROM memory_policy_catalog WHERE policy_id = %s", (policy_id,),
            ).fetchone()
        return _row_to_memory(row) if row is not None else None

    def list_memory_policies(self, ctx: TenantContext) -> list[MemoryPolicyCatalogRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _MEMORY_COLS + " FROM memory_policy_catalog ORDER BY created_at",
            ).fetchall()
        return [_row_to_memory(r) for r in rows]

    # ---- 通用：delete（按 resource_kind 分表）----

    def delete(self, ctx: TenantContext, *, resource_kind: ResourceKind, catalog_id: str) -> bool:
        table = _TABLE[resource_kind]
        with self._router.session(ctx) as s:
            row = s.execute(f"DELETE FROM {table} WHERE id = %s RETURNING id", (catalog_id,)).fetchone()
        return row is not None
