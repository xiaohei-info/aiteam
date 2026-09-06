"""Manager member_grant 成员级授权北向路由（issue #35；04 §6.2，D12）。

受保护端点：挂 require_claims 解身份 → TenantContext（D22）。tenant_id 全程取自
TenantContext，不接受手写过滤（D12：授权按 tenant 裁剪，跨租户串线由 RLS 强制拒绝）。

写操作的角色级授权（owner/enterprise_admin）在 service 层 enforce（member_service
._ensure_can_write，#117）；route 仅 require_claims 解身份，鉴权权威在 service。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import AuthorizedConfigPullRequest, AuthorizedConfigPullResponse
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError, Forbidden, ValidationProblem

from .authorized_config_service import AuthorizedConfigService
from .knowledge_access_policy import KnowledgeAccessPolicy
from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .openapi_schemas import GrantRevocationOut
from .capability_catalog_service import build_capability_catalog_service
from .employee_config_service import build_employee_config_service
from .routes_member import _services, _token_claims
from .schemas import MemberGrantCreate, MemberGrantOut, MemberGrantUpdate, validate_uuid_string_list

router = APIRouter(prefix="/api/manager", tags=["grant"])


def _validate_audience(body):
    try:
        validate_uuid_string_list(body.department_ids)
        validate_uuid_string_list(body.member_ids)
    except ValueError as exc:
        raise ValidationProblem("department_ids and member_ids must contain non-empty UUIDs") from exc


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _authorized_config_service(request: Request) -> AuthorizedConfigService:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_authorized_config_service", None)
    if cache is None:
        router_pg = PgTenantRouter(dsn)
        _, grant_svc = _services(request)
        from .member_service import MemberDeptService
        from .recruit_repository import RecruitRepository
        from .repository_member import MemberDeptRepository
        capability_catalog = build_capability_catalog_service(router_pg)
        cache = AuthorizedConfigService(
            config_service=build_employee_config_service(router_pg),
            grant_service=grant_svc,
            member_service=MemberDeptService(repo=MemberDeptRepository(router_pg)),
            recruit_repository=RecruitRepository(router_pg),
            capability_catalog=capability_catalog,
            knowledge_policy=KnowledgeAccessPolicy(EmployeeKnowledgeBindingRepository(router_pg)),
        )
        request.app.state._authorized_config_service = cache
    return cache


@router.post("/grants", description="新增授权：将 expert 授予成员。", summary="创建/替换资源授权（D12）", operation_id="manager_create_grant")
async def create_grant(
    body: MemberGrantCreate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberGrantOut]:
    _validate_audience(body)
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    return Envelope[MemberGrantOut](data=grant_svc.create_grant(ctx, body))


@router.get("/grants", description="列本租户授权（按 tenant 裁剪）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="列本租户授权（按 tenant 裁剪）", operation_id="manager_list_grants")
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


@router.get("/grants/{grant_id}", description="授权详情（按 tenant 裁剪）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="授权详情（按 tenant 裁剪）", operation_id="manager_get_grant")
async def get_grant(
    grant_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberGrantOut]:
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    return Envelope[MemberGrantOut](data=grant_svc.get_grant(ctx, grant_id))


@router.patch("/grants/{grant_id}", description="改授权部门/成员。成功响应遵循统一 envelope，失败返回 problem+json。", summary="改授权部门/成员", operation_id="manager_update_grant")
async def update_grant(
    grant_id: str,
    body: MemberGrantUpdate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberGrantOut]:
    _validate_audience(body)
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    return Envelope[MemberGrantOut](data=grant_svc.update_grant(ctx, grant_id, body))


@router.delete("/grants/{grant_id}", description="撤销指定授权。撤销后 Agent 端投影同步移除。", summary="撤销授权", operation_id="manager_delete_grant")
async def delete_grant(
    grant_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[GrantRevocationOut]:
    ctx = tenant_context_from(claims)
    _, grant_svc = _services(request)
    grant_svc.delete_grant(ctx, grant_id)
    return Envelope[GrantRevocationOut](data=GrantRevocationOut(revoked=grant_id))


@router.post(
    "/grants/authorized-config",
    description="Agent pull 授权配置增量（F10 / 05 §5.4 / D5/D12/D22）。成功响应遵循统一 envelope，失败返回 problem+json。", summary="Agent pull 授权配置增量（F10 / 05 §5.4 / D5/D12/D22）",
    operation_id="manager_grants_authorized_config_pull",
)
async def pull_authorized_config(
    body: AuthorizedConfigPullRequest,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[AuthorizedConfigPullResponse]:
    # F10：member_id 须与 token 主体一致，禁止代他人 pull。
    if body.member_id != claims.user_id:
        raise Forbidden("member_id must match the authenticated subject")
    # 契约自洽（03 §9.7）：body.tenant_id 须与 token 中的 tenant_id 一致。
    if body.tenant_id != claims.tenant_id:
        raise Forbidden("tenant_id mismatch: body does not match token claims")
    ctx = tenant_context_from(claims)
    svc = _authorized_config_service(request)
    return Envelope[AuthorizedConfigPullResponse](data=svc.pull(ctx, body))
