"""Manager member_grant 成员级授权北向路由（issue #35；04 §6.2，D12）。

受保护端点：挂 require_claims 解身份 → TenantContext（D22）。tenant_id 全程取自
TenantContext，不接受手写过滤（D12：授权按 tenant 裁剪，跨租户串线由 RLS 强制拒绝）。

注：写操作的角色级授权（owner/enterprise_admin）尚未实现，handler 当前仅 require_claims；
落地后在此处补角色校验。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope

from .routes_member import _services, _token_claims
from .schemas import MemberGrantCreate, MemberGrantOut, MemberGrantUpdate

router = APIRouter(prefix="/api/manager", tags=["grant"])


@router.post("/grants", summary="创建/替换资源授权（D12）", operation_id="manager_create_grant")
async def create_grant(
    body: MemberGrantCreate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberGrantOut]:
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    return Envelope[MemberGrantOut](data=grant_svc.create_grant(ctx, body))


@router.get("/grants", summary="列本租户授权（按 tenant 裁剪）", operation_id="manager_list_grants")
async def list_grants(
    request: Request,
    resource_type: str | None = None,
    resource_id: str | None = None,
    claims: TokenClaims = Depends(_token_claims),
) -> ListEnvelope[MemberGrantOut]:
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    if resource_type and resource_id:
        rows = grant_svc.list_grants_by_resource(ctx, resource_type, resource_id)
    else:
        rows = grant_svc.list_grants(ctx)
    return ListEnvelope[MemberGrantOut](data=rows)


@router.get("/grants/{grant_id}", summary="授权详情（按 tenant 裁剪）", operation_id="manager_get_grant")
async def get_grant(
    grant_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberGrantOut]:
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    return Envelope[MemberGrantOut](data=grant_svc.get_grant(ctx, grant_id))


@router.patch("/grants/{grant_id}", summary="改授权部门/成员", operation_id="manager_update_grant")
async def update_grant(
    grant_id: str,
    body: MemberGrantUpdate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberGrantOut]:
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    return Envelope[MemberGrantOut](data=grant_svc.update_grant(ctx, grant_id, body))


@router.delete("/grants/{grant_id}", summary="撤销授权", operation_id="manager_delete_grant")
async def delete_grant(
    grant_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[dict]:
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    grant_svc.delete_grant(ctx, grant_id)
    return Envelope[dict](data={"revoked": grant_id})
