"""企业级 usage/audit rollup + 软配额治理（M8，04 §6.5/§6.5.1，D13/D24）。

非 integration（默认门必跑，不依赖 PG）：
- schema/契约：UsageSummaryUpload 形状、QuotaPolicy 默认 soft（D24）、无会话内容字段。
- 业务编排：usage/audit rollup 落库聚合（幂等去重）、跨租户不可见、冲突/缺失判定（内存伪 repo）。
- 软配额治理：默认 soft 只产出告警/限流建议、不阻断 run（D24）；硬配额模式产出 block_new_runs 建议。
- 红线（D13）：消费端拒绝含会话内容字段的条目；策略 dimensions 不含会话内容。
- 路由：受保护端点 401 / DB 未配置 503 / 路由全注册。
- 无会话内容泄露断言：消费端不存任何 message/prompt/token 明文。

integration（真 PG RLS）落 test_usage_audit_quota_isolation.py。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from shared.errors import Conflict, Forbidden, NotFound, ValidationProblem

from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token

# 无 DB 非集成测试用固定 RSA key 的 inmem verifier/signer（与 app 真实 DynamicRS256 同源逻辑）。
_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()

from manager_service.usage_audit_quota_repository import (
    AuditSummaryRow,
    QuotaPolicyRow,
    UsageRollupRow,
)
from manager_service.usage_audit_quota_service import UsageAuditQuotaService
from manager_service.schemas import (
    AuditSummaryOut,
    QuotaEnforcementActionOut,
    QuotaPolicyIn,
    QuotaPolicyOut,
    UsageRollupOut,
)


# ---- 内存伪 repository：按 tenant_id 分桶，模拟 RLS 跨租户不可见（D22）----


class _FakeRepo:
    """内存伪 repository：tenant_id 只从 ctx 读（D22）；跨租户分桶隔离。"""

    def __init__(self):
        self._usage: dict[str, dict[str, UsageRollupRow]] = {}
        self._audit: dict[str, dict[str, AuditSummaryRow]] = {}
        self._quota: dict[str, dict[str, QuotaPolicyRow]] = {}

    def _bucket_usage(self, ctx):
        return self._usage.setdefault(ctx.tenant_id, {})

    def _bucket_audit(self, ctx):
        return self._audit.setdefault(ctx.tenant_id, {})

    def _bucket_quota(self, ctx):
        return self._quota.setdefault(ctx.tenant_id, {})

    def upsert_usage(self, ctx, *, payload):
        b = self._bucket_usage(ctx)
        key = payload["summary_id"]
        row = UsageRollupRow(
            rollup_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id, summary_id=key,
            employee_id=payload.get("employee_id"),
            window_start=payload["window_start"], window_end=payload["window_end"],
            run_count=payload.get("run_count", 0), token_total=payload.get("token_total", 0),
            cost_total=_dec(payload.get("cost_total", 0)),
            error_count=payload.get("error_count", 0),
            duration_seconds_total=payload.get("duration_seconds_total", 0),
            received_at=datetime.now(timezone.utc),
        )
        # 模拟 ON CONFLICT 幂等：同 summary_id 覆盖
        b[key] = row
        return row

    def list_usage(self, ctx):
        return list(self._bucket_usage(ctx).values())

    def aggregate_usage(self, ctx, *, window_start, window_end):
        rows = [r for r in self._bucket_usage(ctx).values()
                if r.window_start >= window_start and r.window_end <= window_end]
        return {
            "rollup_count": len(rows),
            "run_count": sum(r.run_count for r in rows),
            "token_total": sum(r.token_total for r in rows),
            "cost_total": sum(r.cost_total for r in rows),
            "error_count": sum(r.error_count for r in rows),
            "duration_seconds_total": sum(r.duration_seconds_total for r in rows),
        }

    def upsert_audit(self, ctx, *, payload):
        b = self._bucket_audit(ctx)
        key = payload["summary_id"]
        row = AuditSummaryRow(
            event_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id, summary_id=key,
            actor=payload["actor"], action=payload["action"],
            resource_type=payload.get("resource_type"), resource_id=payload.get("resource_id"),
            occurred_at=payload["occurred_at"], received_at=datetime.now(timezone.utc),
        )
        b[key] = row
        return row

    def list_audits(self, ctx):
        return list(self._bucket_audit(ctx).values())

    def create_quota(self, ctx, *, policy_slug, display_name, scope, target_ref,
                     window_start, window_end, dimensions, enforcement, status):
        row = QuotaPolicyRow(
            policy_id=str(uuid.uuid4()), tenant_id=ctx.tenant_id, policy_slug=policy_slug,
            display_name=display_name, scope=scope, target_ref=target_ref,
            window_start=window_start, window_end=window_end, dimensions=dict(dimensions),
            enforcement=enforcement, status=status, version=1,
            created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
        )
        self._bucket_quota(ctx)[row.policy_id] = row
        return row

    def get_quota(self, ctx, *, policy_id):
        return self._bucket_quota(ctx).get(policy_id)

    def get_quota_by_slug(self, ctx, *, policy_slug):
        for r in self._bucket_quota(ctx).values():
            if r.policy_slug == policy_slug:
                return r
        return None

    def update_quota(self, ctx, *, policy_id, display_name, scope, target_ref,
                     window_start, window_end, dimensions, enforcement, status):
        b = self._bucket_quota(ctx)
        old = b.get(policy_id)
        if old is None:
            return None
        row = QuotaPolicyRow(
            policy_id=old.policy_id, tenant_id=old.tenant_id, policy_slug=old.policy_slug,
            display_name=display_name, scope=scope, target_ref=target_ref,
            window_start=window_start, window_end=window_end, dimensions=dict(dimensions),
            enforcement=enforcement, status=status, version=old.version + 1,
            created_at=old.created_at, updated_at=datetime.now(timezone.utc),
        )
        b[policy_id] = row
        return row

    def delete_quota(self, ctx, *, policy_id):
        return self._bucket_quota(ctx).pop(policy_id, None) is not None

    def list_quotas(self, ctx):
        return list(self._bucket_quota(ctx).values())


def _dec(v) -> Decimal:
    return v if isinstance(v, Decimal) else Decimal(str(v))


def _ctx(tid: str, roles=None) -> TenantContext:
    return TenantContext(tenant_id=tid, user_id="u", roles=roles or ["owner"])


def _quota_body(**overrides) -> QuotaPolicyIn:
    base = {
        "policy_slug": "default",
        "window_start": datetime(2026, 1, 1, tzinfo=timezone.utc),
        "window_end": datetime(2026, 2, 1, tzinfo=timezone.utc),
        "dimensions": {"cost_cap_usd": 100, "token_cap": 1_000_000, "run_cap": 500},
    }
    base.update(overrides)
    return QuotaPolicyIn(**base)


def _usage_item(summary_id="s1", **overrides) -> dict:
    base = {
        "summary_id": summary_id,
        "employee_id": None,
        "window_start": datetime(2026, 1, 10, tzinfo=timezone.utc),
        "window_end": datetime(2026, 1, 11, tzinfo=timezone.utc),
        "run_count": 5,
        "token_total": 10000,
        "cost_total": Decimal("1.5"),
        "error_count": 1,
        "duration_seconds_total": 600,
    }
    base.update(overrides)
    return base


def _audit_item(summary_id="a1", **overrides) -> dict:
    base = {
        "summary_id": summary_id,
        "actor": "member-x",
        "action": "expert_load",
        "resource_type": "expert",
        "resource_id": "e1",
        "occurred_at": datetime(2026, 1, 10, 12, tzinfo=timezone.utc),
    }
    base.update(overrides)
    return base


def _upload(tid: str, *, usage=None, audits=None) -> dict:
    return {
        "tenant_id": tid,
        "usage": usage or [],
        "audits": audits or [],
    }


# ---- 红线：消费端不存会话内容（D13）----


@pytest.mark.parametrize("forbidden_key", [
    "message", "messages", "prompt", "prompts", "content", "text",
    "tool_input", "tool_output", "raw_event", "completion", "response_text",
])
def test_ingest_rejects_conversation_content_in_usage(forbidden_key):
    """D13 红线：usage 摘要含会话内容字段 → 拒绝（消费端不存会话内容）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    item = _usage_item()
    item[forbidden_key] = "敏感会话内容"
    with pytest.raises(ValidationProblem):
        svc.ingest_upload(ctx, _upload("t-a", usage=[item]))


