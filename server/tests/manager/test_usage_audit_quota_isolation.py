"""企业级 usage/audit rollup + 软配额治理 integration（M8，04 §6.5/§6.5.1，D13/D24，真 PG RLS）。

验：
- F13 上报全链路：service-token POST /usage/upload → 落库聚合 → GET 查询可见（201/200，envelope）。
- usage/audit rollup 按 summary_id 幂等去重。
- 跨租户 RLS：t-a 上报的 usage/audit，t-b 查不到（D22）。
- 软配额策略 CRUD HTTP 全链路（201/200/204），version 自增。
- 软配额评估：soft 模式超阈只产出告警建议，不产出 block_new_runs（D24）。
- member 写配额 → 403；读允许。
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from tests.manager._auth_helper import (
    make_inmem_verifier_and_signer,
    make_verifier,
    sign_inmem_token,
    sign_token,
)

pytestmark = pytest.mark.integration

# 无 admin_url fallback 用固定 RSA key 的 inmem verifier/signer（本文件全部 integration，预留）。
_INMEM_VERIFIER, _INMEM_SIGNER = make_inmem_verifier_and_signer()


def _client(db_url: str, admin_url: str | None = None) -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_auth import router as auth_router
    from manager_service.routes_usage_audit_quota import build_usage_audit_quota_router

    verifier = make_verifier(admin_url) if admin_url else _INMEM_VERIFIER

    settings = Settings(
        tier="manager",
        service_name="aiteam-manager-service",
        db_url=db_url,
        service_token="test-service-token",
    )
    app = create_app(settings, manager_router)
    app.include_router(auth_router)
    app.include_router(build_usage_audit_quota_router(verifier))
    return TestClient(app)


def _token(
    tenant_id: str,
    roles: list[str],
    user_id: str | None = None,
    *,
    admin_url: str | None = None,
) -> str:
    uid = user_id or str(uuid.uuid4())
    if admin_url:
        return sign_token(admin_url, tenant_id, roles, user_id=uid)
    return sign_inmem_token(_INMEM_SIGNER, tenant_id, roles, user_id=uid)


def _usage(summary_id: str, **overrides) -> dict:
    base = {
        "summary_id": summary_id,
        "window_start": "2026-01-10T00:00:00Z",
        "window_end": "2026-01-11T00:00:00Z",
        "run_count": 5,
        "token_total": 10000,
        "cost_total": "1.50",
        "error_count": 1,
        "duration_seconds_total": 600,
    }
    base.update(overrides)
    return base


def test_usage_audit_upload_and_cross_tenant_rls(migrated_db, admin_url, two_tenants):
    tid_a, tid_b = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a", admin_url=admin_url)

    upload = {
        "tenant_id": tid_a,
        "usage": [_usage("s1"), _usage("s2", run_count=3)],
        "audits": [{
            "summary_id": "a1", "actor": "member-x", "action": "expert_load",
            "resource_type": "expert", "resource_id": "e1",
            "occurred_at": "2026-01-10T12:00:00Z",
        }],
    }
    r = client.post(
        "/api/manager/usage/upload", json=upload, headers={"X-Service-Token": "test-service-token"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {"usage_ingested": 2, "audits_ingested": 1}

    # t-a 查可见
    r = client.get(
        "/api/manager/usage/rollup/list", headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    assert len(r.json()["data"]) == 2

    r = client.get("/api/manager/audits", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200
    assert len(r.json()["data"]) == 1
    assert r.json()["data"][0]["action"] == "expert_load"

    # 跨租户：t-b 看不到 t-a 的 usage/audit（RLS 强制）
    owner_b = _token(tid_b, ["owner"], user_id="owner-b", admin_url=admin_url)
    r = client.get(
        "/api/manager/usage/rollup/list", headers={"Authorization": f"Bearer {owner_b}"},
    )
    assert r.status_code == 200
    assert r.json()["data"] == []
    r = client.get("/api/manager/audits", headers={"Authorization": f"Bearer {owner_b}"})
    assert r.status_code == 200
    assert r.json()["data"] == []

    # 幂等：同 summary_id 重复上报不新增
    client.post(
        "/api/manager/usage/upload", json=upload, headers={"X-Service-Token": "test-service-token"},
    )
    r = client.get(
        "/api/manager/usage/rollup/list", headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert len(r.json()["data"]) == 2  # 幂等去重


def test_usage_aggregate_by_window(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], admin_url=admin_url)
    client.post(
        "/api/manager/usage/upload",
        json={"tenant_id": tid_a, "usage": [_usage("s1", run_count=5, token_total=1000)]},
        headers={"X-Service-Token": "test-service-token"},
    )
    r = client.get(
        "/api/manager/usage/rollup?window_start=2026-01-01T00:00:00Z&window_end=2026-02-01T00:00:00Z",
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["rollup_count"] == 1
    assert data["run_count"] == 5
    assert data["token_total"] == 1000


def test_quota_policy_crud_e2e_and_member_403(migrated_db, admin_url, two_tenants):
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], user_id="owner-a", admin_url=admin_url)

    body = {
        "policy_slug": "default",
        "display_name": "默认软配额",
        "scope": "tenant",
        "window_start": "2026-01-01T00:00:00Z",
        "window_end": "2026-02-01T00:00:00Z",
        "dimensions": {"cost_cap_usd": 100, "token_cap": 1000000, "run_cap": 500},
        "enforcement": "soft",
        "status": "active",
    }
    r = client.post(
        "/api/manager/quota-policies", json=body, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201, r.text
    created = r.json()["data"]
    assert created["policy_slug"] == "default"
    assert created["enforcement"] == "soft"
    assert created["version"] == 1
    pid = created["policy_id"]

    # get
    r = client.get(f"/api/manager/quota-policies/{pid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 200

    # update -> version 自增
    body["display_name"] = "改名"
    r = client.put(
        f"/api/manager/quota-policies/{pid}", json=body, headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200
    assert r.json()["data"]["display_name"] == "改名"
    assert r.json()["data"]["version"] == 2

    # member 写 → 403；读允许
    member_a = _token(tid_a, ["member"], user_id="mem-a", admin_url=admin_url)
    r = client.get(f"/api/manager/quota-policies/{pid}", headers={"Authorization": f"Bearer {member_a}"})
    assert r.status_code == 200
    r = client.put(
        f"/api/manager/quota-policies/{pid}", json=body, headers={"Authorization": f"Bearer {member_a}"},
    )
    assert r.status_code == 403
    assert r.headers["content-type"].startswith("application/problem+json")

    # delete
    r = client.delete(f"/api/manager/quota-policies/{pid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 204
    r = client.get(f"/api/manager/quota-policies/{pid}", headers={"Authorization": f"Bearer {owner_a}"})
    assert r.status_code == 404


def test_quota_evaluate_soft_does_not_block(migrated_db, admin_url, two_tenants):
    """soft 模式超阈：产出告警/限流建议，但不产出 block_new_runs（D24）。"""
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    owner_a = _token(tid_a, ["owner"], admin_url=admin_url)

    r = client.post(
        "/api/manager/quota-policies",
        json={
            "policy_slug": "cap",
            "window_start": "2026-01-01T00:00:00Z",
            "window_end": "2026-02-01T00:00:00Z",
            "dimensions": {"cost_cap_usd": 100},
            "enforcement": "soft",
        },
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 201
    pid = r.json()["data"]["policy_id"]

    # 上报超阈 usage
    upload_resp = client.post(
        "/api/manager/usage/upload",
        json={"tenant_id": tid_a, "usage": [_usage("s1", run_count=10, cost_total="150.00")]},
        headers={"X-Service-Token": "test-service-token"},
    )
    assert upload_resp.status_code == 200, upload_resp.text

    r = client.post(
        f"/api/manager/quota-policies/{pid}/evaluate"
        "?window_start=2026-01-01T00:00:00Z&window_end=2026-02-01T00:00:00Z",
        headers={"Authorization": f"Bearer {owner_a}"},
    )
    assert r.status_code == 200, r.text
    action = r.json()["data"]
    assert action["enforcement"] == "soft"
    assert "block_new_runs" not in action["actions"]
    assert any(a in action["actions"] for a in ("notify_owner", "suggest_throttle", "alert_threshold"))


def test_ingest_rejects_conversation_content_at_http(migrated_db, admin_url, two_tenants):
    """D13 红线（真库）：上报体含会话内容字段 → 422（service 层断言，经 HTTP 透传 problem+json）。"""
    tid_a, _ = two_tenants
    client = _client(migrated_db, admin_url=admin_url)
    bad_usage = _usage("s-bad")
    bad_usage["message"] = "敏感会话内容"
    r = client.post(
        "/api/manager/usage/upload",
        json={"tenant_id": tid_a, "usage": [bad_usage]},
        headers={"X-Service-Token": "test-service-token"},
    )
    assert r.status_code == 422
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "validation_error"
