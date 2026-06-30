"""连接器操作 租户作用域数据访问（B05）。

表 connector_status / connector_test / connector_grant 由 0011 创建。
tenant_id 只从 TenantContext 读（D22）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.db import PgTenantRouter
from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class ConnectorStatusRow:
    connector_id: str
    status: str
    last_check_at: datetime
    error_message: str | None


@dataclass(frozen=True)
class ConnectorTestRow:
    connector_id: str
    success: bool
    latency_ms: int
    message: str
    tested_at: datetime


@dataclass(frozen=True)
class ConnectorGrantRow:
    connector_id: str
    employee_ids: list[str]
    updated_at: datetime


def _row_to_status(row: Any) -> ConnectorStatusRow:
    return ConnectorStatusRow(
        connector_id=row[0], status=row[1], last_check_at=row[2], error_message=row[3],
    )


def _row_to_test(row: Any) -> ConnectorTestRow:
    return ConnectorTestRow(
        connector_id=row[0], success=bool(row[1]), latency_ms=int(row[2]),
        message=row[3], tested_at=row[4],
    )


def _row_to_grant(row: Any) -> ConnectorGrantRow:
    return ConnectorGrantRow(
        connector_id=row[0], employee_ids=list(row[1] or []), updated_at=row[2],
    )


class ConnectorOpsRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    # ---- status ----

    def get_status(self, ctx: TenantContext, connector_id: str) -> ConnectorStatusRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT connector_id, status, last_check_at, error_message "
                "FROM connector_status WHERE connector_id = %s",
                (connector_id,),
            ).fetchone()
        return _row_to_status(row) if row else None

    def upsert_status(self, ctx: TenantContext, connector_id: str, *,
                      status: str, error_message: str | None = None) -> ConnectorStatusRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO connector_status (tenant_id, connector_id, status, last_check_at, error_message) "
                "VALUES (%s, %s, %s, now(), %s) "
                "ON CONFLICT (tenant_id, connector_id) DO UPDATE SET "
                "status = EXCLUDED.status, last_check_at = now(), error_message = EXCLUDED.error_message "
                "RETURNING connector_id, status, last_check_at, error_message",
                (ctx.tenant_id, connector_id, status, error_message),
            ).fetchone()
        return _row_to_status(row)

    # ---- test ----

    def create_test(self, ctx: TenantContext, connector_id: str, *,
                    success: bool, latency_ms: int, message: str) -> ConnectorTestRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO connector_test (tenant_id, connector_id, success, latency_ms, message) "
                "VALUES (%s, %s, %s, %s, %s) "
                "RETURNING connector_id, success, latency_ms, message, tested_at",
                (ctx.tenant_id, connector_id, success, latency_ms, message),
            ).fetchone()
        return _row_to_test(row)

    def list_tests(self, ctx: TenantContext, connector_id: str) -> list[ConnectorTestRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT connector_id, success, latency_ms, message, tested_at "
                "FROM connector_test WHERE connector_id = %s ORDER BY tested_at DESC LIMIT 20",
                (connector_id,),
            ).fetchall()
        return [_row_to_test(r) for r in rows]

    # ---- grants ----

    def get_grants(self, ctx: TenantContext, connector_id: str) -> ConnectorGrantRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT connector_id, employee_ids, updated_at "
                "FROM connector_grant WHERE connector_id = %s",
                (connector_id,),
            ).fetchone()
        return _row_to_grant(row) if row else None

    def set_grants(self, ctx: TenantContext, connector_id: str, employee_ids: list[str]) -> ConnectorGrantRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO connector_grant (tenant_id, connector_id, employee_ids) "
                "VALUES (%s, %s, %s) "
                "ON CONFLICT (tenant_id, connector_id) DO UPDATE SET "
                "employee_ids = EXCLUDED.employee_ids, updated_at = now() "
                "RETURNING connector_id, employee_ids, updated_at",
                (ctx.tenant_id, connector_id, employee_ids),
            ).fetchone()
        return _row_to_grant(row)
