"""发布范围对账（R3）：模板对本企业不再可见 → 停用相关员工；重新可见 → 自动恢复。

真相来自 Operator 目录拉取（带 tenant）；本模块只改本 tenant 内员工的 status / status_reason，
不跨租户、不绕过 RLS。对账按“期望状态”逐个条件更新，重复执行是幂等的（不会重复停用、重复通知）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict

from .employee_config_repository import EmployeeConfigRepository, EmployeeConfigRow
from .operator_catalog import OperatorCatalogPort, is_out_of_scope

logger = logging.getLogger(__name__)

REVOKED = "catalog_scope_revoked"
REVOKED_KEEP_PAUSED = "catalog_scope_revoked_keep_paused"
_REASONS = {REVOKED, REVOKED_KEEP_PAUSED}


class TemplateOutOfScopeConflict(Conflict):
    """员工来源模板已不在本企业发布范围内：不能启用 / 复制。"""

    code = "template_out_of_scope"


def is_scope_blocked(row: EmployeeConfigRow) -> bool:
    return (row.status_reason or "") in _REASONS


@dataclass
class ScopeReconcileResult:
    disabled: list[str] = field(default_factory=list)
    restored: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.disabled or self.restored)


class ScopeReconciler:
    def __init__(self, catalog: OperatorCatalogPort, employees: EmployeeConfigRepository, notifier=None):
        self._catalog = catalog
        self._employees = employees
        self._notifier = notifier

    def reconcile(
        self, ctx: TenantContext, *, template_id: str | None = None, visible_ids: set[str] | None = None,
    ) -> ScopeReconcileResult:
        """对账本 tenant。任何目录拉取失败都放弃本次对账（不改任何员工），由下次触发兜底。"""
        result = ScopeReconcileResult()
        rows = [
            r for r in self._employees.list_all(ctx)
            if r.source_template_id and r.status != "archived"
            and (template_id is None or r.source_template_id == template_id)
        ]
        if not rows:
            return result
        try:
            states = self._template_states(ctx, {r.source_template_id or "" for r in rows}, visible_ids)
        except Exception:  # noqa: BLE001
            logger.warning("scope reconcile skipped: catalog unavailable", exc_info=True)
            return result

        for row in rows:
            self._apply(ctx, row, states.get(row.source_template_id or "", "unknown"), result)
        if result.changed:
            self._notify(ctx, result)
        return result

    def _template_states(self, ctx: TenantContext, wanted: set[str], visible_ids: set[str] | None) -> dict[str, str]:
        if visible_ids is None:
            visible_ids = {t.template_id for t in self._catalog.list_expert_templates(tenant_id=ctx.tenant_id)}
        states = {tid: "visible" for tid in wanted & visible_ids}
        for tid in wanted - visible_ids:
            try:
                self._catalog.pull_expert_template(template_id=tid, tenant_id=ctx.tenant_id)
                states[tid] = "visible"
            except Exception as exc:  # noqa: BLE001
                if is_out_of_scope(exc):
                    states[tid] = "hidden"
                elif getattr(exc, "status", None) == 404:
                    states[tid] = "unknown"  # 已下架 / 不存在：不属于范围问题，不动员工
                else:
                    raise
        return states

    def _apply(self, ctx: TenantContext, row: EmployeeConfigRow, state: str, result: ScopeReconcileResult) -> None:
        reason = row.status_reason
        if state == "hidden" and not reason:
            target = ("paused", REVOKED) if row.status == "active" else (row.status, REVOKED_KEEP_PAUSED)
            if self._employees.set_scope_state(
                ctx, employee_id=row.employee_id, expect_status=row.status, expect_reason=None,
                new_status=target[0], new_reason=target[1],
            ):
                result.disabled.append(row.display_name)
        elif state == "visible" and reason in _REASONS:
            back = reason == REVOKED and row.status == "paused"
            if self._employees.set_scope_state(
                ctx, employee_id=row.employee_id, expect_status=row.status, expect_reason=reason,
                new_status="active" if back else row.status, new_reason=None,
            ) and back:
                result.restored.append(row.display_name)

    def _notify(self, ctx: TenantContext, result: ScopeReconcileResult) -> None:
        if self._notifier is None:
            return
        parts = []
        if result.disabled:
            parts.append("因模板发布范围调整，以下专家已停用：" + "、".join(result.disabled))
        if result.restored:
            parts.append("发布范围恢复，以下专家已自动恢复：" + "、".join(result.restored))
        try:
            self._notifier.deliver_internal(
                ctx, message="；".join(parts) + "。", notify_type="catalog_scope",
                severity="warning" if result.disabled else "info",
            )
        except Exception:  # noqa: BLE001
            logger.warning("scope reconcile notification failed", exc_info=True)
