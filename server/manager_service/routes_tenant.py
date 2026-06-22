"""F01 企业开通收端（POST /api/manager/tenants，Operator→Manager 云侧调用，05 §5.1 D4）。

控制面写：tenant_registry 无 RLS，走管理连接（admin DSN），不经 app_rw 业务连接。
幂等：ON CONFLICT (tenant_id) DO NOTHING，重复调用返回 201。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from shared.contracts.crosstier import TenantProvisionRequest
from shared.contracts.envelope import Envelope
from shared.service_token import verify_service_token

from .exceptions import ManagerAdminDbNotConfigured

router = APIRouter(tags=["manager", "control-plane"])


@router.post(
    "/api/manager/tenants",
    summary="F01 企业开通——建 tenant_registry 行（Operator→Manager 云侧调用）",
    operation_id="manager_provision_tenant",
    status_code=status.HTTP_201_CREATED,
)
def provision_tenant(
    body: TenantProvisionRequest,
    request: Request,
    _svc=Depends(verify_service_token),  # 服务间认证守卫（平面③ 代码层，03 §9.1）
) -> Envelope[dict]:
    """同步路由（def）：psycopg 同步驱动，FastAPI 自动 run in threadpool，不阻塞事件循环。

    TODO(05 §5.1 D4)：initial_quota_policy / visible_catalog_policy 暂不处理，
    预留给后续配额/目录策略模块（Phase 3）实现。
    """
    import psycopg

    dsn = request.app.state.settings.admin_db_url
    if not dsn:
        raise ManagerAdminDbNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")

    slug = body.enterprise_code or body.enterprise_name
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO tenant_registry (tenant_id, enterprise_slug, enterprise_code)"
            " VALUES (%s, %s, %s)"
            " ON CONFLICT (tenant_id) DO NOTHING",
            (body.tenant_id, slug, body.enterprise_code),
        )
    return Envelope[dict](data={"tenant_id": body.tenant_id})
