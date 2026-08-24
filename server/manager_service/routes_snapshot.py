"""执行快照生成北向路由（M7，05 F11/F16 / 04 §6.2/§6.3，D5/D22）。

路径：/api/manager/snapshots（POST，生成只读快照）。Agent→Manager 主动拉取，用户端本地冻结。
- 只读派生：本端点只「按 employee_id+version 生成只读快照」，不改 employee/专家主数据（D5 红线）。
- 成员级授权：service 层按 member_grant 校验（04 §6.2 / 05 F16），无授权 → 403。
- 受保护端点（require_claims）；强制 body.member_id == claims.user_id（防止填他人 member_id 代拉）。
- 只读可幂等：同 (employee_id, version) 多次拉取得同一 snapshot_version 与内容（05 §5.1）。
- 统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）；tenant_id 经 TenantContext（D22）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import SnapshotPullRequest, SnapshotPullResponse
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import AppError, Forbidden

from .employee_config_service import build_employee_config_service
from .enterprise_audit_repository import build_enterprise_audit_repository
from .employee_bindings_repositories import EmployeeKnowledgeBindingRepository
from .member_service import GrantService, MemberDeptService
from .repository_member import GrantRepository, MemberDeptRepository
from .snapshot_service import SnapshotService, build_snapshot_service


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> SnapshotService:
    """构造 SnapshotService（复用 employee 配置 + 成员/授权只读服务 + 越权审计写入口）；
    未配置业务 DB → 503。

    快照授权读路径（get_member / list_grants）+ 越权审计写（enterprise_audit）全部走业务连接
    app_rw（db_url）；不构造 AuthService、不耦合签名私钥库（admin DSN）——授权/审计均无需 auth（D22）。
    """
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    cache = getattr(request.app.state, "_snapshot_service", None)
    if cache is None:
        router = PgTenantRouter(dsn)
        member_repo = MemberDeptRepository(router)
        grant_repo = GrantRepository(router)
        cache = build_snapshot_service(
            config_service=build_employee_config_service(router),
            grant_service=GrantService(repo=grant_repo, members=member_repo),
            member_service=MemberDeptService(repo=member_repo),
            audit_recorder=build_enterprise_audit_repository(router),
            knowledge_binding=EmployeeKnowledgeBindingRepository(router),
            platform_catalog=request.app.state._operator_catalog,
        )
        request.app.state._snapshot_service = cache
    return cache


def build_snapshot_router(verifier) -> APIRouter:
    """构造执行快照路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager/snapshots", tags=["manager", "snapshot"])
    require = require_claims(verifier)

    @router.post(
        "", summary="生成 employee/expert 执行快照（只读投影 + 成员级授权，D5/F16）",
        description="Agent 主动拉取执行快照：取当前 employee 配置 + 成员级授权冻结为只读快照。",
        operation_id="manager_snapshot_generate",
    )
    async def generate_snapshot(
        body: SnapshotPullRequest,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[SnapshotPullResponse]:
        # 只能为自己拉快照——禁止填他人 member_id 代拉（03 §9.7 鉴权②，授权权威在 Manager）。
        if body.member_id != claims.user_id:
            raise Forbidden("member_id must match the authenticated subject")
        svc = _service(request)
        snapshot = svc.generate(
            tenant_context_from(claims),
            member_id=body.member_id,
            employee_id=body.employee_id,
            employee_version=body.employee_version,
        )
        signer = getattr(request.app.state, "_skill_signer", None)
        if signer is not None:
            # Snapshot carries verification metadata only; private key material stays in Manager.
            snapshot = snapshot.model_copy(update={"skill_signing_keys": signer.public_metadata()})
        return Envelope[SnapshotPullResponse](data=SnapshotPullResponse(snapshot=snapshot))

    return router
