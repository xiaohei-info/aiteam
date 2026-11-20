"""成员能力授权上报（设计 2026-11-19 审批策略与能力授权 §3.2 / §3.4）。

授权跟着安装走：本机 Agent 安装企业目录 MCP 时上报「成员装着这个 MCP」，卸载时删除；登录时
补报已装的（只增不减）。Manager 侧只在下发平台预登记的 MCP OAuth 应用密钥时读取它（见
mcp_catalog.McpMarketService.oauth_client）。授权是本机自证，不是安全边界。

窄通道：只收平台 server_id 这类中立元数据，不含会话内容、不含令牌（D13）。成员自装能力
（自填地址 / 本机导入 / ClawHub）只在本机，不上报。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError, Forbidden

from .member_capability_grant_repository import build_member_capability_grant_repository


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


class CapabilityGrantIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    server_id: str = Field(min_length=1, max_length=256, description="企业目录 MCP 的平台 server_id。")


class CapabilityGrantsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str | None = Field(default=None)
    grants: list[CapabilityGrantIn] = Field(default_factory=list, max_length=200)


def _repo(request: Request):
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager DB is not configured")
    cached = getattr(request.app.state, "_member_capability_grant_repo", None)
    if cached is None:
        cached = build_member_capability_grant_repository(PgTenantRouter(dsn))
        request.app.state._member_capability_grant_repo = cached
    return cached


def build_capability_grant_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager", tags=["manager", "capability-grant"])
    require = require_claims(verifier)

    @router.post(
        "/capability-grants",
        description="本机 Agent 上报当前成员装着的企业目录 MCP（只增不减）；tenant_id 必须与当前 TenantContext 一致。",
        summary="上报成员已装企业 MCP",
        operation_id="manager_capability_grants_put",
    )
    def put_grants(body: CapabilityGrantsIn, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[dict]:
        ctx = tenant_context_from(claims)
        if body.tenant_id is not None and body.tenant_id != ctx.tenant_id:
            raise Forbidden("capability grant tenant_id must match the authenticated tenant")
        repo = _repo(request)
        for item in body.grants:
            repo.upsert(ctx, member_id=ctx.user_id, capability_kind="mcp", capability_ref=item.server_id)
        return Envelope(data={"accepted": len(body.grants)})

    @router.delete(
        "/capability-grants",
        description="成员卸载企业目录 MCP 时删除对应授权；只删当前成员自己的。",
        summary="删除成员已装企业 MCP 授权",
        operation_id="manager_capability_grants_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_grant(request: Request, server_id: str = Query(min_length=1, max_length=256), claims: TokenClaims = Depends(require)) -> None:
        ctx = tenant_context_from(claims)
        _repo(request).delete(ctx, member_id=ctx.user_id, capability_kind="mcp", capability_ref=server_id)

    return router
