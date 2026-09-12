from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest

from operation_service.newapi_client import NewApiAdminClient, NewApiError
from operation_service.platform_provider_repository import (
    AccessRow,
    ModelRow,
    PlatformProviderRepository,
    ProviderRow,
    RateRow,
    RelayTokenLifecycleRow,
    RelayTokenOperationRow,
)


NOW = datetime(2030, 1, 1, tzinfo=UTC)
_PROVIDER = {
    "provider_id": "p1",
    "provider_code": "newapi",
    "display_name": "LLM 网关",
    "relay_base_url": "http://relay/v1",
    "api_protocol": "openai-completions",
    "newapi_channel_id": 1,
    "status": "published",
    "version": 2,
    "updated_at": NOW,
}
_MODEL = {
    "provider_id": "p1",
    "model_id": "m1",
    "display_name": "Model 1",
    "capabilities": {"reasoning": True},
    "status": "published",
    "source": "discovery",
    "version": 3,
    "updated_at": NOW,
}
_RATE = {
    "rate_id": "r1",
    "provider_id": "p1",
    "model_id": "m1",
    "pricing_version": 1,
    "pricing_status": "known",
    "billing_mode": "token",
    "input_usd_per_million": Decimal("1"),
    "output_usd_per_million": Decimal("2"),
    "cache_read_usd_per_million": None,
    "cache_write_usd_per_million": None,
    "request_usd": None,
    "currency": "USD",
    "source": "manual",
    "source_version": None,
    "effective_from": NOW,
    "effective_to": None,
    "manually_overridden": True,
}
_ACCESS = {
    "access_id": "a1",
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "provider_id": "22222222-2222-2222-2222-222222222222",
    "encrypted_token": bytearray(b"relay"),
    "encrypted_management_token": bytearray(b"management"),
    "allowed_model_ids": ["m1"],
    "newapi_username": "attenant",
    "newapi_user_id": 11,
    "newapi_token_id": 7,
    "status": "active",
    "version": 2,
    "expires_at": NOW + timedelta(days=1),
    "encrypted_bootstrap_password": bytearray(b"bootstrap"),
    "policy_revision": "policy-1",
}
_LIFECYCLE = {
    "lifecycle_id": "33333333-3333-3333-3333-333333333333",
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "provider_id": "22222222-2222-2222-2222-222222222222",
    "newapi_user_id": 11,
    "newapi_token_id": 7,
    "token_name": "relay-v1",
    "allowed_model_ids": ["m1"],
    "expires_at": NOW + timedelta(days=1),
    "policy_revision": "policy-1",
    "status": "active",
    "revoked_at": None,
    "created_at": NOW,
    "updated_at": NOW,
}
_OPERATION = {
    "operation_id": "44444444-4444-4444-4444-444444444444",
    "tenant_id": "11111111-1111-1111-1111-111111111111",
    "provider_id": "22222222-2222-2222-2222-222222222222",
    "newapi_user_id": 11,
    "newapi_token_id": 7,
    "token_name": "relay-v1",
    "operation_type": "revoke",
    "operation_key": "relay:revoke:key",
    "desired_model_ids": ["m1"],
    "desired_expires_at": NOW + timedelta(days=1),
    "policy_revision": "policy-1",
    "expected_access_version": 2,
    "expected_access_token_id": 7,
    "bootstrap_state": "planned",
    "quota_before": None,
    "quota_delta": None,
    "create_attempt_state": "not_started",
    "user_create_state": "not_started",
    "status": "pending",
    "attempt_count": 0,
    "next_attempt_at": NOW,
    "lease_until": None,
    "claim_owner": None,
    "last_error": None,
    "created_at": NOW,
    "updated_at": NOW,
    "completed_at": None,
}


class _Result:
    def __init__(self, *, one=None, many=None):
        self._one = one
        self._many = [] if many is None else many

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._many