@pytest.mark.parametrize("forbidden_key", ["message", "prompt", "content", "raw_event"])
def test_ingest_rejects_conversation_content_in_audit(forbidden_key):
    """D13 红线：audit 摘要含会话内容字段 → 拒绝。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    item = _audit_item()
    item[forbidden_key] = "敏感会话内容"
    with pytest.raises(ValidationProblem):
        svc.ingest_upload(ctx, _upload("t-a", audits=[item]))


def test_usage_rollup_row_has_no_conversation_fields():
    """UsageRollupRow 无 message/prompt/token 明文字段（D13）。"""
    fields = set(UsageRollupRow.__dataclass_fields__.keys())
    forbidden = {"message", "messages", "prompt", "prompts", "content", "text",
                 "tool_input", "tool_output", "raw_event", "completion"}
    assert not (fields & forbidden), f"UsageRollupRow 含会话内容字段: {fields & forbidden}"


def test_audit_summary_row_has_no_conversation_fields():
    fields = set(AuditSummaryRow.__dataclass_fields__.keys())
    forbidden = {"message", "prompt", "content", "text", "raw_event"}
    assert not (fields & forbidden)


def test_quota_policy_dimensions_reject_conversation_content():
    """配额策略 dimensions 不含会话内容键（D13）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    body = _quota_body(dimensions={"cost_cap_usd": 100, "message": "敏感"})
    with pytest.raises(ValidationProblem):
        svc.create_quota(_ctx("t-a"), body)


