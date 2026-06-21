"""成员/部门/角色 + member_grant 授权业务编排（issue #35；03 §9.7；04 §6.1，D12）。

编排职责：
- 部门/成员/授权 CRUD 编排（经 repository，tenant_id 全程取自 TenantContext）。
- 校验：角色取值合法（EnterpriseRole 枚举）、resource_type 白名单、部门存在性。
- 创建成员复用 AuthService 的账号开通（app_user + auth_identity）。
- 返回 API schema（*Out），不回显凭据/secret。
"""

from __future__ import annotations

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Forbidden, NotFound

from .auth_service import AuthService
from .repository_member import (
    DepartmentRow,
    GrantRepository,
    GrantRow,
    MemberDeptRepository,
    MemberRow,
    validate_resource_type,
)
from .schemas import (
    DepartmentCreate,
    DepartmentOut,
    DepartmentUpdate,
    MemberCreate,
    MemberGrantCreate,
    MemberGrantOut,
    MemberGrantUpdate,
    MemberOut,
    MemberUpdate,
)


# 成员/部门/授权写操作允许的企业角色（03 §9.7；与兄弟服务 _*_WRITE_ROLES 一致）。
# member 与 finance_admin 不可写成员/部门/授权（治理类写归管理角色）。读操作不限角色。
_MEMBER_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


def _ensure_can_write(ctx: TenantContext) -> None:
    """成员/部门/授权写鉴权（03 §9.7）。非 owner/enterprise_admin → 403。

    后端权威：前端 UI 门控只是体验，真正 enforcement 在此（#117：补齐 member/dept/grant
    写端点角色校验，杜绝普通成员持 token 越权写）。
    """
    if not set(ctx.roles) & set(_MEMBER_WRITE_ROLES):
        raise Forbidden("requires owner or enterprise_admin")


def _department_out(row: DepartmentRow) -> DepartmentOut:
    return DepartmentOut(
        id=row.id,
        department_slug=row.department_slug,
        display_name=row.display_name,
        created_at=row.created_at,
    )


def _member_out(row: MemberRow) -> MemberOut:
    return MemberOut(
        id=row.id, display_name=row.display_name, status=row.status,
        roles=row.roles, department_ids=row.department_ids,
    )


def _grant_out(row: GrantRow, tenant_id: str) -> MemberGrantOut:
    return MemberGrantOut(
        id=row.id,
        tenant_id=tenant_id,
        resource_type=row.resource_type,
        resource_id=row.resource_id,
        department_ids=row.department_ids,
        member_ids=row.member_ids,
        updated_at=row.updated_at,
    )