class _Connection:
    def __init__(self, *results):
        self.results = list(results)
        self.calls: list[tuple[str, tuple]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    @contextmanager
    def transaction(self):
        yield self

    def execute(self, sql, params=()):
        self.calls.append((sql, tuple(params)))
        if not self.results:
            raise AssertionError(f"unexpected SQL without scripted result: {sql}")
        return self.results.pop(0)


def _repo(*results):
    repository = PlatformProviderRepository("postgresql://test")
    connection = _Connection(*results)
    repository._connect = lambda: connection
    return repository, connection


def test_newapi_request_maps_http_json_and_transport_failures_and_close():
    responses = [
        httpx.Response(503, json={"success": True}),
        httpx.Response(200, content=b"not-json"),
    ]

    def handler(_request):
        return responses.pop(0)

    client = NewApiAdminClient(
        "http://newapi.test", "admin", "1", transport=httpx.MockTransport(handler),
    )
    with pytest.raises(NewApiError, match="HTTP 503"):
        client.pricing()
    with pytest.raises(NewApiError, match="invalid JSON"):
        client.pricing()

    transport_client = NewApiAdminClient(
        "http://newapi.test", "admin", "1",
        transport=httpx.MockTransport(lambda _request: (_ for _ in ()).throw(httpx.ConnectError("down"))),
    )
    with pytest.raises(NewApiError, match="outcome is unknown"):
        transport_client.pricing()
    transport_client.close()
    client.close()


def test_newapi_user_bootstrap_quota_and_management_token_paths(monkeypatch):
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    calls = []

    def request(_method, path, **kwargs):
        calls.append((path, kwargs))
        if path == "/api/user/":
            return {"success": True, "data": {}}
        if path.startswith("/api/user/search"):
            return {"success": True, "data": {"items": [{"id": 11, "username": "tenant"}], "total": 1}}
        if path == "/api/user/self":
            return {"success": True, "data": {"quota": "42"}}
        if path == "/api/user/token":
            return {"success": True, "data": "management-key"}
        if path == "/api/user/manage":
            return {"success": True, "data": {}}
        raise AssertionError(path)

    monkeypatch.setattr(client, "_request", request)
    assert client.create_user(username="tenant", password="pw", display_name="Tenant") == 11
    client.add_user_quota(11, 100)
    assert client.get_user_quota(dashboard_token="dashboard", user_id=11) == 42
    assert client.generate_management_token("dashboard", 11) == "management-key"
    assert calls[0][1]["json"]["role"] == 1

    monkeypatch.setattr(
        client,
        "_request",
        lambda *_args, **_kwargs: {"success": True, "data": {"items": [], "total": None}},
    )
    assert client.find_user("missing") is None
    monkeypatch.setattr(
        client,
        "_request",
        lambda *_args, **_kwargs: {"success": True, "data": {"items": [], "total": 0}},
    )
    with pytest.raises(NewApiError, match="not observable"):
        client.create_user(username="missing", password="pw", display_name="Missing")
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {"quota": "bad"}})
    with pytest.raises(NewApiError, match="invalid tenant quota"):
        client.get_user_quota(dashboard_token="dashboard", user_id=11)
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {}})
    with pytest.raises(NewApiError, match="invalid management token"):
        client.generate_management_token("dashboard", 11)


def test_newapi_bounded_pagination_and_missing_token_paths(monkeypatch):
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    monkeypatch.setattr(
        client,
        "_request",
        lambda *_args, **_kwargs: {
            "success": True,
            "data": {"items": [{"id": 1, "username": "other"}] * 20, "total": None},
        },
    )
    with pytest.raises(NewApiError, match="pagination exceeded"):
        client.find_user("missing")

    monkeypatch.setattr(
        client,
        "_request",
        lambda *_args, **_kwargs: {
            "success": True,
            "data": {"items": [{"id": 1, "name": "other"}] * 100, "total": None},
        },
    )
    with pytest.raises(NewApiError, match="pagination exceeded"):
        client.list_relay_tokens(dashboard_token="dashboard", user_id=11)
    monkeypatch.setattr(
        client,
        "_request",
        lambda *_args, **_kwargs: {"success": True, "data": {"items": []}},
    )
    assert client.get_relay_token(dashboard_token="dashboard", user_id=11, token_id=7) is None
    assert client.find_relay_token_by_name(dashboard_token="dashboard", user_id=11, name="missing") is None
    assert client.reconcile_relay_token(
        dashboard_token="dashboard", user_id=11, name="missing", model_ids=["m1"], expired_time=-1,
    ) is None


