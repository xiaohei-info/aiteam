import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from manager_service.hindsight_client import HindsightClient, HindsightUnavailable
from manager_service.hindsight_credentials import HindsightLeaseStore, HindsightRuntimeService, derive_hindsight_bank_id
from manager_service.hindsight_facade import HindsightFacade
from manager_service.hindsight_operation_policy import parse_operation_body, scoped_retain_body
from manager_service.schemas_hindsight import HINDSIGHT_CLIENT_PROTOCOL
from shared.errors import Forbidden
from tests.manager.test_hindsight_facade import _app, _settings
from tests.manager.test_hindsight_credentials import _Snapshot, _ctx


@pytest.fixture
def scope():
    now = [datetime.now(timezone.utc)]
    leases = HindsightLeaseStore(now=lambda: now[0])
    policy = {"enabled": True, "allowed_operations": ["recall"], "revision": 3}
    snapshot = _Snapshot(policy)
    lease = leases.issue(tenant_id="tenant-1", member_id="member-1", employee_id="employee-1",
                         snapshot_version="s", policy=policy, bank_id="bank-a")
    principal = NS(status="active", roles=["member"])
    principals = Mock(find_user=Mock(return_value=principal))
    seen = []
    def upstream(request):
        seen.append(request)
        return httpx.Response(200, json={"results": [{"text": "fixture"}]})
    facade = HindsightFacade(settings=_settings(), leases=leases, snapshot_service=snapshot,
                             principal_repository=principals, client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    return NS(client=TestClient(_app(facade)), headers={"Authorization": "Bearer " + lease.token}, lease=lease,
              policy=policy, snapshot=snapshot, principal=principal, principals=principals, seen=seen,
              now=now, leases=leases, facade=facade, base="/api/manager/hindsight/v1/default/banks/bank-a")


def test_readonly_initial_profile_needs_no_upstream_write_and_recall_succeeds(scope):
    f = scope
    profile = f.client.get(f.base + "/profile", headers=f.headers)
    assert profile.status_code == 200 and profile.json()["mission"] == ""
    assert f.seen == []
    assert f.client.post(f.base + "/memories/recall", headers=f.headers, json={"query": "fixture"}).status_code == 200
    assert len(f.seen) == 1


@pytest.mark.parametrize("method,suffix,body", [
    ("PUT", "", {}), ("DELETE", "", None), ("PATCH", "/memories/one", {"state": "invalidated"}),
    ("GET", "/memories/list", None), ("POST", "/reflect", {"query": "x"}),
    ("GET", "/config", None), ("GET", "/mental-models", None),
    ("POST", "/memories", {"items": [{"content": "denied"}]}),
    ("POST", "/memories/recall?q=x", {"query": "x"}),
    ("POST", "/memories/%72ecall", {"query": "x"}),
    ("POST", "/memories/%2572ecall", {"query": "x"}),
    ("POST", "/memories/recall/", {"query": "x"}),
])
def test_exact_method_path_operation_allowlist_denies_with_zero_upstream(scope, method, suffix, body):
    f = scope
    response = f.client.request(method, f.base + suffix, headers=f.headers, json=body)
    assert response.status_code == 403
    assert f.seen == []


@pytest.mark.parametrize("mutation,status", [("disabled", 403), ("deleted", 401), ("policy", 403), ("grant", 403), ("lifecycle", 403), ("expiry", 401), ("revoke", 401), ("retention", 503)])
def test_old_lease_checks_current_identity_policy_grant_lifecycle_and_expiry(scope, mutation, status):
    f = scope
    if mutation == "disabled": f.principal.status = "disabled"
    if mutation == "deleted": f.principals.find_user.return_value = None
    if mutation == "policy": f.snapshot.value.memory_policy = {"enabled": False}
    if mutation == "grant": f.snapshot.generate = Mock(side_effect=Forbidden("grant denied"))
    if mutation == "lifecycle": f.snapshot._ensure_runnable = Mock(side_effect=Forbidden("not runnable"))
    if mutation == "expiry": f.now[0] += timedelta(seconds=301)
    if mutation == "revoke": f.leases.revoke(f.lease.lease_id)
    if mutation == "retention": f.snapshot.value.memory_policy = {**f.policy, "retention_days": 1}
    assert f.client.post(f.base + "/memories/recall", headers=f.headers, json={"query": "x"}).status_code == status
    assert f.seen == []


def test_relaxing_current_policy_never_enlarges_old_lease_and_retain_only_cannot_recall(scope):
    f = scope
    f.snapshot.value.memory_policy = {"enabled": True, "allowed_operations": ["recall", "retain"], "revision": 4}
    assert f.client.post(f.base + "/memories", headers=f.headers, json={"items": [{"content": "x"}]}).status_code == 403
    fresh = f.leases.issue(tenant_id="tenant-1", member_id="member-1", employee_id="employee-1", bank_id="bank-a", snapshot_version="s2", policy={"allowed_operations": ["retain"], "revision": 4}, client_protocol=HINDSIGHT_CLIENT_PROTOCOL)
    headers = {"Authorization": "Bearer " + fresh.token}
    assert f.client.post(f.base + "/memories/recall", headers=headers, json={"query": "x"}).status_code == 403
    assert f.client.post(f.base + "/memories", headers=headers, json={"items": [{"content": "x"}]}).status_code == 200
    assert len(f.seen) == 1


def test_revoke_during_upstream_wait_discards_result(scope):
    f = scope
    def upstream(request):
        f.principal.status = "disabled"
        return httpx.Response(200, json={"results": [{"text": "must not be delivered"}]})
    f.facade._client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    result = f.client.post(f.base + "/memories/recall", headers=f.headers, json={"query": "x"})
    assert result.status_code == 403 and "must not be delivered" not in result.text


@pytest.mark.parametrize("body", [b'{"query":"x","query":"y"}', b'{"query":"x","trace":true}', b'{"query":"x","include":{"unknown":{}}}', b'{"query":"x","bank":"other"}', b'{"query":NaN}', b'{"query":"x","unknown":1}'])
def test_body_is_strict_and_content_free_errors(scope, body):
    f = scope
    result = f.client.post(f.base + "/memories/recall", headers={**f.headers, "Content-Type": "application/json"}, content=body)
    assert result.status_code == 403 and f.seen == []


def test_body_limit_does_not_read_or_forward_unbounded_content(scope):
    f = scope
    result = f.client.post(f.base + "/memories/recall", headers={**f.headers, "Content-Type": "application/json"}, content=b"x" * (256 * 1024 + 1))
    assert result.status_code == 403 and f.seen == []


def test_trusted_retain_document_operation_scope_and_retry_identity():
    body = {"items": [{"content": "fixture", "document_id": "victim", "update_mode": "replace", "strategy": "conversation", "metadata": {"cwd": "/private/path", "pi_session_file": "/session", "label": "ok"}}], "operation_id": "victim-operation", "async": True}
    parsed = parse_operation_body("retain", json.dumps(body).encode())
    scoped = scoped_retain_body(parsed, tenant_id="t", member_id="m", employee_id="e")
    assert scoped == scoped_retain_body(parsed, tenant_id="t", member_id="m", employee_id="e")
    assert scoped["operation_id"] != body["operation_id"]
    assert scoped["items"][0]["document_id"] != "victim"
    assert scoped["items"][0]["metadata"] == {"label": "ok"}
    assert "strategy" not in scoped["items"][0] and "update_mode" not in scoped["items"][0]
    assert scoped != scoped_retain_body(parsed, tenant_id="t", member_id="other", employee_id="e")


def test_trusted_bank_get_then_put_only_on_confirmed_404_and_preserve_existing():
    bank = derive_hindsight_bank_id("tenant-1", "member-1", "employee-1")
    exists = [False]
    seen = []
    def upstream(request):
        seen.append(request.method)
        if request.method == "PUT":
            exists[0] = True
            return httpx.Response(200, json={"bank_id": bank})
        return httpx.Response(200 if exists[0] else 404, json={"bank_id": bank})
    banks = HindsightClient(_settings(), client=httpx.Client(transport=httpx.MockTransport(upstream)))
    service = HindsightRuntimeService(snapshot_service=_Snapshot({"enabled": True}), settings=_settings(), bank_client=banks)
    config = service.runtime_config(_ctx(), employee_id="employee-1")
    assert config.allowed_operations == ["recall"]
    service.runtime_config(_ctx(), employee_id="employee-1")
    assert seen == ["GET", "PUT", "GET", "GET"]


@pytest.mark.parametrize("status", [301, 401, 403, 500])
def test_uncertain_bank_status_never_causes_put(status):
    seen = []
    def upstream(request):
        seen.append(request.method)
        return httpx.Response(status)
    banks = HindsightClient(_settings(), client=httpx.Client(transport=httpx.MockTransport(upstream)))
    with pytest.raises(HindsightUnavailable):
        banks.ensure_bank(_ctx(), employee_id="employee-1")
    assert seen == ["GET"]
