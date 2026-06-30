"""企业设置 + 子管理员邀请 租户作用域数据访问（B08）。

表 enterprise_settings / admin_invite 由 0010_billing_llm_settings_collab.sql 创建。
tenant_id 只从 TenantContext 读（D22）。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.db import PgTenantRouter
from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class SettingsRow:
    id: str
    enterprise_name: str
    contact_phone: str
    logo_url: str | None
    invite_required: bool
    member_approval: bool
    max_employees: int
    features: dict
    updated_at: datetime


@dataclass(frozen=True)
class AdminInviteRow:
    invite_id: str
    phone: str
    display_name: str
    status: str
    created_at: datetime


def _row_to_settings(row: Any) -> SettingsRow:
    return SettingsRow(
        id=str(row[0]), enterprise_name=row[1] or "",
        contact_phone=row[2] or "", logo_url=row[3],
        invite_required=bool(row[4]), member_approval=bool(row[5]),
        max_employees=int(row[6]), features=row[7] or {},
        updated_at=row[8],
    )


def _row_to_invite(row: Any) -> AdminInviteRow:
    return AdminInviteRow(
        invite_id=str(row[0]), phone=row[1], display_name=row[2] or "",
        status=row[4], created_at=row[5],
    )


class SettingsRepository:
    def __init__(self, router: PgTenantRouter):
        self._router = router

    def get_settings(self, ctx: TenantContext) -> SettingsRow | None:
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT id, enterprise_name, contact_phone, logo_url, "
                "invite_required, member_approval, max_employees, features, updated_at "
                "FROM enterprise_settings LIMIT 1",
            ).fetchone()
        return _row_to_settings(row) if row else None

    def upsert_settings(
        self, ctx: TenantContext, *, enterprise_name: str | None = None,
        logo_url: str | None = None,
    ) -> SettingsRow:
        with self._router.session(ctx) as s:
            existing = s.execute(
                "SELECT id FROM enterprise_settings LIMIT 1",
            ).fetchone()
            if existing:
                fields = []
                params = []
                if enterprise_name is not None:
                    fields.append("enterprise_name = %s")
                    params.append(enterprise_name)
                if logo_url is not None:
                    fields.append("logo_url = %s")
                    params.append(logo_url)
                if fields:
                    fields.append("updated_at = now()")
                    params.append(str(existing[0]))
                    s.execute(
                        f"UPDATE enterprise_settings SET {', '.join(fields)} WHERE id = %s",
                        tuple(params),
                    )
            else:
                s.execute(
                    "INSERT INTO enterprise_settings (tenant_id, enterprise_name, logo_url) "
                    "VALUES (%s, %s, %s)",
                    (ctx.tenant_id, enterprise_name or "", logo_url),
                )
            row = s.execute(
                "SELECT id, enterprise_name, contact_phone, logo_url, "
                "invite_required, member_approval, max_employees, features, updated_at "
                "FROM enterprise_settings LIMIT 1",
            ).fetchone()
        return _row_to_settings(row) if row else _empty_settings()

    def list_invites(self, ctx: TenantContext) -> list[AdminInviteRow]:
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT id, email, display_name, roles, status, created_at "
                "FROM admin_invite ORDER BY created_at DESC",
            ).fetchall()
        return [_row_to_invite(r) for r in rows]

    def create_invite(self, ctx: TenantContext, *, phone: str, display_name: str, created_by: str) -> AdminInviteRow:
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO admin_invite (tenant_id, email, display_name, roles, created_by) "
                "VALUES (%s, %s, %s, %s, %s) "
                "RETURNING id, email, display_name, roles, status, created_at",
                (ctx.tenant_id, phone, display_name, [], created_by),
            ).fetchone()
        return _row_to_invite(row)

    def delete_invite(self, ctx: TenantContext, invite_id: str) -> bool:
        with self._router.session(ctx) as s:
            cur = s.execute("DELETE FROM admin_invite WHERE id = %s", (invite_id,))
            return cur.rowcount > 0


def _empty_settings() -> SettingsRow:
    return SettingsRow(
        id="", enterprise_name="", contact_phone="", logo_url=None,
        invite_required=True, member_approval=True, max_employees=100,
        features={}, updated_at=datetime.utcnow(),
    )