def test_newapi_reconcile_and_create_error_boundaries(monkeypatch):
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    monkeypatch.setattr(
        client,
        "find_relay_token_by_name",
        lambda **_kwargs: {"id": "bad", "name": "relay"},
    )
    with pytest.raises(NewApiError, match="invalid relay token id"):
        client.reconcile_relay_token(
            dashboard_token="dashboard", user_id=11, name="relay", model_ids=["m1"], expired_time=-1,
        )
    monkeypatch.setattr(
        client,
        "find_relay_token_by_name",
        lambda **_kwargs: {"id": 7, "name": "relay"},
    )
    monkeypatch.setattr(
        client,
        "get_relay_token_detail",
        lambda **_kwargs: (_ for _ in ()).throw(NewApiError("detail unavailable")),
    )
    with pytest.raises(NewApiError, match="detail unavailable") as detail_error:
        client.reconcile_relay_token(
            dashboard_token="dashboard", user_id=11, name="relay", model_ids=["m1"], expired_time=-1,
        )
    assert detail_error.value.token_id == 7

    monkeypatch.setattr(client, "get_relay_token", lambda **_kwargs: None)
    with pytest.raises(NewApiError, match="not found"):
        client.update_relay_token(dashboard_token="dashboard", user_id=11, token_id=7)
    monkeypatch.setattr(client, "get_relay_token", lambda **_kwargs: {"id": 7, "status": "unknown"})
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {}})
    assert client.revoke_relay_token(dashboard_token="dashboard", user_id=11, token_id=7) is True

    monkeypatch.setattr(client, "get_relay_token", lambda **_kwargs: {"id": 7, "name": "relay"})
    monkeypatch.setattr(
        client,
        "get_relay_token_detail",
        lambda **_kwargs: {"id": 7, "status": 1, "expired_time": -1, "model_limits_enabled": True, "model_limits": "m1", "key": "full"},
    )
    monkeypatch.setattr(client, "_request", lambda *_args, **_kwargs: {"success": True, "data": {}})
    assert client.update_relay_token(dashboard_token="dashboard", user_id=11, token_id=7)["success"] is True


def test_newapi_create_resolution_handles_invalid_detail_and_timeout(monkeypatch):
    client = NewApiAdminClient("http://newapi.test", "admin", "1")
    monkeypatch.setattr(client, "_list_user_tokens", lambda **_kwargs: [{"id": "bad", "name": "relay"}])
    with pytest.raises(NewApiError, match="invalid relay token id"):
        client.create_relay_token(
            dashboard_token="dashboard", user_id=11, name="relay", model_ids=["m1"], remain_quota=1,
        )

    calls = 0

    def no_match(**_kwargs):
        nonlocal calls
        calls += 1
        return []

    monkeypatch.setattr(client, "_list_user_tokens", no_match)
    monkeypatch.setattr("operation_service.newapi_client.time.sleep", lambda _seconds: None)
    with pytest.raises(NewApiError, match="not observable"):
        client._resolve_created_token(
            dashboard_token="dashboard", user_id=11, name="relay", model_ids=["m1"], expired_time=-1,
        )
    assert calls == 5

    monkeypatch.setattr(
        client,
        "_list_user_tokens",
        lambda **_kwargs: [{"id": 7, "name": "relay", "status": 1, "expired_time": -1, "model_limits_enabled": True, "model_limits": "m1"}],
    )
    monkeypatch.setattr(client, "get_relay_token_key", lambda **_kwargs: (_ for _ in ()).throw(NewApiError("key read failed")))
    with pytest.raises(NewApiError, match="key read failed") as key_error:
        client.create_relay_token(
            dashboard_token="dashboard", user_id=11, name="relay", model_ids=["m1"], remain_quota=1,
        )
    assert key_error.value.token_id == 7


