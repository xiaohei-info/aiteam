"""跨企业 rollup 北向路由测试（/api/operation，04 §6.5，D13）。

经 TestClient + dependency_overrides 注入全新 rollup 仓储；断言鉴权、envelope、
problem+json、跨企业聚合、幂等、OpenAPI 暴露、红线（响应无会话内容/明细下钻字段）。
"""

import pytest
from fastapi.testclient import TestClient

from operation_service.dependencies import get_rollup_service
from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from operation_service.rollup_service import RollupService
from run import get_app
from shared.auth import DevTokenService
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import EnterpriseRole, PlatformRole


@pytest.fixture
def repo():
    return CrossEnterpriseRollupRepository()


@pytest.fixture
def client(repo):
    app = get_app("operation")
    app.dependency_overrides[get_rollup_service] = lambda: RollupService(repo)
    yield TestClient(app)
    app.dependency_overrides.clear()


def _token(role: str) -> str:
    # 用 Operation app 的真实系统 RS256 key 签发（与 app._verifier 闭环，D23）。
    from operation_service.app import _auth

    return _auth.signer.sign(TokenClaims(user_id="op1", roles=[role], exp=9999999999))


def _auth(role: str) -> dict:
    return {"Authorization": f"Bearer {_token(role)}"}


def _upload_body(ent: str, tenant: str, summary_id: str, **kw) -> dict:
    summary = {
        "summary_id": summary_id,
        "tenant_id": tenant,
        "window_start": "2026-06-01T00:00:00",
        "window_end": "2026-06-02T00:00:00",
        "run_count": 2,
        "token_total": 100,
        "cost_total": "1.50",
        "error_count": 0,
        "duration_seconds_total": 10,
    }
    summary.update(kw)
    return {"enterprise_id": ent, "tenant_id": tenant, "summaries": [summary]}


_OP = PlatformRole.SYSTEM_OPERATOR.value
_ADMIN = PlatformRole.SYSTEM_ADMIN.value


def test_ingest_requires_auth(client):
    r = client.post("/api/operation/rollups", json=_upload_body("e1", "t1", "s1"))
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "unauthorized"


def test_ingest_forbidden_for_non_platform_role(client):
    r = client.post(
        "/api/operation/rollups",
        json=_upload_body("e1", "t1", "s1"),
        headers=_auth(EnterpriseRole.MEMBER.value),
    )
    assert r.status_code == 403
    assert r.json()["code"] == "forbidden"


def test_ingest_and_board_cross_enterprise(client):
    client.post("/api/operation/rollups",
                json=_upload_body("e1", "t1", "s1", token_total=100, run_count=2),
                headers=_auth(_OP))
    client.post("/api/operation/rollups",
                json=_upload_body("e2", "t2", "s2", token_total=200, run_count=3, error_count=1),
                headers=_auth(_OP))

    r = client.get("/api/operation/rollups/board", headers=_auth(_ADMIN))
    assert r.status_code == 200
    board = r.json()["data"]
    assert board["enterprise_count"] == 2
    assert board["run_count"] == 5
    assert board["token_total"] == 300
    assert board["error_count"] == 1
    assert {e["enterprise_id"] for e in board["enterprises"]} == {"e1", "e2"}


def test_ingest_idempotent_by_summary_id(client):
    body = _upload_body("e1", "t1", "dup", token_total=100)
    client.post("/api/operation/rollups", json=body, headers=_auth(_OP))
    client.post("/api/operation/rollups", json=body, headers=_auth(_OP))  # 重传
    board = client.get("/api/operation/rollups/board", headers=_auth(_OP)).json()["data"]
    assert board["token_total"] == 100  # 不翻倍


def test_ingest_returns_202_empty_envelope(client):
    r = client.post("/api/operation/rollups",
                    json=_upload_body("e1", "t1", "s1"), headers=_auth(_OP))
    assert r.status_code == 202
    assert r.json()["data"] is None


def test_enterprise_rollup_view(client):
    client.post("/api/operation/rollups",
                json=_upload_body("e1", "t1", "s1", token_total=42), headers=_auth(_OP))
    r = client.get("/api/operation/rollups/e1", headers=_auth(_OP))
    assert r.status_code == 200
    assert r.json()["data"]["enterprise_id"] == "e1"
    assert r.json()["data"]["token_total"] == 42


def test_enterprise_rollup_unknown_returns_zeroed_200(client):
    """未知企业返回 200 + 全零聚合而非 404（GH#328）。"""
    r = client.get("/api/operation/rollups/nope", headers=_auth(_OP))
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["enterprise_id"] == "nope"
    assert data["tenant_id"] == ""
    assert data["run_count"] == 0
    assert data["token_total"] == 0
    assert data["cost_total"] == "0"
    assert data["error_count"] == 0
    assert data["duration_seconds_total"] == 0
    assert data["summary_count"] == 0
    assert data["window_start"] is None
    assert data["window_end"] is None


