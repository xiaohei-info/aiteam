"""发布范围对账的装配与触发点（Request / 通知 → ScopeReconciler）。

触发：① Operator 的目录变更通知（逐 tenant 遍历）；② 管理员打开人才市场 / 专家列表时对本 tenant 兜底。
任何失败只记日志，绝不影响主请求。
"""

from __future__ import annotations

import logging

from fastapi import Request

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

from .catalog_scope_reconciler import ScopeReconciler
from .employee_config_repository import EmployeeConfigRepository
from .in_app_notification_repository import InAppNotificationRepository
from .in_app_notification_service import InAppNotificationService
from .usage_delivery_service import _list_manager_tenants

logger = logging.getLogger(__name__)
_ADMIN_ROLES = {"owner", "enterprise_admin"}


def build_reconciler(request: Request) -> ScopeReconciler | None:
    settings = request.app.state.settings
    catalog = getattr(request.app.state, "_operator_catalog", None)
    if not settings.db_url or catalog is None:
        return None
    router = PgTenantRouter(settings.db_url)
    notifier = InAppNotificationService(InAppNotificationRepository(router))
    return ScopeReconciler(catalog, EmployeeConfigRepository(router), notifier)


def reconcile_for_admin(request: Request, ctx: TenantContext, *, visible_ids: set[str] | None = None) -> None:
    """管理员打开人才市场 / 专家列表时的兜底对账；非管理员不触发。"""
    if not set(ctx.roles) & _ADMIN_ROLES:
        return
    try:
        # 对账会写员工状态并发通知：企业不可用（含暂停只读）时不做。
        from .tenant_status import ACTIVE

        store = getattr(request.app.state, "_tenant_status_store", None)
        if store is not None and store.get(ctx.tenant_id) != ACTIVE:
            return
        reconciler = build_reconciler(request)
        if reconciler is not None:
            reconciler.reconcile(ctx, visible_ids=visible_ids)
    except Exception:  # noqa: BLE001
        logger.warning("scope reconcile (on read) failed", exc_info=True)


def reconcile_all_tenants(request: Request, template_id: str) -> None:
    """目录通知触发：按 tenant_registry 逐个 tenant 在各自 TenantContext 内对账（不跨租户查询）。"""
    settings = request.app.state.settings
    if not settings.admin_db_url:
        return
    try:
        reconciler = build_reconciler(request)
        if reconciler is None:
            return
        after: str | None = None
        while True:
            tenants = _list_manager_tenants(settings.admin_db_url, after=after)
            if not tenants:
                return
            for tenant_id in tenants:
                try:
                    reconciler.reconcile(
                        TenantContext(tenant_id=tenant_id, user_id="catalog-scope-reconciler", roles=[]),
                        template_id=template_id,
                    )
                except Exception:  # noqa: BLE001
                    logger.warning("scope reconcile failed for tenant %s", tenant_id, exc_info=True)
            after = tenants[-1]
    except Exception:  # noqa: BLE001
        logger.warning("scope reconcile sweep failed", exc_info=True)
