"""Source-named runtime protocol and auto-consent authorization regressions."""
from types import SimpleNamespace as NS
from unittest.mock import Mock

import httpx
import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from manager_service.hindsight_credentials import HindsightRuntimeService
from manager_service.hindsight_facade import HindsightFacade
from manager_service.routes_hindsight import build_hindsight_router
from shared.app_factory import create_app
from shared.config import Settings
from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token
from tests.manager.test_hindsight_credentials import _Snapshot, _settings

PROTOCOL = "aiteam-memory-v1"


@pytest.fixture
def consent():
    policy = {"enabled": True, "allowed_operations": ["recall", "retain"], "revision": 1, "explicit_auto_retain": True}
    snapshot = _Snapshot(policy)
    runtime = HindsightRuntimeService(snapshot_service=snapshot, settings=_settings(), bank_client=Mock())
    verifier, signer = make_inmem_verifier_and_signer()
    app = create_app(Settings(tier="manager", service_name="consent-fixture"), APIRouter())
    app.state._hindsight_runtime_service = runtime
    calls = []
    async def upstream(request):
        calls.append(request)
        return httpx.Response(200, json={"results": [], "success": True})
    facade = HindsightFacade(settings=_settings(), leases=runtime.leases, snapshot_service=snapshot,
        principal_repository=Mock(find_user=Mock(return_value=NS(status="active", roles=["member"]))),
        client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    app.state._hindsight_facade = facade
    app.include_router(build_hindsight_router(verifier))
    auth = {"Authorization": "Bearer " + sign_inmem_token(signer, "tenant-1", ["member"], user_id="member-1")}
    return NS(client=TestClient(app), snapshot=snapshot, runtime=runtime, facade=facade, calls=calls, auth=auth)


def issue(f, protocol=PROTOCOL):
    body = {"employee_id": "employee-1"}
    if protocol is not None:
        body["client_protocol"] = protocol
    return f.client.post("/api/manager/hindsight/runtime-config", headers=f.auth, json=body)


def operation(f, config, op="retain", **extra):
    return f.client.post(f"/api/manager/hindsight/v1/default/banks/{config['bank_id']}/memories" + ("/recall" if op == "recall" else ""),
        headers={"Authorization": "Bearer " + config["token"]},
        json={**({"query": "fixture"} if op == "recall" else {"items": [{"content": "explicit fixture retain"}]}), **extra})


@pytest.mark.parametrize("protocol", [None, "old-automatic-v0", "future-unknown-v2"])
def test_unsupported_client_only_receives_read_scope_even_with_auto_consent(consent, protocol):
    f = consent
    response = issue(f, protocol)
    assert response.status_code == 200, response.text
    config = response.json()["data"]
    assert config["allowed_operations"] == ["recall"]
    assert config["explicit_auto_retain"] is False and config["client_protocol"] is None
    assert operation(f, config).status_code == 403
    assert operation(f, config, "recall").status_code == 200
    assert len(f.calls) == 1


def test_unsupported_retain_only_client_requires_upgrade(consent):
    f = consent
    f.snapshot.value.memory_policy = {"enabled": True, "allowed_operations": ["retain"], "revision": 1}
    response = issue(f, None)
    assert response.status_code == 409
    assert response.json()["code"] == "hindsight_client_upgrade_required"
    assert f.calls == []


def test_current_runtime_consent_and_revision_gate_old_write_leases(consent):
    f = consent
    first = issue(f)
    assert first.status_code == 200, first.text
    config = first.json()["data"]
    assert config["client_protocol"] == PROTOCOL and config["explicit_auto_retain"] is True
    assert operation(f, config).status_code == 200
    f.snapshot.value.memory_policy = {**f.snapshot.value.memory_policy, "explicit_auto_retain": False, "revision": 2}
    assert operation(f, config).status_code == 403
    assert operation(f, config, "recall").status_code == 200
    fresh = issue(f).json()["data"]
    assert fresh["explicit_auto_retain"] is False and fresh["policy_revision"] == 2
    assert fresh["allowed_operations"] == ["recall", "retain"]
    assert operation(f, fresh).status_code == 200  # manual capability is not human-approval evidence
    assert fresh["lease_id"] != config["lease_id"]
    assert operation(f, fresh, intent="manual").status_code == 403


def test_negotiation_rotates_compatible_read_only_lease_instead_of_reusing_legacy_material(consent):
    f = consent
    f.snapshot.value.memory_policy = {"enabled": True, "allowed_operations": ["recall"], "revision": 1}
    old = issue(f, None).json()["data"]
    new = issue(f).json()["data"]
    assert new["lease_id"] != old["lease_id"]
    assert issue(f).json()["data"]["lease_id"] == new["lease_id"]
    assert f.calls == []


def test_policy_revision_change_during_acceptance_preparation_blocks_native_send(consent):
    f = consent
    config = issue(f).json()["data"]
    def prepare(*args, **kwargs):
        f.snapshot.value.memory_policy = {**f.snapshot.value.memory_policy, "revision": 2, "explicit_auto_retain": False}
        return kwargs["body"]
    f.facade._retention = Mock(prepare=Mock(side_effect=prepare))
    response = operation(f, config)
    assert response.status_code == 403 and f.calls == []


def test_later_revocation_does_not_claim_to_roll_back_already_sent_async_request(consent):
    f = consent
    config = issue(f).json()["data"]
    async def upstream(request):
        f.calls.append(request)  # native handoff has already occurred
        f.snapshot.value.memory_policy = {**f.snapshot.value.memory_policy, "revision": 2, "explicit_auto_retain": False}
        return httpx.Response(200, json={"success": True})
    f.facade._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    assert operation(f, config).status_code == 403
    assert operation(f, config).status_code == 403
    assert len(f.calls) == 1  # no rollback or automatic replay is claimed


def test_real_openapi_describes_protocol_and_server_consent(consent):
    spec = consent.client.get("/openapi.json").json()
    schemas = spec["components"]["schemas"]
    assert "client_protocol" in schemas["HindsightRuntimeConfigRequest"]["properties"]
    runtime = schemas["HindsightRuntimeConfigOut"]
    assert runtime["properties"]["allowed_operations"]["items"]["enum"] == ["recall", "retain"]
    assert runtime["properties"]["allowed_operations"]["maxItems"] == 2
    assert runtime["properties"]["retention_mode"]["enum"] == ["unlimited", "fact_only"]
    assert {"allowed_operations", "policy_revision", "client_protocol", "explicit_auto_retain", "retention_mode"} <= set(runtime["required"])
    operation = spec["paths"]["/api/manager/hindsight/runtime-config"]["post"]
    assert operation["responses"]["409"]["$ref"] == "#/components/responses/HindsightClientUpgradeRequired"
    request_example = next(iter(operation["requestBody"]["content"]["application/json"]["examples"].values()))["value"]
    assert request_example["client_protocol"] == PROTOCOL
    response_examples = next(iter(operation["responses"]["200"]["content"]["application/json"]["examples"].values()))
    current = response_examples["value"]["data"]
    assert current["client_protocol"] == PROTOCOL
    assert set(current["allowed_operations"]) <= {"recall", "retain"}
    assert current["policy_revision"] > 0
    assert current["retention_mode"] in {"unlimited", "fact_only"}


def test_hindsight_runbook_matches_runtime_wire_contract():
    from pathlib import Path

    runbook = (Path(__file__).parents[3] / "docs/部署运维/Hindsight-Manager-facade-lease.md").read_text()
    for value in ("client_protocol", "aiteam-memory-v1", "allowed_operations", "policy_revision", "retention_mode", "fact_only", "hindsight_client_upgrade_required"):
        assert value in runbook
    assert "profile" in runbook and "memories/recall" in runbook and "memories`" in runbook
    assert "PUT/PATCH/DELETE" in runbook and "未知 query" in runbook


def test_model_declared_manual_metadata_cannot_override_cancelled_consent_revision(consent):
    f = consent
    config = issue(f).json()["data"]
    f.snapshot.value.memory_policy = {**f.snapshot.value.memory_policy, "revision": 2, "explicit_auto_retain": False}
    response = f.client.post(f"/api/manager/hindsight/v1/default/banks/{config['bank_id']}/memories",
        headers={"Authorization": "Bearer " + config["token"]},
        json={"items": [{"content": "must not be forwarded", "metadata": {"retainSource": "tool", "intent": "manual"}}]})
    assert response.status_code == 403 and f.calls == []