# Repository tests use a scripted connection only to verify the repository's
# bounded row mapping, CAS guards, and owner/lease SQL call boundaries.  The
# prepared PostgreSQL tests remain the source of truth for actual SQL behavior.
def test_repository_row_mapping_and_advisory_lock():
    repository, connection = _repo(_Result())
    with repository.relay_access_lock("tenant", "provider"):
        pass
    assert "pg_advisory_xact_lock" in connection.calls[0][0]

    operation_data = dict(_OPERATION)
    for name in (
        "expected_access_version", "expected_access_token_id", "bootstrap_state",
        "quota_before", "quota_delta", "claim_owner", "create_attempt_state", "user_create_state",
    ):
        operation_data.pop(name)
    operation = repository._relay_operation(operation_data)
    assert operation.operation == "revoke"
    assert operation.expected_access_version is None
    assert operation.bootstrap_state == "planned"

    access_data = dict(_ACCESS, encrypted_bootstrap_password=None, policy_revision=None)
    access = repository._access_data(access_data)
    assert access["encrypted_token"] == b"relay"
    assert access["encrypted_bootstrap_password"] is None
    assert access["policy_revision"] is None
    assert repository._empty_encrypted_token() == b""
    assert isinstance(repository._rate(_RATE), RateRow)
    assert isinstance(repository._relay_token(_LIFECYCLE), RelayTokenLifecycleRow)
    assert repository._operation_returning("operation").startswith("operation.operation_id")


def test_repository_provider_model_and_rate_operations():
    provider = ProviderRow(**_PROVIDER)
    model = ModelRow(**_MODEL)
    rate = RateRow(**_RATE)
    responses = [
        _Result(one=_PROVIDER),
        _Result(many=[_PROVIDER]),
        _Result(one=_PROVIDER),
        _Result(one=_PROVIDER),
        _Result(), _Result(), _Result(many=[_MODEL]),
        _Result(one=_MODEL),
        _Result(one=_MODEL),
        _Result(many=[_MODEL]),
        _Result(one=_MODEL),
        _Result(one=_MODEL),
        _Result(many=[_MODEL]),
        _Result(), _Result(one={"coalesce": 0}), _Result(), _Result(one=_RATE),
        _Result(one=_RATE),
    ]
    repository, connection = _repo(*responses)
    assert repository.ensure_internal_provider(
        provider_code="newapi", display_name="LLM 网关", relay_base_url="http://relay/v1",
        api_protocol="openai-completions", newapi_channel_id=1,
    ) == provider
    assert repository.list_providers(published_only=True) == [provider]
    assert repository.get_provider("p1") == provider
    assert repository.set_provider_status("p1", "published") == provider
    assert repository.upsert_discovered_models("p1", ["m1"]) == [model]
    assert repository.update_model_metadata("p1", "m1", display_name="Model 1", capabilities={"reasoning": True}) == model
    assert repository.update_model_metadata("p1", "m1", display_name=None, capabilities={}) == model
    assert repository.list_models("p1") == [model]
    assert repository.get_model("p1", "m1") == model
    assert repository.set_model_status("p1", "m1", "published") == model
    assert repository.publish_priced_models("p1") == [model]
    assert repository.create_rate(
        "p1", "m1", pricing_status="known", billing_mode="token", source="manual",
        effective_from=NOW, manually_overridden=True,
    ) == rate
    assert repository.current_rate("p1", "m1") == rate
    assert len(connection.calls) == 18


def test_repository_access_and_bootstrap_boundaries():
    access = AccessRow(**_ACCESS)
    operation = RelayTokenOperationRow(**_OPERATION)
    repository, _connection = _repo(
        _Result(one=_ACCESS),
        _Result(one={"version": 2, "newapi_token_id": 7, "policy_revision": "policy-1"}),
        _Result(one=_ACCESS),
        _Result(one=_ACCESS),
        _Result(one=_ACCESS),
        _Result(one=_ACCESS), _Result(one=_OPERATION),
        _Result(one=_ACCESS),
        _Result(one=_ACCESS),
    )
    assert repository.upsert_access(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_token=b"relay",
        encrypted_management_token=b"management", allowed_model_ids=["m1"], newapi_username="attenant",
        newapi_user_id=11, newapi_token_id=7, expires_at=NOW, policy_revision="policy-1",
    ) == access
    assert repository.upsert_access(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_token=b"relay",
        encrypted_management_token=b"management", allowed_model_ids=["m1"], newapi_username="attenant",
        newapi_user_id=11, newapi_token_id=7, expires_at=NOW, policy_revision="policy-1",
        expected_version=2, expected_token_id=7, expected_policy_revision="policy-1",
    ) == access
    with pytest.raises(RuntimeError, match="no row"):
        repository.upsert_access(
            tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_token=b"relay",
            encrypted_management_token=b"management", allowed_model_ids=["m1"], newapi_username="attenant",
            newapi_user_id=11, newapi_token_id=7, expires_at=NOW, expected_version=0,
        )
    assert repository.stage_relay_access(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_management_token=b"management",
        encrypted_bootstrap_password=b"bootstrap", allowed_model_ids=["m1"], newapi_username="attenant",
        newapi_user_id=None, policy_revision="policy-1",
    ) == access
    assert repository.stage_relay_access_with_operation(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_management_token=b"management",
        encrypted_bootstrap_password=b"bootstrap", allowed_model_ids=["m1"], newapi_username="attenant",
        policy_revision="policy-1", operation_key="bootstrap", expires_at=NOW,
    ) == (access, operation)
    assert repository.set_relay_bootstrap_identity(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], newapi_user_id=11,
    ) == access
    assert repository.complete_relay_bootstrap(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], newapi_user_id=11,
        encrypted_management_token=b"management",
    ) == access


