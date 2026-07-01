"""运营通知企业站内信北向路由（F17，05 §5.1/D4）。

两个端点：
- POST /api/manager/enterprise/notify：Operator 窄通道收端（服务间调用，service-token 校验）。
  由 Operator ManagerGateway.notify_enterprise 触发；在 tenant context 内写入站内信。
- GET  /api/manager/inbox：企业端负责人/成员查看本租户站内信（受保护端点）。

红线：
- Operator 不写 Manager 租户库——仅经窄通道转交消息；Manager 在租户上下文内落库（D22）。
- tenant_id 由 service 调用方在 body 携带，管理局据此构造 TenantContext（agent 主动上报范式同理）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request

from shared.auth import require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import EnterpriseNotifyRequest
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import AppError
from shared.service_token import verify_service_token

from .in_app_notification_repository import InAppNotificationRepository
from .in_app_notification_service import InAppNotificationService
from .schemas import InAppNotificationOut


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _repo(request: Request) -> InAppNotificationRepository:
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_in_app_notification_repo", None)
    if cache is None:
        cache = InAppNotificationRepository(PgTenantRouter(dsn))
        request.app.state._in_app_notification_repo = cache
    return cache


def _service(request: Request) -> InAppNotificationService:
    return InAppNotificationService(_repo(request))


def build_in_app_notification_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager", tags=["manager", "inbox"])
    require = require_claims(verifier)

    # ---- Operator 窄通道收端（F17，service-token 校验，不经 bearer 用户态）----
    @router.post(
        "/enterprise/notify",
        summary="F17 运营通知企业（Operator→Manager 窄通道收端，service-token 校验）",
        description="Operator 经 ManagerGateway 把运营侧消息转交 Manager；Manager 在租户上下文内写入站内信。",
        operation_id="manager_inbox_deliver_from_operation",
    )
    def deliver_from_operation(
        body: EnterpriseNotifyRequest,
        request: Request,
        _svc_token=Depends(verify_service_token),  # 服务间认证守卫（平面③，03 §9.1）
    ) -> Envelope[InAppNotificationOut]:
        """同步路由（def）：psycopg 同步驱动，tenant 数据经 TenantContext（D22）。"""
        if not body.message:
            from shared.errors import ValidationProblem
            raise ValidationProblem("message is required")

        ctx = TenantContext(tenant_id=body.tenant_id, user_id="operation-service", roles=["service"])
        row = _service(request).deliver_from_operation(
            ctx,
            org_id=body.org_id,
            message=body.message,
            notify_type=body.notify_type,
            severity=body.severity,
        )
        return Envelope(data=InAppNotificationOut(
            notification_id=row.notification_id,
            org_id=row.org_id,
            message=row.message,
            notify_type=row.notify_type,
            severity=row.severity,
            read=row.read,
            created_at=row.created_at.isoformat(),
        ))

    # ---- 企业端站内信收件箱（受保护端点）----
    @router.get(
        "/inbox",
        summary="列出本租户站内信（运营通知企业收件箱）",
        operation_id="manager_inbox_list",
    )
    def list_inbox(
        request: Request,
        claims: TokenClaims = Depends(require),
        limit: int | None = Query(default=None, ge=1, le=200, description="返回条数上限（可选）"),
    ) -> ListEnvelope[InAppNotificationOut]:
        ctx = TenantContext(tenant_id=claims.tenant_id, user_id=claims.user_id, roles=claims.roles)
        items = _service(request).list_inbox(ctx, limit=limit)
        return ListEnvelope(data=[InAppNotificationOut(**r) for r in items])

    return router