class MemberDeptService:
    """部门 + 成员（角色经 EnterpriseRole 枚举）编排。tenant_id 全程取自 TenantContext。"""

    def __init__(self, *, repo: MemberDeptRepository, auth: AuthService | None = None):
        # auth 仅账号开通/口令等**写路径**需要（create_member）；只读消费者（如 M7 快照授权）
        # 只用 get_member 等读方法，可不注入 auth，避免无谓耦合到签名私钥库（admin DSN）。
        self._repo = repo
        self._auth = auth

    # ---- 部门 ----
    def create_department(self, ctx: TenantContext, req: DepartmentCreate) -> DepartmentOut:
        _ensure_can_write(ctx)
        row = self._repo.create_department(
            ctx, department_slug=req.department_slug, display_name=req.display_name
        )
        return _department_out(row)

    def get_department(self, ctx: TenantContext, department_id: str) -> DepartmentOut:
        row = self._repo.get_department(ctx, department_id=department_id)
        if row is None:
            raise NotFound("department not found")
        return _department_out(row)

    def list_departments(self, ctx: TenantContext) -> list[DepartmentOut]:
        return [_department_out(r) for r in self._repo.list_departments(ctx)]

    def update_department(
        self, ctx: TenantContext, department_id: str, req: DepartmentUpdate
    ) -> DepartmentOut:
        _ensure_can_write(ctx)
        row = self._repo.update_department(
            ctx, department_id=department_id, display_name=req.display_name
        )
        if row is None:
            raise NotFound("department not found")
        return _department_out(row)

    def delete_department(self, ctx: TenantContext, department_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete_department(ctx, department_id=department_id):
            raise NotFound("department not found")

    # ---- 成员（角色）----
    def create_member(self, ctx: TenantContext, req: MemberCreate) -> MemberOut:
        _ensure_can_write(ctx)
        roles = self._normalize_roles(req.roles)
        # 账号开通复用 AuthService（app_user + auth_identity；tenant_id 经 ctx）。
        # member 首登不强制重置（留详设）。
        user_id = self._auth.create_member(
            ctx.tenant_id,
            phone=req.account, initial_password=req.initial_password,
            display_name=req.display_name,
        )
        # 入部门 + 角色（create_member 默认 member 角色，此处按 req 落真实角色与部门）。
        row = self._repo.update_member(
            ctx, member_id=user_id, display_name=None,
            roles=[r.value for r in roles], department_ids=list(req.department_ids), status=None,
        )
        # create_member 已保证存在；update_member 不会 None。
        assert row is not None
        return _member_out(row)

    def list_members(self, ctx: TenantContext) -> list[MemberOut]:
        return [_member_out(r) for r in self._repo.list_members(ctx)]

    def get_member(self, ctx: TenantContext, member_id: str) -> MemberOut:
        row = self._repo.get_member(ctx, member_id=member_id)
        if row is None:
            raise NotFound("member not found")
        return _member_out(row)

    def update_member(self, ctx: TenantContext, member_id: str, req: MemberUpdate) -> MemberOut:
        _ensure_can_write(ctx)
        roles = (
            [r.value for r in self._normalize_roles(req.roles)] if req.roles is not None else None
        )
        row = self._repo.update_member(
            ctx, member_id=member_id, display_name=req.display_name,
            roles=roles, department_ids=req.department_ids, status=req.status,
        )
        if row is None:
            raise NotFound("member not found")
        return _member_out(row)

    def delete_member(self, ctx: TenantContext, member_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete_member(ctx, member_id=member_id):
            raise NotFound("member not found")

    @staticmethod
    def _normalize_roles(roles: list[EnterpriseRole]) -> list[EnterpriseRole]:
        """校验角色取值合法（禁用旧 admin/manager/viewer，由枚举定义强制）。"""
        if not roles:
            return [EnterpriseRole.MEMBER]
        # 枚举实例本身就是合法取值；重复项去重保序。
        seen: set[str] = set()
        out: list[EnterpriseRole] = []
        for r in roles:
            if r.value not in seen:
                seen.add(r.value)
                out.append(r)
        return out


class GrantService:
    """member_grant 成员级授权编排（D12）。tenant_id 全程取自 TenantContext。"""

    def __init__(self, *, repo: GrantRepository, members: MemberDeptRepository):
        self._repo = repo
        self._members = members

    def _validate_subjects(
        self, ctx: TenantContext, department_ids: list[str], member_ids: list[str]
    ) -> None:
        """部门/成员必须存在于本 tenant（RLS 已裁剪，跨租户 id 自然查无）。

        不存在统一抛 NotFound（404），与成员/部门 detail 端点语义一致（02 §11 资源不存在 404）。
        """
        for dept_id in department_ids:
            if not self._members.department_exists(ctx, department_id=dept_id):
                raise NotFound(f"department not found: {dept_id}")
        for mem_id in member_ids:
            if self._members.get_member(ctx, member_id=mem_id) is None and mem_id != "":
                raise NotFound(f"member not found: {mem_id}")

    def create_grant(self, ctx: TenantContext, req: MemberGrantCreate) -> MemberGrantOut:
        _ensure_can_write(ctx)
        validate_resource_type(req.resource_type)
        self._validate_subjects(ctx, req.department_ids, req.member_ids)
        row = self._repo.upsert(
            ctx, resource_type=req.resource_type, resource_id=req.resource_id,
            department_ids=list(req.department_ids), member_ids=list(req.member_ids),
        )
        return _grant_out(row, tenant_id=ctx.tenant_id)

    def list_grants(self, ctx: TenantContext) -> list[MemberGrantOut]:
        return [_grant_out(r, tenant_id=ctx.tenant_id) for r in self._repo.list_all(ctx)]

    def get_grant(self, ctx: TenantContext, grant_id: str) -> MemberGrantOut:
        """按 id 取单条授权（PK 查询，不全表扫描；tenant 经 ctx + RLS 裁剪）。"""
        row = self._repo.get(ctx, grant_id=grant_id)
        if row is None:
            raise NotFound("grant not found")
        return _grant_out(row, tenant_id=ctx.tenant_id)

    def list_grants_by_resource(
        self, ctx: TenantContext, resource_type: str, resource_id: str
    ) -> list[MemberGrantOut]:
        validate_resource_type(resource_type)
        return [
            _grant_out(r, tenant_id=ctx.tenant_id)
            for r in self._repo.list_by_resource(
                ctx, resource_type=resource_type, resource_id=resource_id
            )
        ]

    def update_grant(
        self, ctx: TenantContext, grant_id: str, req: MemberGrantUpdate
    ) -> MemberGrantOut:
        _ensure_can_write(ctx)
        existing = self._repo.get(ctx, grant_id=grant_id)
        if existing is None:
            raise NotFound("grant not found")
        self._validate_subjects(ctx, req.department_ids, req.member_ids)
        row = self._repo.update(
            ctx, grant_id=grant_id,
            department_ids=list(req.department_ids), member_ids=list(req.member_ids),
        )
        assert row is not None
        return _grant_out(row, tenant_id=ctx.tenant_id)

    def delete_grant(self, ctx: TenantContext, grant_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, grant_id=grant_id):
            raise NotFound("grant not found")


def build_member_dept_service(
    dsn: str, *, auth: AuthService
) -> tuple[MemberDeptService, GrantService]:
    """组装成员/部门 + 授权服务（业务连接 app_rw，#60）。"""
    router = PgTenantRouter(dsn)
    member_repo = MemberDeptRepository(router)
    grant_repo = GrantRepository(router)
    return (
        MemberDeptService(repo=member_repo, auth=auth),
        GrantService(repo=grant_repo, members=member_repo),
    )
