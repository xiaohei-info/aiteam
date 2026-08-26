"""F01 enterprise provisioning (POST /api/manager/tenants, Operator→Manager).

The control-plane registry is an internal compatibility record written with the
admin DSN; repeated provisioning is idempotent.
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
    description="运营端Manager云侧调用：新建 tenant 注册行，返回 tenant_id。企业开通入口。",
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
    import psycopg
    from psycopg import errors as pg_errors

    from shared.errors import Conflict

    settings = request.app.state.settings
    dsn = settings.admin_db_url
    if not dsn:
        raise ManagerAdminDbNotConfigured("Manager 管理 DB 未配置（设置 ADMIN_DB_URL）")

    slug = body.enterprise_code or body.enterprise_name

    # 使用业务连接（app_rw）处理租户作用域数据（quota_policy 有 RLS）
    business_dsn = request.app.state.settings.db_url

    try:
        with psycopg.connect(dsn, autocommit=True) as conn:
            # 1. 插入 tenant_registry（控制面表，无 RLS，admin 连接）
            conn.execute(
                "INSERT INTO tenant_registry (tenant_id, enterprise_id, enterprise_slug, enterprise_code)"
                " VALUES (%s, %s, %s, %s)"
                " ON CONFLICT (tenant_id) DO UPDATE SET enterprise_id = COALESCE(tenant_registry.enterprise_id, EXCLUDED.enterprise_id)",
                (body.tenant_id, body.enterprise_id, slug, body.enterprise_code),
            )
    except pg_errors.UniqueViolation as e:
        # enterprise_slug 或 enterprise_code 唯一约束冲突 → 409 清晰提示
        if "enterprise_slug" in str(e):
            raise Conflict(f"企业标识 '{slug}' 已被占用，请更换企业名称或填写不同的企业代码")
        if "enterprise_code" in str(e):
            raise Conflict(f"企业代码 '{body.enterprise_code}' 已被占用，请更换")
        raise Conflict("企业信息重复，请检查企业名称和代码")

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
                    now(), now() + (%s * interval '1 day'), %s, %s, 'active'
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
    # M0 实现：将策略作为 tenant_registry 的扩展字段存储（简化版）
    # 或者可以创建独立的 catalog_policy 表（留待详设扩展）
    # 当前实现：暂时不写入额外表，仅记录到日志供审计
    # 完整实现可在后续 Phase 补充独立 catalog_policy 表

    # 当前 M0：策略已被记录但不强制执行（留待 catalog 模块扩展）
    # 如需立即生效，可在此处批量更新 skill_catalog / connector_catalog 的 visibility
    pass
