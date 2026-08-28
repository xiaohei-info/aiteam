"""企业设置 + 子管理员邀请 租户作用域数据访问（B08）。

表 enterprise_settings / admin_invite 由 0010_billing_llm_settings_collab.sql 创建。
tenant_id 只从 TenantContext 读（D22）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from shared.db import PgTenantRouter
from shared.contracts.tenancy import TenantContext


@dataclass(frozen=True)
class SettingsRow:
    id: str
    enterprise_name: str
    contact_email: str
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
        contact_email=row[2] or "", contact_phone=row[3] or "",
        logo_url=row[4],
        invite_required=bool(row[5]), member_approval=bool(row[6]),
        max_employees=int(row[7]), features=row[8] or {},
        updated_at=row[9],
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
                "SELECT id, enterprise_name, contact_email, contact_phone, logo_url, "
                "invite_required, member_approval, max_employees, "
                "features, updated_at "
                "FROM enterprise_settings LIMIT 1",
            ).fetchone()
        return _row_to_settings(row) if row else None

    def upsert_settings(
        self, ctx: TenantContext, *,
        enterprise_name: str | None = None,
        contact_email: str | None = None,
        contact_phone: str | None = None,
        logo_url: str | None = None,
        invite_required: bool | None = None,
        member_approval: bool | None = None,
        max_employees: int | None = None,
        features: dict | None = None,
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
                if contact_email is not None:
                    fields.append("contact_email = %s")
                    params.append(contact_email)
                if contact_phone is not None:
                    fields.append("contact_phone = %s")
                    params.append(contact_phone)
                if logo_url is not None:
                    fields.append("logo_url = %s")
                    params.append(logo_url)
                if invite_required is not None:
                    fields.append("invite_required = %s")
                    params.append(invite_required)
                if member_approval is not None:
                    fields.append("member_approval = %s")
                    params.append(member_approval)
                if max_employees is not None:
                    fields.append("max_employees = %s")
                    params.append(max_employees)
                if features is not None:
                    fields.append("features = %s")
                    params.append(json.dumps(features))
                if fields:
                    fields.append("updated_at = now()")
                    params.append(str(existing[0]))
                    s.execute(
                        f"UPDATE enterprise_settings SET {', '.join(fields)} WHERE id = %s",
                        tuple(params),
                    )
            else:
                s.execute(
                    "INSERT INTO enterprise_settings (tenant_id, enterprise_name, contact_email, "
                    "contact_phone, logo_url, invite_required, member_approval, "
                    "max_employees, features) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        ctx.tenant_id,
                        enterprise_name or "",
                        contact_email or "",
                        contact_phone or "",
                        logo_url,
                        invite_required if invite_required is not None else True,
                        member_approval if member_approval is not None else True,
                        max_employees if max_employees is not None else 100,
                        json.dumps(features if features is not None else {}),
                    ),
                )
            row = s.execute(
                "SELECT id, enterprise_name, contact_email, contact_phone, logo_url, "
                "invite_required, member_approval, max_employees, "
                "features, updated_at "
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
        id="", enterprise_name="", contact_email="", contact_phone="", logo_url=None,
        invite_required=True, member_approval=True,
        max_employees=100, features={}, updated_at=datetime.utcnow(),
    )
