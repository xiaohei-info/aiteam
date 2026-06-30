"""Manager 企业端设置路由（B08 设置 + B01 子管理员邀请）。

边界：Manager 管理租户级设置和子管理员邀请。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .routes_settings_schemas import (
    AdminInviteCreate,
    AdminInviteOut,
    EnterpriseSettingsOut,
    EnterpriseSettingsPatch,
)
from .settings_repository import SettingsRepository
from .settings_service import SettingsService


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> SettingsService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_settings_service", None)
    if cache is None:
        cache = SettingsService(SettingsRepository(PgTenantRouter(dsn)))
        request.app.state._settings_service = cache
    return cache


def build_settings_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/settings", tags=["manager", "settings"])
    require = require_claims(verifier)

    @router.get("", summary="获取企业设置", operation_id="manager_settings_get")
    async def get_settings(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EnterpriseSettingsOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.get_settings(ctx)
        return Envelope(data=EnterpriseSettingsOut(**data))

    @router.patch("", summary="更新企业设置", operation_id="manager_settings_patch")
    async def patch_settings(
        body: EnterpriseSettingsPatch,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EnterpriseSettingsOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.patch_settings(
            ctx, enterprise_name=body.enterprise_name, logo_url=body.logo_url,
        )
        return Envelope(data=EnterpriseSettingsOut(**data))

    @router.get("/admin-invites", summary="列出子管理员邀请", operation_id="manager_admin_invite_list")
    async def list_invites(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[AdminInviteOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        items = svc.list_invites(ctx)
        return ListEnvelope(data=[AdminInviteOut(**r) for r in items])

    @router.post("/admin-invites", summary="发送子管理员邀请", operation_id="manager_admin_invite_create")
    async def create_invite(
        body: AdminInviteCreate,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[AdminInviteOut]:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        data = svc.create_invite(ctx, phone=body.phone, display_name=body.display_name)
        return Envelope(data=AdminInviteOut(**data))

    @router.delete("/admin-invites/{invite_id}", summary="撤销子管理员邀请", operation_id="manager_admin_invite_delete")
    async def delete_invite(
        invite_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        ctx = tenant_context_from(claims)
        svc = _service(request)
        svc.delete_invite(ctx, invite_id)
        return {"deleted": True, "invite_id": invite_id}

    return router
