"""企业端「让模型帮我找」路由（设计 2026-11-20 §4.5）。只返回候选，不安装；用量计入企业 owner。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.db import PgTenantRouter
from shared.errors import ServiceUnavailable

from .capability_assist import AssistRequest, CapabilityAssistService, earliest_owner
from .enterprise_audit_repository import build_enterprise_audit_repository
from .routes_capability import _import_service
from .routes_usage_audit_quota import _lookup_enterprise_id
from .schemas import CapabilityAssistIn, CapabilityAssistOut
from .usage_audit_quota_repository import UsageAuditQuotaRepository


def _assist_service(request: Request) -> CapabilityAssistService:
    injected = getattr(request.app.state, "_capability_assist_service", None)
    if injected is not None:
        return injected
    dsn = request.app.state.settings.db_url
    operator = getattr(request.app.state, "_operator_catalog", None)
    if not dsn or operator is None:
        raise ServiceUnavailable("Manager 未配置业务 DB 或平台目录，暂时不能让模型帮忙找")
    router = getattr(request.app.state, "_capability_assist_router", None)
    if router is None:
        router = PgTenantRouter(dsn)
        request.app.state._capability_assist_router = router
    usage = UsageAuditQuotaRepository(router)

    def record_usage(ctx, payload) -> None:
        usage.upsert_usage_with_delivery(ctx, payload=payload, enterprise_id=_lookup_enterprise_id(request, ctx.tenant_id))

    return CapabilityAssistService(
        operator=operator, import_service=_import_service(request), usage_sink=record_usage,
        owner_lookup=lambda ctx: earliest_owner(router, ctx), audit=build_enterprise_audit_repository(router),
    )


def build_capability_assist_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager", tags=["manager", "capability"])
    require = require_claims(verifier)

    @router.post(
        "/capability-assist", summary="让模型帮忙找技能 / MCP",
        description=(
            "管理员描述需求（可附链接或 MCP 配置），Manager 用所选的本企业平台模型经本企业 Relay 做一次有界查找"
            "（≤ 6 轮、≤ 12 次只读工具调用、≤ 90 秒），只返回候选，不安装、不保存需求与模型输出。"
            "候选链接必须来自本次工具结果。用量计入企业 owner 并写审计（不含内容）。仅 owner / enterprise_admin。"
        ),
        operation_id="manager_capability_assist",
    )
    async def capability_assist(body: CapabilityAssistIn, request: Request, claims: TokenClaims = Depends(require)) -> Envelope[CapabilityAssistOut]:
        service = _assist_service(request)
        data = await run_in_threadpool(service.run, tenant_context_from(claims), AssistRequest(
            requirement=body.requirement, provider_id=body.model.provider_id, model_id=body.model.model_id,
            link=body.link, config_json=body.config_json,
        ))
        return Envelope[CapabilityAssistOut](data=CapabilityAssistOut.model_validate(data))

    return router
