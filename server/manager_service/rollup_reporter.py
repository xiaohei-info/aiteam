"""闭环 C：Manager 企业级 usage rollup -> Operator 跨企业看板上报（M8->O3，04 §6.5 / D13）。

把本租户已聚合的脱敏 usage rollup 卷成企业级 EnterpriseRollupUpload，经窄通道上报 Operator；
Operator 落 cross_enterprise_usage_rollup 并跨企业再聚合（board/detail）。Manager 只推聚合数字，
不下钻成员/会话/token 明细（D13 红线）；Operator 只接收聚合结果。

- 协议接口 OperatorRollupClient.upload(payload, *, idempotency_key)：抛异常即视为失败。
- 默认 UnconfiguredRollupClient 安全拒绝（不静默成功/不静默丢），生产注入 ServiceClientRollupClient。
- 幂等键由 enterprise_id + 已聚合 summary_id 集合确定性派生（重发同批得同 key）。
- 红线：payload 只承载 UsageSummary（脱敏聚合单元，含 tenant_id），绝不包含会话内容。
"""
from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Protocol

from shared.contracts.summary import UsageSummary
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError
from shared.service_client import ServiceClient

from .schemas import UsageRollupOut
from .usage_audit_quota_service import UsageAuditQuotaService

_ROLLUP_PATH = "/api/operation/rollups"


class OperatorRollupClient(Protocol):
    """企业级 rollup 上报对端协议。upload 成功返回 None；失败抛异常。"""

    def upload(self, payload, *, idempotency_key: str) -> None: ...


class UnconfiguredRollupClient:
    """未配置 operator_url 的安全默认：上报一律按"不可达"失败（不静默成功/不静默丢）。"""

    def upload(self, payload, *, idempotency_key: str) -> None:
        raise AppError("operator rollup client 未配置。配置 OPERATOR_URL 并注入真实客户端后可用。")


class ServiceClientRollupClient:
    """经 shared.service_client 上报 Operator。写调用带 Idempotency-Key（05 §5.1）。"""

    def __init__(self, client: ServiceClient) -> None:
        self._client = client

    def upload(self, payload, *, idempotency_key: str) -> None:
        self._client.post(_ROLLUP_PATH, json=payload.model_dump(mode="json"), idempotency_key=idempotency_key)


def _to_usage_summary(row: UsageRollupOut, tenant_id: str) -> UsageSummary:
    """UsageRollupOut（本端聚合行）-> 契约 UsageSummary（Operator 消费的脱敏聚合单元）。

    只搬聚合数字 + summary_id/窗口/employee_id（标识符）；无会话内容字段（D13）。
    """
    return UsageSummary(
        summary_id=row.summary_id,
        tenant_id=tenant_id,
        employee_id=row.employee_id,
        window_start=row.window_start,
        window_end=row.window_end,
        run_count=row.run_count,
        token_total=row.token_total,
        cost_total=row.cost_total,
        error_count=row.error_count,
        duration_seconds_total=row.duration_seconds_total,
    )


def _batch_idempotency_key(enterprise_id: str, summaries: list[UsageSummary]) -> str:
    """确定性批次幂等键：同一组 summary_id 重发得到同一 key（05 §5.1）。"""
    joined = "|".join(sorted(s.summary_id for s in summaries))
    digest = hashlib.sha256(f"{enterprise_id}|{joined}".encode("utf-8")).hexdigest()[:24]
    return f"eru_{digest}"


class RollupReporter:
    """把本租户 usage rollup 上报给 Operator 的编排器（闭环 C 的 Manager->Operator 段）。

    依赖注入 UsageAuditQuotaService（读本租户聚合）+ OperatorRollupClient（写对端）。
    tenant_id 全程从 TenantContext 读（D22）；不上报会话内容（D13）。
    """

    def __init__(self, service: UsageAuditQuotaService) -> None:
        self._service = service

    def report(
        self,
        ctx: TenantContext,
        *,
        enterprise_id: str,
        client: OperatorRollupClient,
    ) -> dict:
        """收集本租户 usage rollup -> 卷成 EnterpriseRollupUpload -> 上报 Operator。

        返回 {summaries, run_count, token_total, cost_total} 供观测。无聚合数据时不上报（返回空）。
        """
        rows = self._service.list_usage(ctx)
        summaries = [_to_usage_summary(r, ctx.tenant_id) for r in rows]
        if not summaries:
            return {"summaries": 0, "run_count": 0, "token_total": 0, "cost_total": "0"}
        from operation_service.rollup_schemas import EnterpriseRollupUpload

        payload = EnterpriseRollupUpload(
            enterprise_id=enterprise_id,
            tenant_id=ctx.tenant_id,
            summaries=summaries,
        )
        key = _batch_idempotency_key(enterprise_id, summaries)
        client.upload(payload, idempotency_key=key)
        return {
            "summaries": len(summaries),
            "run_count": sum(s.run_count for s in summaries),
            "token_total": sum(s.token_total for s in summaries),
            "cost_total": str(sum((s.cost_total for s in summaries), Decimal("0"))),
        }
