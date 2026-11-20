"""成员能力授权上报（设计 2026-11-19 审批策略与能力授权 §3.2 / §3.4）。

本机 Agent 在成员批准安装某个能力后上报一条授权（仅本会话有效）。Manager 侧只在下发平台
预登记的 MCP OAuth 应用密钥时读取它（见 mcp_catalog.McpMarketService.oauth_client）。

窄通道：只收「成员 + 会话 + 能力种类 + 标识 + 来源」这类中立元数据，不含会话内容、不含令牌（D13）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError, Forbidden, ValidationProblem

from .member_capability_grant_repository import build_member_capability_grant_repository

_KIND = {"mcp", "skill"}


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


class CapabilityGrantIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: str = Field(min_length=1, max_length=256)
    kind: str = Field(description="mcp 或 skill")
    ref: str = Field(min_length=1, max_length=256)
    source: str = Field(default="", max_length=64)
    scope: str = Field(default="session", max_length=32)


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
        description="接收本机 Agent 上报的成员能力授权（仅本会话有效）；tenant_id 必须与当前 TenantContext 一致。",
        summary="上报成员能力授权",
        operation_id="manager_capability_grants_put",
    )
    def put_grants(body: CapabilityGrantsIn, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[dict]:
        ctx = tenant_context_from(claims)
        if body.tenant_id is not None and body.tenant_id != ctx.tenant_id:
            raise Forbidden("capability grant tenant_id must match the authenticated tenant")
        repo = _repo(request)
        for item in body.grants:
            if item.kind not in _KIND:
                raise ValidationProblem("kind must be mcp or skill")
            if item.scope != "session":
                raise ValidationProblem("only session scope is supported")
            # 红线：只收「企业自有 MCP」的授权。成员自装能力（自填地址 / 本机导入 /
            # ClawHub 等）凭据只在本机，不上传 Manager（设计 2026-11-19 §3.4 范围）。
            if item.kind != "mcp" or item.source != "platform_catalog":
                continue
            repo.upsert(
                ctx, member_id=ctx.user_id, conversation_id=item.conversation_id,
                capability_kind=item.kind, capability_ref=item.ref, source=item.source, scope=item.scope,
            )
        return Envelope(data={"accepted": len(body.grants)})

    @router.delete(
        "/capability-grants",
        description="删除某会话的全部能力授权（会话结束 / 成员撤销）；会话不属于当前成员时拒绝。",
        summary="删除会话能力授权",
        operation_id="manager_capability_grants_delete",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    def delete_grants(request: Request, conversation_id: str = Query(min_length=1, max_length=256), claims: TokenClaims = Depends(require)) -> None:
        ctx = tenant_context_from(claims)
        _repo(request).delete_conversation(ctx, member_id=ctx.user_id, conversation_id=conversation_id)

    return router
