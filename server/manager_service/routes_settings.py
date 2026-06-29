"""Manager 企业端设置路由（B08 设置 + B01 子管理员邀请）。

边界：Manager 管理租户级设置和子管理员邀请。
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope


class EnterpriseSettingsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enterprise_name: str = ""
    logo_url: str | None = None
    phone: str | None = None
    wechat: str | None = None
    invite_code: str | None = None
    notify_on_task_complete: bool = True
    notify_on_system: bool = True
    version: str = "v1.0.0"


class EnterpriseSettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enterprise_name: str | None = None
    logo_url: str | None = None
    notify_on_task_complete: bool | None = None
    notify_on_system: bool | None = None


class AdminInviteOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    invite_id: str
    phone: str
    display_name: str
    status: str = "pending"
    created_at: datetime


class AdminInviteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phone: str
    display_name: str = ""


def build_settings_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/settings", tags=["manager", "settings"])
    require = require_claims(verifier)

    @router.get("", summary="获取企业设置", operation_id="manager_settings_get")
    async def get_settings(claims: TokenClaims = Depends(require)) -> Envelope[EnterpriseSettingsOut]:
        tenant_context_from(claims)
        return Envelope(data=EnterpriseSettingsOut())

    @router.patch("", summary="更新企业设置", operation_id="manager_settings_patch")
    async def patch_settings(
        body: EnterpriseSettingsPatch,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[EnterpriseSettingsOut]:
        tenant_context_from(claims)
        current = EnterpriseSettingsOut()
        if body.enterprise_name is not None:
            current.enterprise_name = body.enterprise_name
        if body.logo_url is not None:
            current.logo_url = body.logo_url
        if body.notify_on_task_complete is not None:
            current.notify_on_task_complete = body.notify_on_task_complete
        if body.notify_on_system is not None:
            current.notify_on_system = body.notify_on_system
        return Envelope(data=current)

    @router.get("/admin-invites", summary="列出子管理员邀请", operation_id="manager_admin_invite_list")
    async def list_invites(claims: TokenClaims = Depends(require)) -> ListEnvelope[AdminInviteOut]:
        tenant_context_from(claims)
        return ListEnvelope(data=[])

    @router.post("/admin-invites", summary="发送子管理员邀请", operation_id="manager_admin_invite_create")
    async def create_invite(
        body: AdminInviteCreate,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[AdminInviteOut]:
        tenant_context_from(claims)
        now = datetime.now(timezone.utc)
        return Envelope(data=AdminInviteOut(
            invite_id=str(uuid4()),
            phone=body.phone,
            display_name=body.display_name,
            status="pending",
            created_at=now,
        ))

    @router.delete("/admin-invites/{invite_id}", summary="撤销子管理员邀请", operation_id="manager_admin_invite_delete")
    async def delete_invite(
        invite_id: str,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {"deleted": True, "invite_id": invite_id}

    return router
