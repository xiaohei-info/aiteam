"""段落解决率汇总（议题 1 / 议题 7）：Agent 计数上报的校验、存储、读取与人才市场 stats。

无 PG：服务层用内存 fake，仓储层用 FakeRouter 验证 SQL 形状与行映射。
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from manager_service.segment_outcome_repository import (
    RESOLUTION_RATE_MIN_SAMPLE,
    SegmentOutcomeCounts,
    SegmentOutcomeRepository,
    resolution_rate,
)
from manager_service.usage_audit_quota_service import UsageAuditQuotaService
from shared.config import Settings
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Conflict, Forbidden, ValidationProblem
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from tests.manager._fake_router import FakeCursor, FakeRouter

TENANT = "11111111-1111-1111-1111-111111111111"
MEMBER = "22222222-2222-2222-2222-222222222222"
EMPLOYEE = "33333333-3333-3333-3333-333333333333"
CTX = TenantContext(tenant_id=TENANT, user_id=MEMBER, roles=["member"])
VERIFIER, SIGNER = make_inmem_verifier_and_signer()


class _UsageRepo:
    def __init__(self, granted: bool = True):
        self.granted = granted

    def employee_exists(self, ctx, *, employee_id):
        return True

    def employee_granted_to_member(self, ctx, *, employee_id, member_id):
        return self.granted


class _OutcomeRepo:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    def upsert(self, ctx, *, payload):
        self.rows[payload["summary_id"]] = payload

    def counts_by_employee(self, ctx, **filters):
        self.filters = filters
        return [
            SegmentOutcomeCounts(group_id=EMPLOYEE, display_name="研究员", evaluated_count=12, resolved_count=9),
            SegmentOutcomeCounts(group_id="44444444-4444-4444-4444-444444444444", display_name=None, evaluated_count=3, resolved_count=1),
        ]


def _outcome(**overrides) -> dict:
    return {
        "schema_version": "1", "summary_id": "seg-1", "tenant_id": TENANT, "member_id": MEMBER,
        "employee_id": EMPLOYEE, "window_start": "2026-10-30T02:00:00Z", "window_end": "2026-10-30T03:00:00Z",
        "evaluated_count": 3, "resolved_count": 2, **overrides,
    }


def test_resolution_rate_requires_min_sample():
    assert RESOLUTION_RATE_MIN_SAMPLE == 10
    assert resolution_rate(9, 9) is None
    assert resolution_rate(10, 7) == pytest.approx(0.7)
    assert resolution_rate(0, 0) is None


def test_ingest_stores_segment_outcomes_and_reports_count():
    outcomes = _OutcomeRepo()
    svc = UsageAuditQuotaService(_UsageRepo(), outcomes)
    result = svc.ingest_segment_outcomes(CTX, [_outcome()])
    assert result == {"segment_outcomes_ingested": 1}
    stored = outcomes.rows["seg-1"]
    assert stored["evaluated_count"] == 3 and stored["resolved_count"] == 2
    assert stored["window_start"] == datetime(2026, 10, 30, 2, tzinfo=timezone.utc)


def test_usage_upload_receipt_has_no_segment_outcome_field():
    svc = UsageAuditQuotaService(_UsageRepo(), _OutcomeRepo())
    assert svc.ingest_upload(CTX, {"usage": [], "audits": []}) == {"usage_ingested": 0, "audits_ingested": 0}


@pytest.mark.parametrize("overrides, error", [
    ({"resolved_count": 4}, ValidationProblem),
    ({"evaluated_count": -1}, ValidationProblem),
    ({"schema_version": "2"}, ValidationProblem),
    ({"note": "会话内容"}, ValidationProblem),
    ({"content": "x"}, ValidationProblem),
    ({"window_end": "2026-10-30T04:00:00Z"}, ValidationProblem),
    ({"member_id": "55555555-5555-5555-5555-555555555555"}, Forbidden),
    ({"tenant_id": "66666666-6666-6666-6666-666666666666"}, Forbidden),
])
def test_ingest_rejects_invalid_segment_outcome(overrides, error):
    outcomes = _OutcomeRepo()
    svc = UsageAuditQuotaService(_UsageRepo(), outcomes)
    with pytest.raises(error):
        svc.ingest_segment_outcomes(CTX, [_outcome(), _outcome(summary_id="seg-2", **overrides)])
    # 先整体校验再写：一条坏数据不会让前面的条目半写入。
    assert outcomes.rows == {}


def test_ingest_rejects_employee_not_granted_to_member():
    svc = UsageAuditQuotaService(_UsageRepo(granted=False), _OutcomeRepo())
    with pytest.raises(Forbidden):
        svc.ingest_segment_outcomes(CTX, [_outcome()])


def test_ingest_without_outcome_storage_is_503():
    svc = UsageAuditQuotaService(_UsageRepo())
    with pytest.raises(AppError) as exc:
        svc.ingest_segment_outcomes(CTX, [_outcome()])
    assert exc.value.status == 503


def test_segment_outcomes_statistics_apply_min_sample_per_group():
    outcomes = _OutcomeRepo()
    svc = UsageAuditQuotaService(_UsageRepo(), outcomes)
    stats = svc.segment_outcomes(CTX, member_id=MEMBER)
    assert stats.evaluated_count == 15 and stats.resolved_count == 10 and stats.unresolved_count == 5
    assert stats.resolution_rate == pytest.approx(10 / 15)
    assert stats.min_sample == 10
    assert stats.groups[0].resolution_rate == pytest.approx(0.75)
    assert stats.groups[1].resolution_rate is None
    assert outcomes.filters["member_id"] == MEMBER


def test_segment_outcomes_statistics_validate_filters():
    svc = UsageAuditQuotaService(_UsageRepo(), _OutcomeRepo())
    with pytest.raises(ValidationProblem):
        svc.segment_outcomes(CTX, employee_id="not-a-uuid")
    with pytest.raises(ValidationProblem):
        svc.segment_outcomes(CTX, window_start=datetime(2026, 10, 30, 2, tzinfo=timezone.utc))


# ---- repository ----


def test_repository_upsert_overwrites_counts_and_guards_attribution():
    router = FakeRouter().queue(FakeCursor(fetchone=("seg-1",)))
    repo = SegmentOutcomeRepository(router)
    payload = {
        "summary_id": "seg-1", "member_id": MEMBER, "employee_id": EMPLOYEE,
        "window_start": datetime(2026, 10, 30, 2, tzinfo=timezone.utc),
        "window_end": datetime(2026, 10, 30, 3, tzinfo=timezone.utc),
        "evaluated_count": 3, "resolved_count": 2,
    }
    repo.upsert(CTX, payload=payload)
    sql, params = router.executed[0]
    assert "ON CONFLICT (tenant_id, summary_id) DO UPDATE" in sql
    assert "evaluated_count = EXCLUDED.evaluated_count" in sql
    assert params[-2:] == (3, 2)
    router.queue(FakeCursor(fetchone=None))
    with pytest.raises(Conflict):
        repo.upsert(CTX, payload=payload)


def test_repository_counts_by_employee_and_template():
    router = FakeRouter().queue_many(
        FakeCursor(fetchall=[(EMPLOYEE, "研究员", 12, 9)]),
        FakeCursor(fetchall=[("tpl-1", 20, 15)]),
    )
    repo = SegmentOutcomeRepository(router)
    [group] = repo.counts_by_employee(CTX, member_id=MEMBER)
    assert (group.group_id, group.display_name, group.evaluated_count, group.resolved_count) == (EMPLOYEE, "研究员", 12, 9)
    assert "tenant_id" not in router.executed[0][0].split("WHERE", 1)[1]
    by_template = repo.counts_by_source_template(CTX)
    assert by_template["tpl-1"].evaluated_count == 20
    assert "source_template_id IS NOT NULL" in router.executed[1][0]


# ---- routes ----


def _usage_client(svc):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    app = create_app(Settings(tier="manager", service_name="manager", db_url="postgresql://fake/fake"), manager_router)
    app.state._token_verifier = VERIFIER
    app.state._usage_audit_quota_service = svc
    app.include_router(build_usage_audit_quota_router(VERIFIER))
    return TestClient(app)


def _headers(role: str, user_id: str = MEMBER):
    return {"Authorization": "Bearer " + sign_inmem_token(SIGNER, TENANT, [role], user_id=user_id)}


def test_segment_outcomes_route_stores_counts_and_returns_receipt():
    outcomes = _OutcomeRepo()
    client = _usage_client(UsageAuditQuotaService(_UsageRepo(), outcomes))
    response = client.post("/api/manager/usage/segment-outcomes", json={"tenant_id": TENANT, "segment_outcomes": [_outcome()]}, headers=_headers("member"))
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"segment_outcomes_ingested": 1}
    assert outcomes.rows["seg-1"]["resolved_count"] == 2


@pytest.mark.parametrize("body", [
    {"segment_outcomes": []},
    {"segment_outcomes": [_outcome(note="会话内容")]},
    {"segment_outcomes": [_outcome(schema_version="2")]},
    {"segment_outcomes": [_outcome(evaluated_count=-1)]},
    {"segment_outcomes": [_outcome()], "usage": []},
])
def test_segment_outcomes_route_rejects_invalid_fields_as_422(body):
    # 字段错误是真 422，不是“接口不存在”；Agent 只把 404 当作 Manager 尚不支持。
    outcomes = _OutcomeRepo()
    client = _usage_client(UsageAuditQuotaService(_UsageRepo(), outcomes))
    response = client.post("/api/manager/usage/segment-outcomes", json=body, headers=_headers("member"))
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_error"
    assert outcomes.rows == {}


def test_segment_outcomes_route_rejects_other_tenant():
    client = _usage_client(UsageAuditQuotaService(_UsageRepo(), _OutcomeRepo()))
    response = client.post(
        "/api/manager/usage/segment-outcomes",
        json={"tenant_id": "66666666-6666-6666-6666-666666666666", "segment_outcomes": [_outcome()]},
        headers=_headers("member"),
    )
    assert response.status_code == 403


def test_usage_upload_route_no_longer_accepts_segment_outcomes():
    svc = MagicMock()
    client = _usage_client(svc)
    with patch("manager_service.routes_usage_audit_quota._report_to_operator"):
        response = client.post("/api/manager/usage/upload", json={"segment_outcomes": [_outcome()]}, headers=_headers("member"))
    assert response.status_code == 422
    svc.ingest_upload.assert_not_called()


def test_outcomes_route_scopes_members_to_themselves():
    svc = UsageAuditQuotaService(_UsageRepo(), _OutcomeRepo())
    client = _usage_client(svc)
    response = client.get("/api/manager/usage/outcomes", headers=_headers("member"))
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["member_id"] == MEMBER and data["min_sample"] == 10
    assert data["groups"][1]["resolution_rate"] is None
    other = client.get(f"/api/manager/usage/outcomes?member_id={EMPLOYEE}", headers=_headers("member"))
    assert other.status_code == 403


def test_outcomes_route_admin_reads_tenant_wide():
    outcomes = _OutcomeRepo()
    client = _usage_client(UsageAuditQuotaService(_UsageRepo(), outcomes))
    response = client.get("/api/manager/usage/outcomes", headers=_headers("enterprise_admin"))
    assert response.status_code == 200
    assert response.json()["data"]["member_id"] is None
    assert outcomes.filters["member_id"] is None


# ---- marketplace catalog stats ----


def _catalog_client(outcome_repo):
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.operator_catalog import FakeOperatorCatalogClient
    from manager_service.routes_recruit import build_recruit_router

    app = create_app(Settings(tier="manager", service_name="m", db_url="postgresql://fake/fake"), manager_router)
    app.state._token_verifier = VERIFIER
    app.state._operator_catalog = FakeOperatorCatalogClient()
    app.state._segment_outcome_repository = outcome_repo
    app.include_router(build_recruit_router(VERIFIER))
    return TestClient(app)


def _seed(client, template_id, **profile):
    from shared.contracts.crosstier import ExpertTemplateDetail

    client.app.state._operator_catalog.seed_expert(ExpertTemplateDetail(
        template_id=template_id, version="1", display_name=template_id,
        platform_model_ref={"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1},
        **profile,
    ))


def _recruit_svc():
    svc = MagicMock()
    svc.recruited_template_ids.return_value = {"tpl-a"}
    return svc


def test_catalog_projects_profile_fields_and_tenant_stats():
    repo = MagicMock()
    repo.counts_by_source_template.return_value = {
        "tpl-a": SegmentOutcomeCounts(group_id="tpl-a", display_name=None, evaluated_count=12, resolved_count=9),
        "tpl-b": SegmentOutcomeCounts(group_id="tpl-b", display_name=None, evaluated_count=4, resolved_count=4),
    }
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=_recruit_svc()):
        client = _catalog_client(repo)
        _seed(client, "tpl-a", tagline="周报助手", output_types=["document"], pricing={"mode": "per_call", "unit_price": "0.05"})
        _seed(client, "tpl-b")
        _seed(client, "tpl-c")
        response = client.get("/api/manager/recruit/catalog/experts", headers=_headers("member"))
    assert response.status_code == 200, response.text
    items = {item["template_id"]: item for item in response.json()["data"]}
    assert items["tpl-a"]["tagline"] == "周报助手"
    assert items["tpl-a"]["pricing"] == {"mode": "per_call", "unit_price": "0.05", "currency": "USD"}
    assert items["tpl-a"]["stats"] == {"resolution_rate": 0.75, "evaluated_segments": 12, "resolved_segments": 9, "min_sample": 10}
    assert items["tpl-b"]["stats"]["resolution_rate"] is None
    assert items["tpl-c"]["stats"] is None
    assert items["tpl-c"]["use_cases"] == [] and items["tpl-c"]["updated_at"] is None


def test_catalog_stats_failure_does_not_break_browsing():
    repo = MagicMock()
    repo.counts_by_source_template.side_effect = RuntimeError("relation does not exist")
    with patch("manager_service.routes_recruit.build_recruit_service", return_value=_recruit_svc()):
        client = _catalog_client(repo)
        _seed(client, "tpl-a")
        response = client.get("/api/manager/recruit/catalog/experts", headers=_headers("member"))
    assert response.status_code == 200
    assert response.json()["data"][0]["stats"] is None
