"""招募专家 / 应用方案北向路由（M6，02 §10.1/§10.3 + 05 F06/F07，D12）。

路径：/api/manager/recruit/*。受保护端点（require_claims）；写操作需 owner/enterprise_admin。
统一 envelope（02 §10.3.4）+ problem+json（02 §11.2）。tenant_id 经 TenantContext（D22）。

Operator 目录拉取端口注入：本卡 Operator 侧先 mock——app 持 `FakeOperatorCatalogClient`
（app.state._operator_catalog），生产接入真实 OperatorCatalogClient 后无侵入替换。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.crosstier import ExpertTemplateDetail, SolutionPackage
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.db import PgTenantRouter
from shared.errors import AppError

from .operator_catalog import OperatorCatalogPort
from .recruit_service import RecruitService, build_recruit_service
from .schemas import (
    ApplySolutionRequest,
    ApplySolutionResult,
    RecruitExpertRequest,
    RecruitExpertResult,
    RecruitmentOrderOut,
    SolutionApplyRecordOut,
    SolutionInstanceOut,
)


class _ManagerNotConfigured(AppError):
    status, code, title = 503, "manager_db_unconfigured", "Manager DB Unconfigured"


def _service(request: Request) -> RecruitService:
    """从端配置构造 RecruitService；未配置业务 DB → 503（不静默，与 employee/auth 路由一致）。

    catalog 从 app.state 取（编排注入 FakeOperatorCatalogClient；生产真实实现）——本卡 Operator 先 mock。
    """
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _ManagerNotConfigured("Manager 业务 DB 未配置（设置 DB_URL）")
    catalog: OperatorCatalogPort = request.app.state._operator_catalog
    cache = getattr(request.app.state, "_recruit_service", None)
    if cache is None:
        cache = build_recruit_service(catalog=catalog, router=PgTenantRouter(dsn))
        request.app.state._recruit_service = cache
    return cache


def build_recruit_router(verifier) -> APIRouter:
    """构造招募/应用方案路由；verifier 由 app 持有并闭包注入受保护端点。"""
    router = APIRouter(prefix="/api/manager/recruit", tags=["manager", "recruit-solution"])
    require = require_claims(verifier)

    @router.get(
        "/catalog/experts", description="请查看接口名称了解用途", summary="F06 浏览可招募专家模板（拉 Operator 目录列表，只读）",
        operation_id="manager_list_recruitable_experts",
    )
    async def list_recruitable_experts(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[ExpertTemplateDetail]:
        # 浏览是纯 Operator 目录只读（不碰租户 DB）；catalog 端口由 app.state 注入。
        catalog: OperatorCatalogPort = request.app.state._operator_catalog
        return ListEnvelope[ExpertTemplateDetail](data=catalog.list_expert_templates())

    @router.get(
        "/catalog/solutions", description="请查看接口名称了解用途", summary="F07 浏览可应用行业方案（拉 Operator 目录列表，只读）",
        operation_id="manager_list_recruitable_solutions",
    )
    async def list_recruitable_solutions(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[SolutionPackage]:
        catalog: OperatorCatalogPort = request.app.state._operator_catalog
        return ListEnvelope[SolutionPackage](data=catalog.list_solution_packages())

    @router.post(
        "/experts", description="请查看接口名称了解用途", summary="F06 招募专家（拉 Operator 模板 → 落本 tenant employee 实例）",
        operation_id="manager_recruit_expert", status_code=status.HTTP_201_CREATED,
    )
    async def recruit_expert(
        body: RecruitExpertRequest,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[RecruitExpertResult]:
        svc = _service(request)
        return Envelope[RecruitExpertResult](
            data=svc.recruit_expert(tenant_context_from(claims), body)
        )

    @router.post(
        "/solutions", description="请查看接口名称了解用途", summary="F07 应用方案（拉 Operator 方案包 → 展开 employee + 授权）",
        operation_id="manager_apply_solution", status_code=status.HTTP_201_CREATED,
    )
    async def apply_solution(
        body: ApplySolutionRequest,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[ApplySolutionResult]:
        svc = _service(request)
        return Envelope[ApplySolutionResult](
            data=svc.apply_solution(tenant_context_from(claims), body)
        )

    @router.get(
        "/solutions", description="请查看接口名称了解用途", summary="列本租户方案实例（按 tenant 裁剪）",
        operation_id="manager_list_solution_instances",
    )
    async def list_solution_instances(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[SolutionInstanceOut]:
        svc = _service(request)
        return ListEnvelope[SolutionInstanceOut](
            data=svc.list_solution_instances(tenant_context_from(claims))
        )

    @router.get(
        "/solutions/{instance_id}", description="请查看接口名称了解用途", summary="方案实例详情（按 tenant 裁剪）",
        operation_id="manager_get_solution_instance",
    )
    async def get_solution_instance(
        instance_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[SolutionInstanceOut]:
        svc = _service(request)
        return Envelope[SolutionInstanceOut](
            data=svc.get_solution_instance(
                tenant_context_from(claims), instance_id=instance_id
            )
        )

    @router.get(
        "/orders",
        description="请查看接口名称了解用途",
        summary="列本租户招募订单（追踪异步招募链路）",
        operation_id="manager_list_recruit_orders",
    )
    async def list_recruit_orders(
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[RecruitmentOrderOut]:
        svc = _service(request)
        return ListEnvelope[RecruitmentOrderOut](
            data=svc.list_recruit_orders(tenant_context_from(claims))
        )

    @router.get(
        "/orders/{order_id}",
        description="请查看接口名称了解用途",
        summary="招募订单详情（按 tenant 裁剪）",
        operation_id="manager_get_recruit_order",
    )
    async def get_recruit_order(
        order_id: str,
        request: Request,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[RecruitmentOrderOut]:
        svc = _service(request)
        return Envelope[RecruitmentOrderOut](
            data=svc.get_recruit_order(tenant_context_from(claims), order_id=order_id)
        )

    @router.get(
        "/solutions/{solution_id}/apply-records", description="请查看接口名称了解用途",
        summary="列本租户某方案的应用记录（审计追溯 who/when/version + 落地专家，AITEAM-242）",
        operation_id="manager_list_solution_apply_records",
    )
    async def list_solution_apply_records(
        solution_id: str,
        request: Request,
        status: str | None = None,
        claims: TokenClaims = Depends(require),
    ) -> ListEnvelope[SolutionApplyRecordOut]:
        svc = _service(request)
        return ListEnvelope[SolutionApplyRecordOut](
            data=svc.list_solution_apply_records(
                tenant_context_from(claims), solution_id=solution_id, status=status,
            )
        )

    return router
