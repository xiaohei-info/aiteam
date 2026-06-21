"""Manager 成员/部门/角色北向路由（issue #35；02 §10 路径/envelope；03 §9.7）。

受保护端点：挂 require_claims 解身份 → TenantContext（D22）。tenant_id 全程取自
TenantContext，不接受手写过滤。

写操作的角色级授权（owner/enterprise_admin）在 service 层 enforce（member_service
._ensure_can_write，#117）；route 仅 require_claims 解身份，鉴权权威在 service。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims, tenant_context_from
from shared.config import Settings
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.contracts.auth import TokenClaims
from shared.errors import AppError

from .member_service import build_member_dept_service, MemberDeptService
from .schemas import DepartmentCreate, DepartmentOut, DepartmentUpdate, MemberCreate, MemberOut, MemberUpdate
from .routes_auth import _auth_service


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _token_claims(request: Request) -> TokenClaims:
    """解出当前身份（03 §9.6）。验签器挂在 app.state（生产 tenant 公钥/JWKS，D23）。"""
    return require_claims(request.app.state._token_verifier)(request)


def _services(request: Request) -> tuple[MemberDeptService, "object"]:
    """从端配置取业务 DSN 构造成员/部门 + 授权服务；未配置则 503（不静默）。"""
    settings: Settings = request.app.state.settings
    dsn = settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    auth = _auth_service(request)
    cache = getattr(request.app.state, "_member_services", None)
    if cache is None:
        member_svc, grant_svc = build_member_dept_service(dsn, auth=auth)
        cache = (member_svc, grant_svc)
        request.app.state._member_services = cache
    return cache


router = APIRouter(prefix="/api/manager", tags=["member", "department"])


@router.post("/departments", summary="建部门（owner/enterprise_admin）", operation_id="manager_create_department")
async def create_department(
    body: DepartmentCreate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[DepartmentOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    return Envelope[DepartmentOut](data=member_svc.create_department(ctx, body))


@router.get("/departments", summary="列部门（所有角色）", operation_id="manager_list_departments")
async def list_departments(
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> ListEnvelope[DepartmentOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    rows = member_svc.list_departments(ctx)
    return ListEnvelope[DepartmentOut](data=rows)


@router.get("/departments/{department_id}", summary="部门详情", operation_id="manager_get_department")
async def get_department(
    department_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[DepartmentOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    return Envelope[DepartmentOut](data=member_svc.get_department(ctx, department_id))


@router.patch("/departments/{department_id}", summary="改部门", operation_id="manager_update_department")
async def update_department(
    department_id: str,
    body: DepartmentUpdate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[DepartmentOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    return Envelope[DepartmentOut](data=member_svc.update_department(ctx, department_id, body))


@router.delete("/departments/{department_id}", summary="删部门", operation_id="manager_delete_department")
async def delete_department(
    department_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[dict]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    member_svc.delete_department(ctx, department_id)
    return Envelope[dict](data={"deleted": department_id})


@router.post("/members", summary="建成员（03 §9.4B）", operation_id="manager_create_member")
async def create_member(
    body: MemberCreate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    return Envelope[MemberOut](data=member_svc.create_member(ctx, body))


@router.get("/members", summary="列成员（不回显凭据）", operation_id="manager_list_members")
async def list_members(
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> ListEnvelope[MemberOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    return ListEnvelope[MemberOut](data=member_svc.list_members(ctx))


@router.get("/members/{member_id}", summary="成员详情（不回显凭据）", operation_id="manager_get_member")
async def get_member(
    member_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    return Envelope[MemberOut](data=member_svc.get_member(ctx, member_id))


@router.patch("/members/{member_id}", summary="改成员（角色/部门/状态）", operation_id="manager_update_member")
async def update_member(
    member_id: str,
    body: MemberUpdate,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[MemberOut]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    return Envelope[MemberOut](data=member_svc.update_member(ctx, member_id, body))


@router.delete("/members/{member_id}", summary="删成员", operation_id="manager_delete_member")
async def delete_member(
    member_id: str,
    request: Request,
    claims: TokenClaims = Depends(_token_claims),
) -> Envelope[dict]:
    ctx = tenant_context_from(claims)
    member_svc, _ = _services(request)
    member_svc.delete_member(ctx, member_id)
    return Envelope[dict](data={"deleted": member_id})
