"""Tenant-scoped employee avatar metadata persistence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


@dataclass(frozen=True)
class EmployeeAvatarRow:
    employee_id: str
    storage_key: str
    mime_type: str
    byte_size: int
    sha256: str
    version: int
    updated_at: datetime


def _row(row: Any) -> EmployeeAvatarRow:
    return EmployeeAvatarRow(
        employee_id=str(row[0]), storage_key=row[1],
        mime_type=row[2], byte_size=int(row[3]), sha256=row[4],
        version=int(row[5]), updated_at=row[6],
    )


class EmployeeAvatarRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def get(self, ctx: TenantContext, employee_id: str) -> EmployeeAvatarRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT employee_id, storage_key, mime_type, byte_size, sha256, version, updated_at "
                "FROM employee_avatar WHERE employee_id::text = %s AND deleted_at IS NULL",
                (employee_id,),
            ).fetchone()
        return _row(row) if row else None

    def upsert(self, ctx: TenantContext, *, employee_id: str, storage_key: str,
               mime_type: str, byte_size: int, sha256: str) -> EmployeeAvatarRow:
        """Insert at version 1, or bump the version when the bytes changed (same sha256 = no-op)."""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO employee_avatar (tenant_id, employee_id, storage_key, mime_type, byte_size, sha256, version) "
                "VALUES (%s, %s, %s, %s, %s, %s, 1) "
                "ON CONFLICT (tenant_id, employee_id) DO UPDATE SET storage_key = EXCLUDED.storage_key, "
                "mime_type = EXCLUDED.mime_type, byte_size = EXCLUDED.byte_size, sha256 = EXCLUDED.sha256, "
                "version = CASE WHEN employee_avatar.sha256 = EXCLUDED.sha256 AND employee_avatar.deleted_at IS NULL "
                "THEN employee_avatar.version ELSE employee_avatar.version + 1 END, "
                "updated_at = now(), deleted_at = NULL "
                "RETURNING employee_id, storage_key, mime_type, byte_size, sha256, version, updated_at",
                (ctx.tenant_id, employee_id, storage_key, mime_type, byte_size, sha256),
            ).fetchone()
        return _row(row)

    def employee_origin(self, ctx: TenantContext, employee_id: str) -> str | None:
        """``employee.origin`` (recruited/solution/copied/custom) in the current tenant; None = not found."""
        with self._router.session(ctx) as s:
            row = s.execute("SELECT origin FROM employee WHERE id::text = %s", (employee_id,)).fetchone()
        return str(row[0]) if row else None
