"""运营通知企业站内信编排（F17，04 §6.1.1/D22，05 §5.1）。

职责：把 Operator 经窄通道递送的运营消息写入租户作用域收件箱（in_app_notification），
供企业端负责人/成员查看；提供本租户站内信检索。

租户隔离：所有读写经 TenantContext（D22），不持本端之外的租户数据。
"""

from __future__ import annotations

from shared.contracts.tenancy import TenantContext

from .idempotency_repository import request_fingerprint
from .in_app_notification_repository import InAppNotificationRepository, InAppNotificationRow


class InAppNotificationService:
    def __init__(self, repo: InAppNotificationRepository):
        self._repo = repo

    def deliver_from_operation(
        self,
        ctx: TenantContext,
        *,
        org_id: str,
        message: str,
        notify_type: str,
        severity: str,
    ) -> InAppNotificationRow:
        """交付一条运营通知到本租户站内信收件箱。由 Operator 窄通道调用触发。"""
        return self._repo.add(
            ctx,
            org_id=org_id,
            message=message,
            notify_type=notify_type,
            severity=severity,
        )

    def deliver_from_operation_idempotent(
        self,
        ctx: TenantContext,
        *,
        org_id: str,
        message: str,
        notify_type: str,
        severity: str,
        idempotency_key: str,
    ) -> InAppNotificationRow:
        """F17 durable replay/conflict path; request body is fingerprinted only."""
        return self._repo.add_idempotent(
            ctx,
            org_id=org_id,
            message=message,
            notify_type=notify_type,
            severity=severity,
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint(
                "enterprise-notification",
                {
                    "tenant_id": ctx.tenant_id,
                    "org_id": org_id,
                    "message": message,
                    "notify_type": notify_type,
                    "severity": severity,
                },
            ),
        )

    def list_inbox(self, ctx: TenantContext, *, limit: int | None = None) -> list[dict]:
        """列出本租户站内信（租户作用域，RLS 限定）。"""
        rows = self._repo.list_all(ctx)
        if limit is not None:
            rows = rows[:limit]
        return [
            {
                "notification_id": r.notification_id,
                "org_id": r.org_id,
                "message": r.message,
                "notify_type": r.notify_type,
                "severity": r.severity,
                "read": r.read,
                "created_at": r.created_at.isoformat(),
            }
            for r in rows
        ]


def build_in_app_notification_service(repo: InAppNotificationRepository) -> InAppNotificationService:
    return InAppNotificationService(repo)