def test_repository_access_cas_and_lifecycle_operations():
    access = AccessRow(**_ACCESS)
    lifecycle = RelayTokenLifecycleRow(**_LIFECYCLE)
    operation = RelayTokenOperationRow(**_OPERATION)
    repository, _connection = _repo(
        _Result(many=[]), _Result(many=[]), _Result(one=_ACCESS), _Result(one=_LIFECYCLE),
        _Result(one=_ACCESS), _Result(one=_ACCESS), _Result(one=_ACCESS),
        _Result(one=_LIFECYCLE), _Result(one=_LIFECYCLE), _Result(many=[_LIFECYCLE]),
        _Result(one=_LIFECYCLE), _Result(one=_OPERATION), _Result(many=[_OPERATION]),
        _Result(many=[_OPERATION]),
    )
    assert repository.upsert_access_with_relay_token(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_token=b"relay",
        encrypted_management_token=b"management", allowed_model_ids=["m1"], newapi_username="attenant",
        newapi_user_id=11, newapi_token_id=7, expires_at=NOW, policy_revision="policy-1", token_name="relay-v1",
    ) == access
    assert repository.get_access(_ACCESS["tenant_id"], _ACCESS["provider_id"]) == access
    assert repository.mark_access_revoked(_ACCESS["tenant_id"], _ACCESS["provider_id"], expected_token_id=7) == access
    assert repository.bump_relay_access_generation(_ACCESS["tenant_id"], _ACCESS["provider_id"], expected_token_id=8) == access
    assert repository.record_relay_token(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], newapi_user_id=11,
        newapi_token_id=7, token_name="relay-v1", allowed_model_ids=["m1"], expires_at=NOW,
        policy_revision="policy-1",
    ) == lifecycle
    assert repository.get_relay_token(_ACCESS["tenant_id"], _ACCESS["provider_id"], 7) == lifecycle
    assert repository.list_relay_tokens(_ACCESS["tenant_id"], _ACCESS["provider_id"]) == [lifecycle]
    assert repository.mark_relay_token_revoked(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], newapi_token_id=7,
    ) == lifecycle
    assert repository.get_relay_token_operation("relay:revoke:key") == operation
    assert repository.list_relay_token_operations(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"],
    ) == [operation]
    assert repository.claim_relay_token_operations(limit=1) == [operation]


def test_repository_owner_lease_mutations_fail_closed_without_owner():
    repository, _connection = _repo()
    assert repository.mark_relay_token_operation_succeeded("op") is None
    assert repository.mark_relay_token_operation_failed(
        "op", error="error", next_attempt_at=NOW,
    ) is None
    assert repository.bind_relay_token_operation("op", 7) is None
    assert repository.update_relay_token_create_state("op", create_attempt_state="in_flight") is None
    assert repository.update_relay_user_create_state("op", user_create_state="observed") is None
    assert repository.update_relay_bootstrap_progress("op", bootstrap_state="user_created") is None


