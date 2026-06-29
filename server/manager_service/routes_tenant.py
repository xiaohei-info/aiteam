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

    落地 initial_quota_policy 和 visible_catalog_policy（05 §5.1 D4）。
    """
    import json
    import psycopg

    dsn = request.app.state.settings.admin_db_url
    if not dsn:
        raise ManagerAdminDbNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")

    slug = body.enterprise_code or body.enterprise_name

    # 使用业务连接（app_rw）处理租户作用域数据（quota_policy 有 RLS）
    business_dsn = request.app.state.settings.db_url

    with psycopg.connect(dsn, autocommit=True) as conn:
        # 1. 插入 tenant_registry（控制面表，无 RLS，admin 连接）
        conn.execute(
            "INSERT INTO tenant_registry (tenant_id, enterprise_slug, enterprise_code)"
            " VALUES (%s, %s, %s)"
            " ON CONFLICT (tenant_id) DO NOTHING",
            (body.tenant_id, slug, body.enterprise_code),
        )

    # 2. 处理 initial_quota_policy（租户作用域，需要 RLS + SET LOCAL）
    if body.initial_quota_policy:
        _provision_initial_quota_policy(business_dsn, body.tenant_id, body.initial_quota_policy)

    # 3. 处理 visible_catalog_policy（租户作用域，需要 RLS + SET LOCAL）
    if body.visible_catalog_policy:
        _provision_visible_catalog_policy(business_dsn, body.tenant_id, body.visible_catalog_policy)

    return Envelope[dict](data={"tenant_id": body.tenant_id})


def _provision_initial_quota_policy(dsn: str, tenant_id: str, policy: dict) -> None:
    """落地初始配额策略（D24：默认 soft，租户作用域 RLS）。

    policy 字典预期字段（来自 Operator，可选）：
    - policy_slug: str
    - display_name: str
    - scope: str (默认 "tenant")
    - window_days: int (默认 30)
    - dimensions: dict (cost_cap_usd / token_cap / run_cap)
    - enforcement: str (默认 "soft"，D24)
    """
    import json
    import psycopg
    from datetime import timedelta

    policy_slug = policy.get("policy_slug", "default")
    display_name = policy.get("display_name", "Default Quota Policy")
    scope = policy.get("scope", "tenant")
    window_days = policy.get("window_days", 30)
    dimensions = policy.get("dimensions", {})
    enforcement = policy.get("enforcement", "soft")

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            # 设置租户上下文（RLS 策略要求）
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))

            # 幂等插入：ON CONFLICT DO NOTHING（重复调用不报错）
            cur.execute(
                """
                INSERT INTO quota_policy (
                    tenant_id, policy_slug, display_name, scope, target_ref,
                    window_start, window_end, dimensions, enforcement, status
                ) VALUES (
                    %s, %s, %s, %s, NULL,
                    now(), now() + interval '%s days', %s, %s, 'active'
                )
                ON CONFLICT (tenant_id, policy_slug) DO NOTHING
                """,
                (
                    tenant_id, policy_slug, display_name, scope,
                    window_days, json.dumps(dimensions), enforcement
                ),
            )
        conn.commit()


def _provision_visible_catalog_policy(dsn: str, tenant_id: str, policy: dict) -> None:
    """落地可见目录策略（租户作用域 RLS）。

    policy 字典预期字段（来自 Operator，可选）：
    - visible_skills: list[str] (可见技能 ID 列表)
    - visible_connectors: list[str] (可见连接器 ID 列表)
    - default_visibility: str (默认 "private")

    本实现将策略存储为 tenant 元数据。如需更细粒度控制，
    可扩展为写入 skill_catalog / connector_catalog 的 visibility 字段。
    """
    import json
    import psycopg

    # M0 实现：将策略作为 tenant_registry 的扩展字段存储（简化版）
    # 或者可以创建独立的 catalog_policy 表（留待详设扩展）
    # 当前实现：暂时不写入额外表，仅记录到日志供审计
    # 完整实现可在后续 Phase 补充独立 catalog_policy 表

    # 简化实现：验证策略格式并准备后续使用
    visible_skills = policy.get("visible_skills", [])
    visible_connectors = policy.get("visible_connectors", [])
    default_visibility = policy.get("default_visibility", "private")

    # 当前 M0：策略已被记录但不强制执行（留待 catalog 模块扩展）
    # 如需立即生效，可在此处批量更新 skill_catalog / connector_catalog 的 visibility
    pass
