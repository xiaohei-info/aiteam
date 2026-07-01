"""employee_prompt 版本管理业务编排（issue #303，06 §7.6，D16/D22）。

编排 repository（租户隔离）+ 冲突/缺失判定 + 版本历史 + 回滚。
runtime 中立：只搬运中立字段，不含 runtime 原生格式（D16；红线：不配置 runtime 非中立）。
"""

from __future__ import annotations

from shared.contracts.enums import EnterpriseRole
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict, Forbidden, NotFound

from .employee_prompt_repository import (
    EmployeePromptHistoryRow,
    EmployeePromptRepository,
    EmployeePromptRow,
)
from .schemas import (
    EmployeePromptHistoryOut,
    EmployeePromptIn,
    EmployeePromptOut,
    EmployeePromptRollbackIn,
)

# 配置写操作允许的企业角色（03 §9.7）。Member 只读（由 routes 层 authorize 强制）。
_PROMPT_WRITE_ROLES = [
    EnterpriseRole.OWNER.value,
    EnterpriseRole.ENTERPRISE_ADMIN.value,
]


class EmployeePromptService:
    """employee_prompt CRUD + 版本历史 + 回滚编排。tenant_id 全程经 TenantContext，不手写过滤（D22）。"""

    def __init__(self, repo: EmployeePromptRepository):
        self._repo = repo

    def get(self, ctx: TenantContext, *, employee_id: str) -> EmployeePromptOut:
        row = self._require(ctx, employee_id)
        return _row_to_out(row)

    def create(self, ctx: TenantContext, body: EmployeePromptIn, *, employee_id: str) -> EmployeePromptOut:
        """建 employee_prompt head（version=1 同时写 version=1 的历史）。已存在 → Conflict。"""
        _ensure_can_write(ctx)
        if self._repo.get(ctx, employee_id=employee_id) is not None:
            raise Conflict("employee prompt already exists; use update instead")
        row = self._repo.create(
            ctx,
            employee_id=employee_id,
            system_prompt=body.system_prompt,
            behavior_rules=body.behavior_rules_json,
            opening_message=body.opening_message,
            source_template_version=body.source_template_version,
            change_reason=body.change_reason,
            changed_by=ctx.user_id,
        )
        return _row_to_out(row)

    def update(self, ctx: TenantContext, body: EmployeePromptIn, *, employee_id: str) -> EmployeePromptOut:
        """改写 prompt：归档当前 head 到历史 + 推进 version_no。头不存在 → NotFound。"""
        _ensure_can_write(ctx)
        if self._repo.get(ctx, employee_id=employee_id) is None:
            raise NotFound("employee prompt not found in this tenant")
        row = self._repo.update(
            ctx,
            employee_id=employee_id,
            system_prompt=body.system_prompt,
            behavior_rules=body.behavior_rules_json,
            opening_message=body.opening_message,
            source_template_version=body.source_template_version,
            change_reason=body.change_reason,
            changed_by=ctx.user_id,
        )
        if row is None:  # 双保险：RLS 下跨 tenant 删除/不可见
            raise NotFound("employee prompt not found in this tenant")
        return _row_to_out(row)

    def delete(self, ctx: TenantContext, *, employee_id: str) -> None:
        _ensure_can_write(ctx)
        if not self._repo.delete(ctx, employee_id=employee_id):
            raise NotFound("employee prompt not found in this tenant")

    def list_history(self, ctx: TenantContext, *, employee_id: str) -> list[EmployeePromptHistoryOut]:
        """列本 tenant 内 employee prompt 全部历史版本（version_no 降序）。"""
        rows = self._repo.list_history(ctx, employee_id=employee_id)
        return [_history_to_out(r) for r in rows]

    def rollback(
        self, ctx: TenantContext, body: EmployeePromptRollbackIn, *, employee_id: str
    ) -> EmployeePromptOut:
        """回滚到历史版本 `body.target_version_no`：写为新 head（version_no +1）。"""
        _ensure_can_write(ctx)
        if self._repo.get(ctx, employee_id=employee_id) is None:
            raise NotFound("employee prompt not found in this tenant")
        target = body.target_version_no
        if self._repo.get_history(ctx, employee_id=employee_id, version_no=target) is None:
            raise NotFound(f"prompt version {target} not found for this employee")
        row = self._repo.rollback(
            ctx,
            employee_id=employee_id,
            target_version_no=target,
            change_reason=body.change_reason,
            changed_by=ctx.user_id,
        )
        if row is None:
            raise NotFound("employee prompt not found in this tenant")
        return _row_to_out(row)

    def _require(self, ctx: TenantContext, employee_id: str) -> EmployeePromptRow:
        row = self._repo.get(ctx, employee_id=employee_id)
        if row is None:
            raise NotFound("employee prompt not found in this tenant")
        return row


def _ensure_can_write(ctx: TenantContext) -> None:
    """配置写操作鉴权（03 §9.7）。非 owner/enterprise_admin → 403。"""
    if not set(ctx.roles) & set(_PROMPT_WRITE_ROLES):
        raise Forbidden("config write requires owner or enterprise_admin")


def _row_to_out(row: EmployeePromptRow) -> EmployeePromptOut:
    return EmployeePromptOut(
        employee_id=row.employee_id,
        system_prompt=row.system_prompt,
        behavior_rules_json=row.behavior_rules,
        opening_message=row.opening_message,
        version_no=row.version_no,
        source_template_version=row.source_template_version,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _history_to_out(row: EmployeePromptHistoryRow) -> EmployeePromptHistoryOut:
    return EmployeePromptHistoryOut(
        history_id=row.history_id,
        employee_id=row.employee_id,
        system_prompt=row.system_prompt,
        behavior_rules_json=row.behavior_rules,
        opening_message=row.opening_message,
        version_no=row.version_no,
        source_template_version=row.source_template_version,
        change_reason=row.change_reason,
        changed_by=row.changed_by,
        created_at=row.created_at,
    )


def build_employee_prompt_service(router: PgTenantRouter) -> EmployeePromptService:
    return EmployeePromptService(EmployeePromptRepository(router))
