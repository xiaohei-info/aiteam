"""企业端 FastAPI 应用骨架。业务路由由 Track M 工单（11 §4）逐步填入。"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from shared.app_factory import create_app, mount_frontend
from shared.auth import DynamicRS256TokenVerifier, RejectingTokenVerifier, require_claims
from shared.config import load_settings
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope

from .keys import TenantKeyStore
from .routes_auth import router as auth_router
from .routes_bootstrap import router as bootstrap_router
from .routes_catalog_notify import router as catalog_notify_router
from .routes_capability import build_capability_router
from .routes_skill_market import build_skill_market_router
from .routes_employee import build_employee_router
from .routes_employee_bindings import build_employee_bindings_router
from .routes_employee_prompt import build_employee_prompt_router
from .routes_grants import router as grants_router
from .routes_knowledge_space import build_knowledge_space_router
from .routes_knowledge_intake import build_knowledge_intake_router
from .routes_member import router as member_router
from .routes_provider import build_provider_credential_router
from .routes_recruit import build_recruit_router
from .routes_snapshot import build_snapshot_router
from .routes_tenant import router as tenant_router
from .routes_usage_audit_quota import build_usage_audit_quota_router
from .routes_billing import build_billing_router
from .routes_llm import build_llm_router
from .routes_memory_items import build_memory_items_router
from .routes_hindsight import build_hindsight_router
from .hindsight_client import HindsightSettings
from .routes_connector_ops import build_connector_ops_router
from .routes_org import build_org_router
from .routes_settings import build_settings_router
from .routes_in_app_notification import build_in_app_notification_router
from .routes_collab_audit import build_audit_router
from .routes_mfa import (
    oauth_mgmt_router,
    oauth_router,
    passkey_mgmt_router,
    passkey_router,
)
from .operator_catalog import OperatorCatalogClient
from .skill_signing import SkillPackageSigner
from .employee_config_service import build_employee_config_service
from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .enterprise_audit_repository import build_enterprise_audit_repository
from .knowledge_intake_repository import build_knowledge_intake_repositories
from .knowledge_intake_service import ensure_storage_root, manager_storage_root
from .knowledge_space_repository import KnowledgeSpaceRepository
from .member_service import GrantService, MemberDeptService
from .rag import PgManagerRagService
from .rag_ingestion import LightRagIngestionClient
from .rag_mcp import RagAccessService, LightRagClient, LightRagSettings, build_rag_mcp, install_rag_mcp_lifespan
from .repository_member import GrantRepository, MemberDeptRepository
from .snapshot_service import build_snapshot_service
from shared.db import PgTenantRouter


def _build_operator_catalog():
    """构造 Operator 目录拉取客户端（05 F06/F07，#176）。

    有 operator_url → OperatorCatalogClient（真实 HTTP 客户端）；
    无 operator_url → fail-closed（RuntimeError）：无配置则 Manager 招募路径会写到假数据，静默数据错是
    生产危险；必须显式配置 OPERATOR_URL 才能启动（AITEAM-331 C1）。FakeOperatorCatalogClient 仅
    在测试/中显式注入 app.state._operator_catalog，不再作为隐式 fallback。
    """
    settings = load_settings("manager")
    operator_url = settings.operator_url
    if not operator_url:
        raise RuntimeError(
            "OPERATOR_URL is not configured. Manager recruit routes require a real Operator "
            "to pull expert templates and solution packages. Silently falling back to a "
            "FakeOperatorCatalogClient would risk writing fake catalog data into the tenant DB "
            "(silent data corruption). Set OPERATOR_URL to the Operator base URL."
        )
    # 生产/测试注入路线统一使用真实 HTTP 客户端。FakeOperatorCatalogClient 仅在测试中显式注入。
    return OperatorCatalogClient(
        base_url=operator_url,
        service_identity=settings.service_name,
        service_token=settings.service_token,
    )


def _build_verifier():
    """构造受保护端点验签器（D23 RS256）。

    有 admin_db_url → DynamicRS256TokenVerifier：从 token header kid 解析 tenant_id，
    经 TenantKeyStore（admin 连接）查公钥验签。无 admin_db_url → RejectingTokenVerifier
    恒 401（密钥库未配置不静默放行；dev 无 DB 时受保护端点本就需要 DB 才有意义）。
    """
    settings = load_settings("manager")
    admin_dsn = settings.admin_db_url
    if not admin_dsn:
        return RejectingTokenVerifier("manager signing key store unconfigured (ADMIN_DB_URL)")
    key_store = TenantKeyStore(admin_dsn)
    return DynamicRS256TokenVerifier(key_store.public_pem_for_kid)


_verifier = _build_verifier()

router = APIRouter(prefix="/api/manager", tags=["manager"])


@router.get("/ping", summary="liveness ping（演示 envelope）", operation_id="manager_ping")
async def ping() -> Envelope[dict]:
    return Envelope[dict](data={"pong": True})


@router.get("/whoami", summary="解出当前身份（演示受保护端点 401/200）", operation_id="manager_whoami")
async def whoami(claims: TokenClaims = Depends(require_claims(_verifier))) -> Envelope[TokenClaims]:
    return Envelope[TokenClaims](data=claims)


settings = load_settings("manager")
_skill_signer = SkillPackageSigner.from_env()
if settings.is_production and (_skill_signer is None or not _skill_signer.has_next):
    raise RuntimeError(
        "Production Manager Skill signing requires dedicated current and next Ed25519 keys "
        "(AITEAM_SKILL_SIGNING_PRIVATE_KEY/AITEAM_SKILL_SIGNING_KEY_ID plus "
        "AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY/AITEAM_SKILL_SIGNING_NEXT_KEY_ID)"
    )
app = create_app(settings, router)
app.state._skill_signer = _skill_signer
# 启动即应用控制库迁移（fail-fast；/readyz 绿时 schema 必已就绪）。此前 manager 运行时
# 无任何 apply_migrations 调用，全新部署无法自建控制库（tenant_registry 等表 + app_rw 角色）；
# 由此在服务启动阶段一次性 provision。无 ADMIN_DB_URL 的骨架/测试态 → 内部 no-op（契约不破）。
if settings.admin_db_url:
    from shared.db import apply_migrations as _apply_control_migrations

    _apply_control_migrations(settings.admin_db_url, settings.app_rw_password)
# Hindsight lease metadata is durable whenever both Manager DB boundaries are
# configured.  Cleanup is an admin read/write maintenance operation; issue,
# rotate, and revoke continue to use the app_rw TenantContext path.
if settings.db_url and settings.admin_db_url:
    from .hindsight_lease_repository import HindsightLeaseRepository

    _hindsight_lease_store = HindsightLeaseRepository(
        settings.db_url,
        settings.admin_db_url,
        HindsightSettings.from_env().lease_ttl_seconds,
    )
    _hindsight_lease_store.cleanup_expired()
    app.state._hindsight_lease_store = _hindsight_lease_store
# 受保护端点共享的 token 验签器（挂 app.state 供业务路由引用，03 §9.6）。
app.state._token_verifier = _verifier
# Operator 目录拉取端口（05 F06/F07，#176）。OPERATOR_URL 必填，否则 fail-closed（AITEAM-331 C1）。
app.state._operator_catalog = _build_operator_catalog()
# 认证面（/api/auth/*）：登录/重置/JWKS（03 §9）。与业务路由分前缀挂载。
app.include_router(auth_router)
# employee/expert 配置（/api/manager/employees/*，M2）。verifier 由本端持有闭包注入。
app.include_router(build_employee_router(_verifier))
# employee_prompt 版本管理（/api/manager/employees/{id}/prompts[|/history|/rollback]，issue #303）。verifier 由本端持有闭包注入。
app.include_router(build_employee_prompt_router(_verifier))
# employee 独立绑定实体（skill / knowledge / memory / connector + prompt-version，AITEAM-234/280）。
# verifier 由本端持有闭包注入；tenant_id 经 TenantContext（D22），不手写 tenant 过滤。
app.include_router(build_employee_bindings_router(_verifier))
# 成员/部门/角色（/api/manager/members/* 等，M1）。
app.include_router(member_router)
# member_grant 授权（/api/manager/grants/*，M1）。
app.include_router(grants_router)
# 知识空间/RAG 管理面（/api/manager/knowledge-spaces/*，M3）。verifier 由本端持有闭包注入。
app.include_router(build_knowledge_space_router(_verifier))
# 知识文档 intake 生命周期 + 索引绑定（/api/manager/knowledge-spaces/{id}/documents/* 与 /ingestions/*，issue #416）。verifier 由本端持有闭包注入。
app.include_router(build_knowledge_intake_router(_verifier))
# 技能/连接器/记忆策略 目录（/api/manager/skills|connectors|memory-policies/*，M4）。
app.include_router(build_capability_router(_verifier))
app.include_router(build_skill_market_router(_verifier))
# provider 凭据/AI Relay 管理面（/api/manager/provider-credentials/*，M5）。
app.include_router(build_provider_credential_router(_verifier))
# 招募专家/应用方案（/api/manager/recruit/*，M6，F06/F07，D12）。
app.include_router(build_recruit_router(_verifier))
# usage/audit rollup + 软配额治理（/api/manager/usage/*、/audits、/quota-policies/*，M8）。
app.include_router(build_usage_audit_quota_router(_verifier))
# 执行快照生成（/api/manager/snapshots，M7，05 F11 / D5）。Agent 主动拉取，用户端本地冻结。
app.include_router(build_snapshot_router(_verifier))
# F01/F02 控制面收端（Operator→Manager 云侧调用，05 §5.1 D4）。无 token 校验（服务间调用）。
app.include_router(tenant_router)
app.include_router(bootstrap_router)
app.include_router(catalog_notify_router)
# F17 运营通知企业收端 + 站内信收件箱（Operator→Manager 窄通道 service-token；GET 受保护端点）。
app.include_router(build_in_app_notification_router(_verifier))
# ---- 功能补全：B04/B09 账单工资+充值 ----
app.include_router(build_billing_router(_verifier))
# ---- 功能补全：B01 LLM Provider/Model 管理 ----
app.include_router(build_llm_router(_verifier))
# ---- 功能补全：B07 记忆条目管理 ----
app.include_router(build_memory_items_router(_verifier))
# P1.1 Hindsight runtime lease + Manager facade. The upstream service key stays
# Manager-only because Hindsight 0.12.0 has no native bank-scoped token API.
app.include_router(build_hindsight_router(_verifier))
# ---- 功能补全：B05 连接器测试/状态/grants/预设 ----
app.include_router(build_connector_ops_router(_verifier))
# ---- 功能补全：P07 组织树/部门分配 ----
app.include_router(build_org_router(_verifier))
# ---- 功能补全：B08 企业设置/子管理员邀请 ----
app.include_router(build_settings_router(_verifier))
# ---- 功能补全：审计事件 ----
app.include_router(build_audit_router(_verifier))
app.include_router(passkey_router)
app.include_router(passkey_mgmt_router)
app.include_router(oauth_router)
app.include_router(oauth_mgmt_router)

# Manager-owned read-only RAG MCP facade. It is unavailable (rather than
# bypassed) when the Manager business database is not configured.
if settings.db_url:
    _rag_router = PgTenantRouter(settings.db_url)
    _rag_member_repo = MemberDeptRepository(_rag_router)
    _rag_config = build_employee_config_service(_rag_router)
    _rag_snapshot = build_snapshot_service(
        config_service=_rag_config,
        grant_service=GrantService(repo=GrantRepository(_rag_router), members=_rag_member_repo),
        member_service=MemberDeptService(repo=_rag_member_repo),
        audit_recorder=build_enterprise_audit_repository(_rag_router),
        knowledge_binding=EmployeeKnowledgeBindingRepository(_rag_router),
    )
    _rag_doc_repo, _, _rag_doc_binding = build_knowledge_intake_repositories(_rag_router)
    # Load the static registry once at Manager startup and share that exact
    # immutable routing map between query, ingestion, and workspace derivation.
    _rag_settings = LightRagSettings.from_env()
    _rag_light = LightRagClient(_rag_settings)
    _rag_ingestion = LightRagIngestionClient(
        instance_registry=_rag_settings.instance_registry if _rag_settings is not None else None,
    )
    app.state._knowledge_intake_ingestion_client = _rag_ingestion
    _rag_service = PgManagerRagService(
        settings.db_url,
        instance_registry=_rag_settings.instance_registry if _rag_settings is not None else None,
    )
    _rag_access = RagAccessService(
        snapshot_service=_rag_snapshot,
        member_repository=_rag_member_repo,
        employee_config=_rag_config,
        binding_repository=_rag_doc_binding,
        rag_service=_rag_service,
        light_rag=_rag_light,
        space_repository=KnowledgeSpaceRepository(_rag_router),
        document_repository=_rag_doc_repo,
        storage_root=ensure_storage_root(manager_storage_root(settings)),
    )
    _rag_mcp, _rag_mcp_app = build_rag_mcp(verifier=_verifier, access=_rag_access)
    app.mount("/api/manager/rag", _rag_mcp_app)
    install_rag_mcp_lifespan(app, _rag_mcp, close=_rag_light.aclose)

# 前端静态托管（含 SPA fallback catch-all）必须在所有 API 路由 include 之后最后挂载（#257），
# 否则 catch-all `GET /{full_path:path}` 会遮蔽后注册的 GET API 路由（如 jwks）→ 404。
mount_frontend(app, settings.tier)
