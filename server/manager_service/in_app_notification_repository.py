"""运营通知企业站内信的数据访问（F17，04 §6.1.1/D22，05 §5.1）。

表 in_app_notification 由 0015 创建。本仓库存 Operator 经窄通道递送的运营消息，
供企业端负责人/成员在站内信收件箱中查看。

铁律（04 §6.1.3/D22）：tenant_id 只从 TenantContext 读；业务 SQL 不接受调用方手写
tenant 过滤；跨租户因 RLS 不可见。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .idempotency_repository import ManagerIdempotencyRepository

from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter

_COLUMNS = "id, tenant_id, org_id, message, notify_type, severity, read, created_at"


@dataclass(frozen=True)
class InAppNotificationRow:
    notification_id: str
    tenant_id: str
    org_id: str
    message: str
    notify_type: str
    severity: str
    read: bool
    created_at: datetime


def _row_to_notification(row: Any) -> InAppNotificationRow:
    return InAppNotificationRow(
        notification_id=str(row[0]),
        tenant_id=str(row[1]),
        org_id=row[2],
        message=row[3],
        notify_type=row[4],
        severity=row[5],
        read=bool(row[6]),
        created_at=row[7],
    )


class InAppNotificationRepository:
    """运营通知企业站内信的租户内写入/检索。tenant_id 全程经 TenantContext（D22）。"""

    def __init__(self, router: PgTenantRouter):
        self._router = router

    def add(
        self,
        ctx: TenantContext,
        *,
        org_id: str,
        message: str,
        notify_type: str,
        severity: str,
    ) -> InAppNotificationRow:
        """写入一条运营通知（本租户站内信）。tenant_id 取自 ctx（D22，RLS WITH CHECK 兜底）。"""
        with self._router.session(ctx) as s:
            row = s.execute(
                "INSERT INTO in_app_notification "
                "(tenant_id, org_id, message, notify_type, severity) "
                "VALUES (%s, %s, %s, %s, %s) "
                "RETURNING " + _COLUMNS,
                (ctx.tenant_id, org_id, message, notify_type, severity),
            ).fetchone()
        return _row_to_notification(row)

    def add_idempotent(
        self,
        ctx: TenantContext,
        *,
        org_id: str,
        message: str,
        notify_type: str,
        severity: str,
        idempotency_key: str,
        request_fingerprint: str,
    ) -> InAppNotificationRow:
        """Insert the notification and F17 receipt in one tenant transaction."""
        receipts = ManagerIdempotencyRepository(self._router)

        def effect(session):
            row = session.execute(
                "INSERT INTO in_app_notification "
                "(tenant_id, org_id, message, notify_type, severity) "
                "VALUES (%s, %s, %s, %s, %s) RETURNING " + _COLUMNS,
                (ctx.tenant_id, org_id, message, notify_type, severity),
            ).fetchone()
            notification = _row_to_notification(row)
            # The idempotency receipt stores only an opaque row ID.  The
            # notification body remains in its normal tenant-scoped inbox row
            # and is reloaded for both the first response and a replay.
            return {"notification_id": notification.notification_id}

        result = receipts.execute(
            ctx,
            operation="enterprise-notification",
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            effect=effect,
            status_code=200,
        )
        notification_id = str(result.payload["notification_id"])
        notification = self.get(ctx, notification_id)
        if notification is None:
            raise RuntimeError("notification disappeared after idempotent write")
        return notification

    def get(self, ctx: TenantContext, notification_id: str) -> InAppNotificationRow | None:
        """Load one notification through the tenant-scoped inbox projection."""
        with self._router.session(ctx) as s:
            row = s.execute(
                "SELECT " + _COLUMNS + " FROM in_app_notification WHERE id = %s",
                (notification_id,),
            ).fetchone()
        return _row_to_notification(row) if row is not None else None

    def list_all(self, ctx: TenantContext) -> list[InAppNotificationRow]:
        """列本 tenant 内全部站内信（RLS 自动限定），按时间倒序。"""
        with self._router.session(ctx) as s:
            rows = s.execute(
                "SELECT " + _COLUMNS + " FROM in_app_notification ORDER BY created_at DESC"
            ).fetchall()
        return [_row_to_notification(r) for r in rows]


def build_in_app_notification_repository(router: PgTenantRouter) -> InAppNotificationRepository:
    return InAppNotificationRepository(router)
