"""成员/部门/授权写端点角色 enforcement（#117，03 §9.7）。

红线：前端 UI 门控只是体验，后端才是权威——普通 member 持有效 token 不得越权写
成员/部门/授权。非 integration（service 层，不依赖 PG）。

测法（消除"构造真行"的特殊情况）：注入 _Boom 仓储——任何方法被调用即抛 RuntimeError。
- member 角色写 → Forbidden（在触达仓储前被拦，_Boom 永不触发）。
- owner 角色写 → 越过角色门、触达仓储 → RuntimeError（证明门已放行，非被角色拦）。
读方法不受限（owner/member 都应越过门到达仓储）。
"""

import pytest

from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden

from manager_service.member_service import GrantService, MemberDeptService
from manager_service.schemas import (
    DepartmentCreate,
    DepartmentUpdate,
    MemberCreate,
    MemberGrantCreate,
    MemberGrantUpdate,
    MemberUpdate,
)


class _Boom:
    """任何属性被当函数调用即抛——用于断言"是否触达仓储/auth"。"""

    def __getattr__(self, name):
        def _raise(*args, **kwargs):
            raise RuntimeError(f"repo/auth touched: {name}")

        return _raise


def _ctx(*roles: str) -> TenantContext:
    return TenantContext(tenant_id="t-a", user_id="u-1", roles=list(roles))


def _member_svc() -> MemberDeptService:
    return MemberDeptService(repo=_Boom(), auth=_Boom())


def _grant_svc() -> GrantService:
    return GrantService(repo=_Boom(), members=_Boom())


# 写操作 → (调用 lambda)。member 应 Forbidden；owner 应越过门触达 _Boom（RuntimeError）。
def _member_writes(svc: MemberDeptService):
    return [
        lambda c: svc.create_department(c, DepartmentCreate(department_slug="d", display_name="D")),
        lambda c: svc.update_department(c, "d1", DepartmentUpdate(display_name="X")),
        lambda c: svc.delete_department(c, "d1"),
        lambda c: svc.create_member(c, MemberCreate(account="13800000000", initial_password="pw123456")),
        lambda c: svc.update_member(c, "m1", MemberUpdate(display_name="X")),
        lambda c: svc.delete_member(c, "m1"),
    ]


def _grant_writes(svc: GrantService):
    return [
        lambda c: svc.create_grant(c, MemberGrantCreate(resource_type="expert", resource_id="e1", member_ids=["m1"])),
        lambda c: svc.update_grant(c, "g1", MemberGrantUpdate(member_ids=["m1"])),
        lambda c: svc.delete_grant(c, "g1"),
    ]


def test_member_role_cannot_write_member_or_dept():
    """普通 member 写成员/部门 → 403，且仓储/auth 从未被触达。"""
    svc = _member_svc()
    for call in _member_writes(svc):
        with pytest.raises(Forbidden):
            call(_ctx("member"))


def test_member_role_cannot_write_grant():
    """普通 member 写授权 → 403（D12 授权配置归管理角色）。"""
    svc = _grant_svc()
    for call in _grant_writes(svc):
        with pytest.raises(Forbidden):
            call(_ctx("member"))


def test_finance_admin_cannot_write_member_or_grant():
    """finance_admin 也不可写成员/授权（治理写归 owner/enterprise_admin）。"""
    for call in _member_writes(_member_svc()):
        with pytest.raises(Forbidden):
            call(_ctx("finance_admin"))
    for call in _grant_writes(_grant_svc()):
        with pytest.raises(Forbidden):
            call(_ctx("finance_admin"))


@pytest.mark.parametrize("role", ["owner", "enterprise_admin"])
def test_admin_roles_pass_role_gate(role):
    """owner/enterprise_admin 越过角色门 → 触达仓储（RuntimeError，非 Forbidden）。"""
    for call in _member_writes(_member_svc()):
        with pytest.raises(RuntimeError):
            call(_ctx(role))
    for call in _grant_writes(_grant_svc()):
        with pytest.raises(RuntimeError):
            call(_ctx(role))
