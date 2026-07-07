"""A4 验收：grants 北向路由（触发 sync + 列投影 + 列冻结快照）。


经 TestClient 验证端点装配与 envelope 形状；用 fake grants_client 注入，不真连 Manager。
含离线降级端点行为（sync 返回 ok=False，不返回 5xx、不崩）。
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent_service.app import build_app
from agent_service.grants.factory import build_grants_service
from agent_service.grants.routes import build_grants_router
import pytest

from shared.contracts.crosstier import (
    AuthorizedConfigPullRequest,
    AuthorizedConfigPullResponse,
    SnapshotPullRequest,
    SnapshotPullResponse,
)


class FakeGrantsClient:
    def __init__(self) -> None:
        self.config_response = AuthorizedConfigPullResponse(
            experts=[{"employee_id": "e1", "version": "v1", "display_name": "甲"}]
        )
        self.unreachable = False

    def pull_authorized_config(
        self, request: AuthorizedConfigPullRequest
    ) -> AuthorizedConfigPullResponse:
        if self.unreachable:
            raise RuntimeError("manager unreachable")
        return self.config_response

    def pull_snapshot(self, request: SnapshotPullRequest) -> SnapshotPullResponse:  # pragma: no cover
        raise NotImplementedError


def _http(service) -> TestClient:
    app = FastAPI()
    app.include_router(build_grants_router(service))
    return TestClient(app)


def test_sync_and_list_experts_endpoints():
    client = FakeGrantsClient()
    service = build_grants_service(client=client)
    http = _http(service)

    synced = http.post("/api/agent/grants/sync", json={"tenant_id": "t1", "member_id": "m1"})
    assert synced.status_code == 200
    body = synced.json()["data"]
    assert body["ok"] is True and body["upserted"] == 1

    listed = http.get("/api/agent/grants/experts")
    assert listed.status_code == 200
    assert [e["employee_id"] for e in listed.json()["data"]] == ["e1"]


def test_sync_offline_returns_ok_false_not_5xx():
    """Manager 离线：sync 端点返回 200 + ok=False（降级），不返回 5xx、不崩。"""
    client = FakeGrantsClient()
    client.unreachable = True
    http = _http(build_grants_service(client=client))

    resp = http.post("/api/agent/grants/sync", json={"tenant_id": "t1", "member_id": "m1"})
    assert resp.status_code == 200
    assert resp.json()["data"]["ok"] is False


def test_default_app_wires_grants_routes():
    """默认 app 装配 grants 路由可访问；默认对端未配置 → experts 为空、不崩。"""
    http = TestClient(build_app())
    resp = http.get("/api/agent/grants/experts")
    assert resp.status_code == 200
    assert resp.json()["data"] == []

    snaps = http.get("/api/agent/grants/snapshots")
    assert snaps.status_code == 200
    assert snaps.json()["data"] == []


def test_list_solutions_empty_when_no_pull(client_with_fake):
    """未 sync 时列方案实例返回空列表（不 5xx）。"""
    client, _ = client_with_fake
    r = client.get("/api/agent/grants/solutions")
    assert r.status_code == 200
    data = r.json()
    assert data["data"] == []
    assert data["page"]["has_more"] is False


def test_list_solutions_after_sync_exposes_three_stage_prompts(client_with_fake):
    """sync 后 /grants/solutions 返回三阶段 prompts，字段对齐前端契约（solution_instance_id）。"""
    client, fake = client_with_fake
    fake.config_response = AuthorizedConfigPullResponse(
        experts=[],
        solutions=[
            {   # id=instance id, solution_id=Operator template id
                "id": "si-1",
                "solution_id": "tpl-1",
                "version": "v1",
                "display_name": "方案A",
                "planner_prompt": "pa",
                "subtask_prompt": "sa",
                "aggregate_prompt": "aa",
            },
        ],
        revoked_ids=[],
    )
    # trigger sync
    r = client.post("/api/agent/grants/sync", json={"tenant_id": "t1", "member_id": "m1"})
    assert r.status_code == 200
    assert r.json()["data"]["ok"] is True

    r = client.get("/api/agent/grants/solutions")
    assert r.status_code == 200
    items = r.json()["data"]
    assert len(items) == 1
    assert items[0]["solution_instance_id"] == "si-1"  # instance id, not template id
    assert items[0]["display_name"] == "方案A"
    assert items[0]["planner_prompt"] == "pa"
    assert items[0]["subtask_prompt"] == "sa"
    assert items[0]["aggregate_prompt"] == "aa"


@pytest.fixture()
def client_with_fake():
    fake = FakeGrantsClient()
    svc = build_grants_service(client=fake)
    app = FastAPI()
    from fastapi.testclient import TestClient
    app.include_router(build_grants_router(svc))
    return TestClient(app), fake


def test_readiness_report_endpoint(monkeypatch):
    """整端 readiness 端点返回 runtime + 每个专家可用态。"""
    import agent_gateway.drivers.base as _base_mod

    monkeypatch.setattr(_base_mod.shutil, "which", lambda _p: "/usr/local/bin/hermes")
    monkeypatch.setattr(_base_mod.subprocess, "run",
                        lambda *a, **k: type("R", (), {"stdout": "h", "stderr": ""})())

    client = FakeGrantsClient()
    service = build_grants_service(client=client)
    http = _http(service)
    # sync so e1 is available
    assert http.post("/api/agent/grants/sync", json={"tenant_id": "t1", "member_id": "m1"}).status_code == 200

    resp = http.get("/api/agent/grants/readiness")
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert "runtime" in body
    assert any(e["employee_id"] == "e1" for e in body["experts"])


def test_readiness_expert_endpoint(monkeypatch):
    """单个专家 readiness 端点。"""
    import agent_gateway.drivers.base as _base_mod

    monkeypatch.setattr(_base_mod.shutil, "which", lambda _p: "/usr/local/bin/hermes")
    client = FakeGrantsClient()
    service = build_grants_service(client=client)
    http = _http(service)
    assert http.post("/api/agent/grants/sync", json={"tenant_id": "t1", "member_id": "m1"}).status_code == 200

    resp = http.get("/api/agent/grants/experts/e1/readiness")
    assert resp.status_code == 200
    body = resp.json()["data"]
    assert body["employee_id"] == "e1"
    assert "runtime" in body and "provider" in body and "available" in body


def test_readiness_expert_missing_returns_available_false(monkeypatch):
    """未知专家 → 端点仍返回 200，available=False。"""
    import agent_gateway.drivers.base as _base_mod

    monkeypatch.setattr(_base_mod.shutil, "which", lambda _p: "/usr/local/bin/hermes")
    http = _http(build_grants_service(client=FakeGrantsClient()))
    resp = http.get("/api/agent/grants/experts/does-not-exist/readiness")
    assert resp.status_code == 200
    assert resp.json()["data"]["available"] is False


def test_run_provenance_route_resolves_snapshot(monkeypatch):
    """provenance 端点经 snapshot_for_run 解析快照，暴露 capability 摘要。"""
    from shared.contracts.snapshot import (
        EmployeeExecutionSnapshot, ModelPolicy, RuntimePolicy,
    )
    from agent_service.app import build_app
    from agent_service.grants.factory import build_grants_service

    class FakeClient:
        def pull_authorized_config(self, request=None):
            from shared.contracts.crosstier import AuthorizedConfigPullResponse
            return AuthorizedConfigPullResponse()

        def pull_snapshot(self, request):
            from shared.contracts.crosstier import SnapshotPullResponse
            snap = EmployeeExecutionSnapshot(
                employee_id="e1", version="v1", snapshot_version="s1",
                persona="资深工程师",
                model_policy=ModelPolicy(model="gpt", provider_ref="openai"),
                runtime_policy=RuntimePolicy(runtime_binding="hermes"),
                skills=["code-review"], knowledge_refs=["kb-backend"],
                connector_refs=["slack"], memory_policy={"ref": "mem0"},
            )
            return SnapshotPullResponse(snapshot=snap)

    app = build_app(grants_client=FakeClient())
    http = TestClient(app)

    # create conversation with employee + message + run via mainline
    conv = http.post("/api/agent/conversations",
                     json={"title": "t", "entry_employee_id": "e1"}).json()["data"]
    cid = conv["id"]
    http.post(f"/api/agent/conversations/{cid}/messages",
              json={"role": "user", "content": "hi"})
    run_resp = http.post(f"/api/agent/conversations/{cid}/runs", json={}).json()
    run_id = run_resp["data"]["id"]

    resp = http.get(f"/api/agent/runs/{run_id}/provenance")
    assert resp.status_code == 200, resp.text
    body = resp.json()["data"]
    assert body["binding"]["employee_id"] == "e1"
    assert body["capability"]["knowledge_refs"] == ["kb-backend"]
    assert body["capability"]["connector_refs"] == ["slack"]
    assert body["capability"]["model"] == "gpt"