def test_repository_owner_lease_mutations_and_claim_variants():
    operation = RelayTokenOperationRow(**_OPERATION)
    results = [_Result(one=_OPERATION)] * 7
    repository, _connection = _repo(*results)
    assert repository.claim_relay_token_operation("op", force=True, claim_owner="owner") == operation
    assert repository.mark_relay_token_operation_succeeded("op", claim_owner="owner") == operation
    assert repository.mark_relay_token_operation_failed(
        "op", error="line\n" * 600, next_attempt_at=NOW, claim_owner="owner",
    ) == operation
    assert repository.bind_relay_token_operation("op", 7, claim_owner="owner") == operation
    assert repository.update_relay_token_create_state(
        "op", create_attempt_state="observed", claim_owner="owner",
    ) == operation
    assert repository.update_relay_user_create_state(
        "op", user_create_state="observed", newapi_user_id=11, claim_owner="owner",
    ) == operation
    assert repository.update_relay_bootstrap_progress(
        "op", bootstrap_state="quota_applied", quota_before=0, quota_delta=10, claim_owner="owner",
    ) == operation
    repository, _connection = _repo(_Result(one=_OPERATION))
    assert repository.heartbeat_relay_token_operation("op", claim_owner="owner") == operation


def test_repository_revocation_preparation_and_adoption_safety():
    access = AccessRow(**_ACCESS)
    operation = RelayTokenOperationRow(**_OPERATION)
    repository, _connection = _repo(
        _Result(one=_ACCESS), _Result(one=_OPERATION),
        _Result(one=None), _Result(one=_OPERATION),
        _Result(many=[{"lease_live": False}]), _Result(many=[{"operation_id": "op"}]),
    )
    assert repository.prepare_relay_token_revocation(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], expected_token_id=7,
        newapi_user_id=11, token_name="relay-v1", operation_key="revoke", desired_model_ids=["m1"],
        desired_expires_at=NOW, policy_revision="policy-1",
    ) == (access, operation)
    assert repository.prepare_unidentified_relay_token_revocation(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], newapi_user_id=11,
        token_name="relay-v1", operation_key="reconcile", desired_model_ids=[], desired_expires_at=NOW,
        policy_revision="policy-1",
    ) == (None, operation)
    assert repository.cancel_relay_token_revoke_on_adoption(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], newapi_token_id=7,
    ) == 1

    repository, _connection = _repo(_Result(many=[{"lease_live": True}]))
    with pytest.raises(RuntimeError, match="live safety revoke"):
        repository.cancel_relay_token_revoke_on_adoption(
            tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], newapi_token_id=7,
        )


def test_repository_access_commit_owner_fence_and_old_token_receipt():
    access = AccessRow(**_ACCESS)
    lifecycle = RelayTokenLifecycleRow(**_LIFECYCLE)
    operation = RelayTokenOperationRow(**_OPERATION)
    repository, _connection = _repo(_Result(one=None))
    with pytest.raises(RuntimeError, match="owner is unavailable"):
        repository.upsert_access_with_relay_token(
            tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_token=b"relay",
            encrypted_management_token=b"management", allowed_model_ids=["m1"], newapi_username="attenant",
            newapi_user_id=11, newapi_token_id=7, expires_at=NOW, policy_revision="policy-1", token_name="relay-v1",
            operation_id="op", claim_owner=None,
        )
    repository, _connection = _repo(_Result(one=None))
    with pytest.raises(RuntimeError, match="claim is stale"):
        repository.upsert_access_with_relay_token(
            tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_token=b"relay",
            encrypted_management_token=b"management", allowed_model_ids=["m1"], newapi_username="attenant",
            newapi_user_id=11, newapi_token_id=7, expires_at=NOW, policy_revision="policy-1", token_name="relay-v1",
            operation_id="op", claim_owner="owner",
        )
    repository, _connection = _repo(
        _Result(one={"operation_id": "op"}),
        _Result(many=[]), _Result(many=[]), _Result(one=_ACCESS), _Result(one=_LIFECYCLE),
        _Result(one=_OPERATION),
    )
    assert repository.upsert_access_with_relay_token(
        tenant_id=_ACCESS["tenant_id"], provider_id=_ACCESS["provider_id"], encrypted_token=b"relay",
        encrypted_management_token=b"management", allowed_model_ids=["m1"], newapi_username="attenant",
        newapi_user_id=11, newapi_token_id=7, expires_at=NOW, policy_revision="policy-1", token_name="relay-v1",
        old_token_id=6, old_token_user_id=11, old_operation_key="old-revoke", old_token_name="old",
        old_desired_model_ids=["m1"], old_desired_expires_at=NOW, old_policy_revision="policy-0",
        operation_id="op", claim_owner="owner",
    ) == access
