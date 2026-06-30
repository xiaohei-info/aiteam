"""企业设置 + 子管理员邀请编排（B08）。"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext
from shared.errors import NotFound

from .settings_repository import SettingsRepository


class SettingsService:
    def __init__(self, repo: SettingsRepository):
        self._repo = repo

    def get_settings(self, ctx: TenantContext) -> dict:
        row = self._repo.get_settings(ctx)
        if row is None:
            row = self._repo.upsert_settings(ctx)
        return {
            "enterprise_name": row.enterprise_name,
            "logo_url": row.logo_url,
            "phone": row.contact_phone,
            "updated_at": row.updated_at,
        }

    def patch_settings(self, ctx: TenantContext, *, enterprise_name: str | None, logo_url: str | None) -> dict:
        row = self._repo.upsert_settings(ctx, enterprise_name=enterprise_name, logo_url=logo_url)
        return {
            "enterprise_name": row.enterprise_name,
            "logo_url": row.logo_url,
            "phone": row.contact_phone,
            "updated_at": row.updated_at,
        }

    def list_invites(self, ctx: TenantContext) -> list[dict]:
        rows = self._repo.list_invites(ctx)
        return [
            {
                "invite_id": r.invite_id,
                "phone": r.phone,
                "display_name": r.display_name,
                "status": r.status,
                "created_at": r.created_at,
            }
            for r in rows
        ]

    def create_invite(self, ctx: TenantContext, *, phone: str, display_name: str) -> dict:
        row = self._repo.create_invite(ctx, phone=phone, display_name=display_name, created_by=ctx.user_id)
        return {
            "invite_id": row.invite_id,
            "phone": row.phone,
            "display_name": row.display_name,
            "status": row.status,
            "created_at": row.created_at,
        }

    def delete_invite(self, ctx: TenantContext, invite_id: str) -> None:
        if not self._repo.delete_invite(ctx, invite_id):
            raise NotFound("invite not found in this tenant")