# ---- usage/audit rollup 主路径 + 幂等 + 聚合 ----


def test_ingest_usage_and_audit_roundtrip():
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    result = svc.ingest_upload(ctx, _upload(
        "t-a", usage=[_usage_item("s1"), _usage_item("s2", run_count=3)],
        audits=[_audit_item("a1")],
    ))
    assert result == {"usage_ingested": 2, "audits_ingested": 1}

    usages = svc.list_usage(ctx)
    assert len(usages) == 2
    summaries = {u.summary_id for u in usages}
    assert summaries == {"s1", "s2"}

    audits = svc.list_audits(ctx)
    assert len(audits) == 1
    assert audits[0].action == "expert_load"


def test_ingest_idempotent_by_summary_id():
    """同 summary_id 重复上报幂等（ON CONFLICT 语义，F13 可重试）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    svc.ingest_upload(ctx, _upload("t-a", usage=[_usage_item("s1", run_count=5)]))
    svc.ingest_upload(ctx, _upload("t-a", usage=[_usage_item("s1", run_count=7)]))
    usages = svc.list_usage(ctx)
    assert len(usages) == 1  # 幂等：同 summary_id 一条
    assert usages[0].run_count == 7  # 取最新上报值


def test_usage_aggregate_within_window():
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    svc.ingest_upload(ctx, _upload(
        "t-a",
        usage=[
            _usage_item("s1", run_count=5, token_total=1000, cost_total=Decimal("1.0")),
            _usage_item("s2", run_count=3, token_total=500, cost_total=Decimal("0.5"),
                        window_start=datetime(2026, 3, 1, tzinfo=timezone.utc),
                        window_end=datetime(2026, 3, 2, tzinfo=timezone.utc)),
        ],
    ))
    agg = svc.aggregate_usage(
        ctx,
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 2, 1, tzinfo=timezone.utc),
    )
    # 只有 s1 落在窗口内
    assert agg.rollup_count == 1
    assert agg.run_count == 5
    assert agg.token_total == 1000
    assert agg.cost_total == Decimal("1.0")


def test_ingest_rejects_tenant_mismatch():
    """上传体 tenant_id 与身份不一致 → 403（防跨租户写入，D22）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    with pytest.raises(Forbidden):
        svc.ingest_upload(_ctx("t-a"), _upload("t-b", usage=[_usage_item()]))


# ---- 跨租户隔离（D22 + RLS 语义）----