def test_board_response_has_no_session_or_drilldown_fields(client):
    """红线（D13）：看板/企业行只暴露脱敏聚合标量，无会话内容、无成员/明细下钻字段。"""
    client.post("/api/operation/rollups",
                json=_upload_body("e1", "t1", "s1"), headers=_auth(_OP))
    board = client.get("/api/operation/rollups/board", headers=_auth(_OP)).json()["data"]
    allowed_row = {
        "enterprise_id", "tenant_id", "run_count", "token_total", "cost_total",
        "error_count", "duration_seconds_total", "summary_count",
        "window_start", "window_end",
    }
    for row in board["enterprises"]:
        assert set(row).issubset(allowed_row)
        for forbidden in ("messages", "conversation", "content", "tokens", "member_id", "employee_detail"):
            assert forbidden not in row


def test_ingest_rejects_extra_fields_422(client):
    """extra=forbid：上报体不接受未声明字段（防夹带明细）。"""
    body = _upload_body("e1", "t1", "s1")
    body["summaries"][0]["conversation_text"] = "secret leaked content"
    r = client.post("/api/operation/rollups", json=body, headers=_auth(_OP))
    assert r.status_code == 422
    assert r.json()["code"] == "validation_error"


def test_openapi_exposes_rollup_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/operation/rollups" in paths
    assert "/api/operation/rollups/board" in paths
    assert "/api/operation/rollups/{enterprise_id}" in paths


# ---- 治理汇总报表路由测试（/api/operation/rollups/report）----

def _report_body(ent: str, tenant: str, summary_id: str, day: str, **kw) -> dict:
    summary = {
        "summary_id": summary_id,
        "tenant_id": tenant,
        "window_start": f"{day}T00:00:00",
        "window_end": f"{day}T23:59:59",
        "run_count": 2,
        "token_total": 100,
        "cost_total": "1.50",
        "error_count": 0,
        "duration_seconds_total": 10,
    }
    summary.update(kw)
    return {"enterprise_id": ent, "tenant_id": tenant, "summaries": [summary]}


def test_openapi_exposes_report_route(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/operation/rollups/report" in paths
    assert paths["/api/operation/rollups/report"]["get"]["operationId"] == "operation_rollup_report"


def test_report_requires_auth(client):
    r = client.get("/api/operation/rollups/report")
    assert r.status_code == 401


def test_report_forbidden_for_non_platform_role(client):
    r = client.get("/api/operation/rollups/report", headers=_auth(EnterpriseRole.MEMBER.value))
    assert r.status_code == 403


def test_report_returns_daily_aggregation(client):
    client.post("/api/operation/rollups",
                json=_report_body("e1", "t1", "s1", "2026-06-01", token_total=100),
                headers=_auth(_OP))
    client.post("/api/operation/rollups",
                json=_report_body("e1", "t1", "s2", "2026-06-02", token_total=50),
                headers=_auth(_OP))
    client.post("/api/operation/rollups",
                json=_report_body("e2", "t2", "s3", "2026-06-01", token_total=300),
                headers=_auth(_OP))
    r = client.get("/api/operation/rollups/report?period=day&metric=token_total", headers=_auth(_OP))
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["period"] == "day"
    assert data["metric"] == "token_total"
    assert data["totals"]["token_total"] == 450
    assert len(data["buckets"]) == 2
    # 排名 e2(300) > e1(150)
    assert data["ranking"][0]["enterprise_id"] == "e2"
    assert data["ranking"][0]["metric_value"] == 300


def test_report_invalid_period_returns_422(client):
    r = client.get("/api/operation/rollups/report?period=century", headers=_auth(_OP))
    assert r.status_code in (400, 422)


def test_report_window_filters_current_only(client):
    client.post("/api/operation/rollups",
                json=_report_body("e1", "t1", "w1", "2026-06-10", token_total=100),
                headers=_auth(_OP))
    client.post("/api/operation/rollups",
                json=_report_body("e1", "t1", "w2", "2026-05-10", token_total=999),
                headers=_auth(_OP))
    r = client.get(
        "/api/operation/rollups/report?period=day&metric=token_total"
        "&window_start=2026-06-10T00:00:00&window_end=2026-06-11T00:00:00",
        headers=_auth(_OP),
    )
    data = r.json()["data"]
    assert data["totals"]["token_total"] == 100


def test_trend_with_baseline_growth(client):
    # 本期 6/10, 上期 6/9 (span 1d → prev [6/9,6/10))
    client.post("/api/operation/rollups",
                json=_report_body("e1", "t1", "g1", "2026-06-10", token_total=100),
                headers=_auth(_OP))
    client.post("/api/operation/rollups",
                json=_report_body("e1", "t1", "g2", "2026-06-09", token_total=50),
                headers=_auth(_OP))
    r = client.get(
        "/api/operation/rollups/report?period=day&metric=token_total"
        "&window_start=2026-06-10T00:00:00&window_end=2026-06-11T00:00:00",
        headers=_auth(_OP),
    )
    data = r.json()["data"]
    trend = data["trends"][0]
    assert trend["current"] == 100
    assert trend["previous"] == 50
    assert trend["growth_pct"] == 100.0
