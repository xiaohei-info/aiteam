"""employee/expert 配置业务编排（M2，06 §7.6 / 04 §6.1，D16）。

编排 repository（租户隔离）+ 冲突/缺失判定。runtime 中立：只搬运中立字段，
不含 runtime 原生格式（D16；红线：不配置 runtime 非中立）。
"""

from __future__ import annotations

from shared.contracts.enums import EnterpriseRole
from shared.contracts.snapshot import ModelPolicy, RuntimePolicy
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, Forbidden, NotFound
from shared.db import PgTenantRouter

from .employee_config_repository import EmployeeConfigRepository, EmployeeConfigRow
from .schemas import EmployeeConfigIn, EmployeeConfigOut

# 配置写操作允许的企业角色（03 §9.7）。Member 只读（由 routes 层 authorize 强制）。
_CONFIG_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


class EmployeeConfigService:
    """employee 配置 CRUD 编排。tenant_id 全程经 TenantContext，不手写过滤（D22）。"""

    def __init__(self, repo: EmployeeConfigRepository):
        self._repo = repo

    def create(self, ctx: TenantContext, body: EmployeeConfigIn, *, employee_slug: str) -> EmployeeConfigOut:
        _ensure_can_write(ctx)
        if self._repo.get_by_slug(ctx, employee_slug=employee_slug) is not None:
            raise Conflict("employee slug already exists in this tenant")
        row = self._repo.create(
            ctx,
            employee_slug=employee_slug,
            display_name=body.display_name,
            persona=body.persona,
            model=body.model_policy.model,
            provider_ref=body.model_policy.provider_ref,
            thinking_level=body.model_policy.thinking_level,
            runtime_binding=body.runtime_policy.runtime_binding,
            timeout_seconds=body.runtime_policy.timeout_seconds,
            tools=body.tools,
            skills=body.skills,
            knowledge_refs=body.knowledge_refs,
            connector_refs=body.connector_refs,
            memory_policy=body.memory_policy,
        )
        return _to_out(row)

    def get(self, ctx: TenantContext, *, employee_id: str) -> EmployeeConfigOut:
        row = self._require(ctx, employee_id)
        return _to_out(row)

    def update(self, ctx: TenantContext, body: EmployeeConfigIn, *, employee_id: str) -> EmployeeConfigOut:
        _ensure_can_write(ctx)
        if self._require(ctx, employee_id) is None:
            raise NotFound("employee not found in this tenant")
        row = self._repo.update(
            ctx,
            employee_id=employee_id,
            display_name=body.display_name,
            persona=body.persona,
            model=body.model_policy.model,
            provider_ref=body.model_policy.provider_ref,
            thinking_level=body.model_policy.thinking_level,
            runtime_binding=body.runtime_policy.runtime_binding,
            timeout_seconds=body.runtime_policy.timeout_seconds,
            tools=body.tools,
            skills=body.skills,
            knowledge_refs=body.knowledge_refs,
            connector_refs=body.connector_refs,
            memory_policy=body.memory_policy,
        )
        if row is None:  # 双保险：RLS 下跨 tenant 删除/不可见
            raise NotFound("employee not found in this tenant")
        return _to_out(row)

    def delete(self, ctx: TenantContext, *, employee_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, employee_id=employee_id):
            raise NotFound("employee not found in this tenant")

    def transition(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        transition: str,
        archive_reason: str | None = None,
    ) -> EmployeeConfigOut:
        """经状态机校验 + 行锁落库，返回更新后 EmployeeConfigOut。

        - 非 owner/enterprise_admin → 403（同配置写）
        - 跨 tenant 不可见 → 404
        - 状态冲突（预期状态 != 当前状态）→ 409
        - 非法 transition（状态机）→ 409
        - archived 后配置写 → 已在前置 _ensure_can_write_and_not_archived 禁掉
        """
        _ensure_can_write(ctx)
        row = self._require(ctx, employee_id)
        from_s = EmployeeStatus(row.status)
        if not can_write_config(from_s) and transition != "archive":
            raise Forbidden("archived employee cannot be modified")
        to_s = target_status(from_s, transition)  # 非法 transition → Conflict
        updated = self._repo.transition_status(
            ctx,
            employee_id=employee_id,
            from_status=from_s.value,
            to_status=to_s.value,
            archive_reason=archive_reason,
        )
        if updated is None:
            raise NotFound("employee not found in this tenant")
        return _to_out(updated)

    def list_all(self, ctx: TenantContext) -> list[EmployeeConfigOut]:
        return [_to_out(r) for r in self._repo.list_all(ctx)]

    def _require(self, ctx: TenantContext, employee_id: str) -> EmployeeConfigRow:
        row = self._repo.get(ctx, employee_id=employee_id)
        if row is None:
            raise NotFound("employee not found in this tenant")
        return row


def _ensure_can_write(ctx: TenantContext) -> None:
    """配置写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_CONFIG_WRITE_ROLES):
        raise Forbidden("config write requires owner or enterprise_admin")


def _to_out(row: EmployeeConfigRow) -> EmployeeConfigOut:
    return EmployeeConfigOut(
        employee_id=row.employee_id,
        employee_slug=row.employee_slug,
        display_name=row.display_name,
        persona=row.persona,
        model_policy=ModelPolicy(model=row.model, provider_ref=row.provider_ref, thinking_level=row.thinking_level),
        runtime_policy=RuntimePolicy(runtime_binding=row.runtime_binding, timeout_seconds=row.timeout_seconds),
        tools=row.tools,
        skills=row.skills,
        knowledge_refs=row.knowledge_refs,
        connector_refs=row.connector_refs,
        memory_policy=row.memory_policy,
        version=row.version,
        status=row.status,
        archive_reason=row.archive_reason,
        archived_at=row.archived_at,
    )


def build_employee_config_service(router: PgTenantRouter) -> EmployeeConfigService:
    return EmployeeConfigService(EmployeeConfigRepository(router))


# ---- 生命周期便捷查询（供前端/Agent 运行前检查）----

def employee_runnable(row: EmployeeConfigRow) -> bool:
    return is_runnable(EmployeeStatus(row.status))


def employee_provisionable(row: EmployeeConfigRow) -> bool:
    return is_provisionable(EmployeeStatus(row.status))