def test_cross_tenant_usage_isolation():
    """t-a 上报的 usage，t-b 看不到/聚合不到（D22）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx_a, ctx_b = _ctx("t-a"), _ctx("t-b")
    svc.ingest_upload(ctx_a, _upload("t-a", usage=[_usage_item("s1")]))

    assert len(svc.list_usage(ctx_a)) == 1
    assert svc.list_usage(ctx_b) == []

    agg_b = svc.aggregate_usage(
        ctx_b,
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 12, 31, tzinfo=timezone.utc),
    )
    assert agg_b.rollup_count == 0


def test_cross_tenant_audit_isolation():
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx_a, ctx_b = _ctx("t-a"), _ctx("t-b")
    svc.ingest_upload(ctx_a, _upload("t-a", audits=[_audit_item("a1")]))
    assert len(svc.list_audits(ctx_a)) == 1
    assert svc.list_audits(ctx_b) == []


# ---- 软配额策略 CRUD + 版本自增 + 跨租户隔离 ----


def test_quota_crud_roundtrip_and_version_increment():
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    created = svc.create_quota(ctx, _quota_body())
    assert created.policy_slug == "default"
    assert created.enforcement == "soft"  # D24 默认 soft
    assert created.version == 1

    got = svc.get_quota(ctx, policy_id=created.policy_id)
    assert got.policy_id == created.policy_id

    updated = svc.update_quota(
        ctx,
        _quota_body(display_name="改名", enforcement="hard"),
        policy_id=created.policy_id,
    )
    assert updated.display_name == "改名"
    assert updated.enforcement == "hard"
    assert updated.version == 2

    svc.delete_quota(ctx, policy_id=created.policy_id)
    with pytest.raises(NotFound):
        svc.get_quota(ctx, policy_id=created.policy_id)


def test_quota_slug_conflict_within_tenant():
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    svc.create_quota(ctx, _quota_body(policy_slug="dup"))
    with pytest.raises(Conflict):
        svc.create_quota(ctx, _quota_body(policy_slug="dup"))


def test_same_quota_slug_across_tenants_allowed():
    """同 slug 属不同 tenant 是不同策略（unique(tenant_id, policy_slug)）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    svc.create_quota(_ctx("t-a"), _quota_body(policy_slug="shared"))
    created_b = svc.create_quota(_ctx("t-b"), _quota_body(policy_slug="shared"))
    assert created_b.policy_slug == "shared"


def test_quota_cross_tenant_isolation():
    """t-a 的策略，t-b 看不到/改不到/删不掉（D22）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx_a, ctx_b = _ctx("t-a"), _ctx("t-b")
    created = svc.create_quota(ctx_a, _quota_body())

    with pytest.raises(NotFound):
        svc.get_quota(ctx_b, policy_id=created.policy_id)
    with pytest.raises(NotFound):
        svc.update_quota(ctx_b, _quota_body(display_name="hack"), policy_id=created.policy_id)
    with pytest.raises(NotFound):
        svc.delete_quota(ctx_b, policy_id=created.policy_id)
    assert svc.get_quota(ctx_a, policy_id=created.policy_id) is not None


def test_member_cannot_write_quota():
    """配额写操作需 owner/enterprise_admin/finance_admin；member → 403（03 §9.7）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx_member = _ctx("t-a", roles=["member"])
    with pytest.raises(Forbidden):
        svc.create_quota(ctx_member, _quota_body())
    # member 读允许
    ctx_owner = _ctx("t-a", roles=["owner"])
    created = svc.create_quota(ctx_owner, _quota_body())
    assert svc.get_quota(ctx_member, policy_id=created.policy_id).policy_slug == "default"


def test_finance_admin_can_write_quota():
    """finance_admin 也能写配额策略（03 §9.7）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx_fin = _ctx("t-a", roles=["finance_admin"])
    created = svc.create_quota(ctx_fin, _quota_body(policy_slug="fin"))
    assert created.policy_slug == "fin"


# ---- 软配额治理动作（D24：默认 soft，不阻断 run）----


def test_quota_evaluate_soft_no_action_within_budget():
    """配额内 → within_budget，无阻断（D24 soft）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    created = svc.create_quota(ctx, _quota_body(dimensions={
        "cost_cap_usd": 100, "token_cap": 1_000_000, "run_cap": 500,
    }))
    action = svc.evaluate_quota(
        ctx, policy_id=created.policy_id,
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 2, 1, tzinfo=timezone.utc),
    )
    assert action.enforcement == "soft"
    assert action.actions == ["within_budget"]
    assert action.severity == "info"


