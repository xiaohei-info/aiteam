"""共享契约的校验与**漂移守卫**测试。

这些测试既验证契约可用，也充当口径锁：枚举取值等一旦被悄改，测试即红。
修改本测试 = 修改共享口径，需评审（CLAUDE.md §8）。
"""

import importlib

import pytest
from pydantic import ValidationError

from shared import contracts as C


def test_public_api_importable():
    """__all__ 中每个名字都能从 shared.contracts 取到（防止漏导出/拼写漂移）。"""
    mod = importlib.import_module("shared.contracts")
    for name in mod.__all__:
        assert hasattr(mod, name), f"shared.contracts 缺少导出: {name}"


def test_conversation_state_values_frozen():
    """会话主状态固定枚举（07 §8）。"""
    assert {s.value for s in C.ConversationState} == {
        "draft", "active", "paused", "muted", "archived"
    }


def test_display_state_values_frozen():
    assert {s.value for s in C.DisplayState} == {
        "idle", "routing", "waiting_reply", "streaming", "busy", "resolved", "reconnecting"
    }


def test_roles_frozen_and_no_legacy():
    """角色枚举（03 §9.7）；显式禁止旧 admin/manager/viewer。"""
    enterprise = {r.value for r in C.EnterpriseRole}
    platform = {r.value for r in C.PlatformRole}
    assert enterprise == {"owner", "enterprise_admin", "finance_admin", "member"}
    assert platform == {"system_admin", "system_operator"}
    assert not ({"admin", "manager", "viewer"} & (enterprise | platform))


def test_problem_requires_core_fields():
    """problem+json 必填核心字段（02 §11.2）。"""
    p = C.Problem(
        type="https://docs.aiteam.local/problems/validation_error",
        title="Validation error",
        status=422,
        code="validation_error",
    )
    dumped = p.model_dump()
    for f in ("type", "title", "status", "code"):
        assert f in dumped
    # message 不是顶层标准字段（用 detail）
    assert "message" not in dumped


def test_problem_forbids_extra_fields():
    """envelope/problem 禁止额外字段，避免各端自造形态漂移。"""
    with pytest.raises(ValidationError):
        C.Problem(
            type="t", title="x", status=400, code="c", password="leak"  # type: ignore[call-arg]
        )


def test_envelope_roundtrip():
    env = C.Envelope[dict](data={"id": "1"}, meta={"request_id": "req_1"})
    assert env.model_dump()["data"] == {"id": "1"}
    lst = C.ListEnvelope[dict](data=[{"id": "1"}], page=C.Page(next_cursor="2", has_more=True))
    assert lst.page.has_more is True


def test_token_claims_user_id_required():
    with pytest.raises(ValidationError):
        C.TokenClaims(exp=123)  # type: ignore[call-arg]
    c = C.TokenClaims(user_id="u1", exp=123, tenant_id="t1")
    assert c.tenant_id == "t1"


def test_tenant_context_is_frozen():
    """TenantContext 不可变，向下游只读传递（04 §6.1.x）。"""
    ctx = C.TenantContext(tenant_id="t1", user_id="u1", roles=["member"])
    with pytest.raises(ValidationError):
        ctx.tenant_id = "t2"  # type: ignore[misc]


def test_snapshot_carries_version():
    snap = C.EmployeeExecutionSnapshot(
        employee_id="e1", version="v1", snapshot_version="s1"
    )
    assert snap.snapshot_version == "s1"


def test_usage_summary_uses_decimal_not_float():
    """金额用 Decimal（02 §10.3.5 禁 float）。"""
    from decimal import Decimal

    s = C.UsageSummary(
        summary_id="sum1",
        tenant_id="t1",
        window_start="2026-06-19T00:00:00Z",
        window_end="2026-06-19T01:00:00Z",
        cost_total="1.23",
    )
    assert isinstance(s.cost_total, Decimal)


def test_platform_pricing_is_decimal_versioned_and_secret_free():
    from decimal import Decimal

    pricing = C.PricingSnapshot(
        pricing_version=3,
        pricing_status="known",
        input_usd_per_million="0.30",
        output_usd_per_million="1.20",
        cache_read_usd_per_million="0.06",
        currency="USD",
        effective_from="2026-08-24T00:00:00Z",
    )
    policy = C.ModelPolicy(
        model="minimax-m3",
        provider_ref="newapi",
        provider_version=2,
        model_version=4,
        pricing=pricing,
    )
    assert isinstance(policy.pricing.input_usd_per_million, Decimal)
    assert policy.model_dump(mode="json")["pricing"]["input_usd_per_million"] == "0.30"
    assert "token" not in policy.model_dump(mode="json")


def test_platform_rate_rejects_float_like_extra_or_negative_values():
    with pytest.raises(ValidationError):
        C.PlatformModelRate(
            rate_id="r1", provider_id="p1", model_id="m1", pricing_version=1,
            pricing_status="known", input_usd_per_million="-1", source="manual",
            effective_from="2026-08-24T00:00:00Z", secret="leak",
        )


def test_crosstier_snapshot_pull_wraps_snapshot():
    from shared.contracts.crosstier import SnapshotPullResponse

    snap = C.EmployeeExecutionSnapshot(employee_id="e1", version="v1", snapshot_version="s1")
    resp = SnapshotPullResponse(snapshot=snap)
    assert resp.snapshot.employee_id == "e1"