def test_quota_evaluate_soft_alerts_on_threshold_but_no_block():
    """soft 模式超阈：产出告警/限流建议，但**不产出 block_new_runs**（D24 不阻断 run）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    created = svc.create_quota(ctx, _quota_body(dimensions={
        "cost_cap_usd": 100, "token_cap": 1_000_000, "run_cap": 500,
    }))
    svc.ingest_upload(ctx, _upload("t-a", usage=[
        _usage_item("s1", run_count=600, token_total=2_000_000, cost_total=Decimal("150")),
    ]))
    action = svc.evaluate_quota(
        ctx, policy_id=created.policy_id,
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 2, 1, tzinfo=timezone.utc),
    )
    assert action.enforcement == "soft"
    assert "block_new_runs" not in action.actions  # 红线：soft 不阻断
    assert "notify_owner" in action.actions or "suggest_throttle" in action.actions


def test_quota_evaluate_hard_adds_block_new_runs_suggestion():
    """hard 模式超阈：追加 block_new_runs 建议（但仍非 lease，详设须显式标记牺牲离线可用性）。"""
    svc = UsageAuditQuotaService(_FakeRepo())
    ctx = _ctx("t-a")
    created = svc.create_quota(ctx, _quota_body(
        enforcement="hard",
        dimensions={"cost_cap_usd": 100},
    ))
    svc.ingest_upload(ctx, _upload("t-a", usage=[
        _usage_item("s1", run_count=10, cost_total=Decimal("150")),
    ]))
    action = svc.evaluate_quota(
        ctx, policy_id=created.policy_id,
        window_start=datetime(2026, 1, 1, tzinfo=timezone.utc),
        window_end=datetime(2026, 2, 1, tzinfo=timezone.utc),
    )
    assert action.enforcement == "hard"
    assert "block_new_runs" in action.actions
    assert action.severity == "alert"


def test_quota_evaluate_default_is_soft():
    """QuotaPolicyIn 不传 enforcement → 默认 soft（D24）。"""
    body = _quota_body()
    body_dict = body.model_dump()
    body_dict.pop("enforcement")
    body2 = QuotaPolicyIn(**body_dict)
    assert body2.enforcement == "soft"


# ---- 路由：受保护端点 401 / DB 未配置 503 / 路由全注册 ----


def _client(db_url: str | None) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    settings = Settings(
        tier="manager",
        service_name="aiteam-manager-service",
        db_url=db_url,
        service_token="test-service-token",
    )
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_usage_audit_quota_router(_INMEM_VERIFIER))
    return TestClient(app)


def _token(tenant_id: str, roles: list[str]) -> str:
    return sign_inmem_token(_INMEM_SIGNER, tenant_id, roles, user_id=str(uuid.uuid4()))


def test_usage_upload_without_token_returns_401():
    client = _client(None)
    resp = client.post("/api/manager/usage/upload", json={"tenant_id": "t1", "usage": [], "audits": []})
    assert resp.status_code == 401
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.json()["code"] == "unauthorized"


def test_usage_upload_without_db_returns_503():
    client = _client(None)
    resp = client.post(
        "/api/manager/usage/upload",
        headers={"X-Service-Token": "test-service-token"},
        json={"tenant_id": "t1", "usage": [], "audits": []},
    )
    assert resp.status_code == 503
    assert resp.json()["code"] == "manager_db_unconfigured"


def test_quota_policies_without_token_returns_401():
    client = _client(None)
    resp = client.get("/api/manager/quota-policies")
    assert resp.status_code == 401


def test_audits_without_db_returns_503():
    client = _client(None)
    token = _token("t1", ["owner"])
    resp = client.get("/api/manager/audits", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 503
    assert resp.json()["code"] == "manager_db_unconfigured"


def test_routes_registered_in_openapi():
    """验收：usage/audit/quota 路由全注册（OpenAPI 反映）。"""
    client = _client(None)
    spec = client.get("/openapi.json").json()
    expected = {
        "/api/manager/usage/upload": {"post"},
        "/api/manager/usage/rollup": {"get"},
        "/api/manager/usage/rollup/list": {"get"},
        "/api/manager/audits": {"get"},
        "/api/manager/quota-policies": {"post", "get"},
        "/api/manager/quota-policies/{policy_id}": {"get", "put", "delete"},
        "/api/manager/quota-policies/{policy_id}/evaluate": {"post"},
    }
    for path, methods in expected.items():
        assert path in spec["paths"], f"missing {path}"
        assert set(spec["paths"][path].keys()) == methods, f"{path} methods mismatch: {set(spec['paths'][path].keys())}"


# 注：D13 红线（dimensions 含会话内容字段拒绝）在 service 层断言（见
# test_quota_policy_dimensions_reject_conversation_content）；HTTP 层因 _service() 无 DB 先
# 返回 503，红线断言不经 HTTP 路径触发，故此处不重复 HTTP 422 用例。
