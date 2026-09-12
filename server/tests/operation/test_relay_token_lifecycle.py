from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from operation_service.newapi_client import NewApiError
from operation_service.platform_provider_repository import AccessRow, ModelRow, ProviderRow, RateRow
from operation_service.public_pricing_client import PublicModelPrice
from operation_service.platform_provider_service import (
    PlatformProviderService,
    _relay_token_name,
    install_relay_token_lifecycle_lifespan,
)
from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import Conflict, NotFound


NOW = datetime(2030, 1, 1, tzinfo=UTC)
PROVIDER = ProviderRow(
    "p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1,
    "published", 1, NOW,
)
MODELS = [
    ModelRow("p1", "m1", "", {}, "published", "discovery", 1, NOW),
    ModelRow("p1", "m2", "", {}, "published", "discovery", 1, NOW),
    ModelRow("p1", "m3", "", {}, "published", "discovery", 1, NOW),
]


def _access(*, models=("m1", "m2"), expires_at=NOW + timedelta(days=30), status="active", token_id=7, version=1):
    return AccessRow(
        "a1", "tenant-1", "p1", b"relay-key", b"management-key", list(models),
        "attenant", 11, token_id, status, version, expires_at,
    )


class FakeCrypto:
    def encrypt(self, value: str) -> bytes:
        return value.encode()

    def decrypt(self, value: bytes) -> str:
        return value.decode()


class FakeEnterprise:
    def __init__(self, refs):
        self.refs = refs

    def get_by_tenant_id(self, _tenant_id):
        return type("Account", (), {"allowed_model_refs": self.refs})()


class LifecycleRepo:
    def __init__(self, access):
        self.access = access
        self.provider = PROVIDER
        self.operations = {}
        self.tokens = {}
        self.events = []

    def get_provider(self, _provider_id):
        return self.provider

    def list_models(self, _provider_id, **_kwargs):
        return MODELS

    def get_access(self, _tenant_id, _provider_id):
        return self.access

    def mark_access_revoked(self, tenant_id, provider_id, *, expected_token_id=None):
        assert (tenant_id, provider_id) == ("tenant-1", "p1")
        if self.access and (expected_token_id is None or self.access.newapi_token_id == expected_token_id):
            self.access = replace(self.access, status="revoked", version=self.access.version + 1)
        return self.access

    def bump_relay_access_generation(self, tenant_id, provider_id, *, expected_token_id):
        if self.access and self.access.newapi_token_id != expected_token_id:
            self.access = replace(self.access, version=self.access.version + 1)
        return self.access

    def stage_relay_access(self, **kwargs):
        self.access = AccessRow(
            "a1", kwargs["tenant_id"], kwargs["provider_id"], b"", kwargs["encrypted_management_token"],
            kwargs["allowed_model_ids"], kwargs["newapi_username"], kwargs.get("newapi_user_id"), None,
            "revoked", 1, None, kwargs.get("policy_revision", ""),
            kwargs.get("encrypted_bootstrap_password"),
        )
        return self.access

    def stage_relay_access_with_operation(self, **kwargs):
        access = self.stage_relay_access(**kwargs)
        operation = self.ensure_relay_token_operation(
            tenant_id=kwargs["tenant_id"], provider_id=kwargs["provider_id"],
            newapi_user_id=None, newapi_token_id=None, token_name=kwargs["newapi_username"],
            operation_type="bootstrap", operation_key=kwargs["operation_key"],
            desired_model_ids=kwargs["allowed_model_ids"], desired_expires_at=kwargs["expires_at"],
            policy_revision=kwargs["policy_revision"],
        )
        return access, operation

    def set_relay_bootstrap_identity(self, *, tenant_id, provider_id, newapi_user_id):
        if self.access is None:
            return None
        self.access = replace(self.access, newapi_user_id=newapi_user_id)
        return self.access

    def complete_relay_bootstrap(self, *, tenant_id, provider_id, newapi_user_id, encrypted_management_token):
        if self.access is None:
            return None
        self.access = replace(
            self.access,
            newapi_user_id=newapi_user_id,
            encrypted_management_token=encrypted_management_token,
            encrypted_bootstrap_password=None,
        )
        return self.access

    def upsert_access(self, **kwargs):
        if self.access is not None and kwargs.get("expected_version") is not None:
            if self.access.version != kwargs["expected_version"] or self.access.newapi_token_id != kwargs.get("expected_token_id"):
                raise RuntimeError("stale access")
            if kwargs.get("expected_policy_revision") is not None and self.access.policy_revision != kwargs["expected_policy_revision"]:
                raise RuntimeError("stale policy")
        self.access = AccessRow(
            "a1", kwargs["tenant_id"], kwargs["provider_id"], kwargs["encrypted_token"],
            kwargs["encrypted_management_token"], kwargs["allowed_model_ids"],
            kwargs["newapi_username"], kwargs["newapi_user_id"], kwargs["newapi_token_id"],
            "active", self.access.version + 1 if self.access else 1, kwargs["expires_at"],
            kwargs.get("policy_revision", ""),
        )
        return self.access

    def upsert_access_with_relay_token(self, **kwargs):
        access = self.upsert_access(**kwargs)
        self.record_relay_token(
            tenant_id=kwargs["tenant_id"], provider_id=kwargs["provider_id"],
            newapi_user_id=kwargs["newapi_user_id"], newapi_token_id=kwargs["newapi_token_id"],
            token_name=kwargs["token_name"], allowed_model_ids=kwargs["allowed_model_ids"],
            expires_at=kwargs["expires_at"], policy_revision=kwargs["policy_revision"],
        )
        if kwargs.get("old_token_id") is not None and kwargs.get("old_operation_key"):
            self.ensure_relay_token_operation(
                tenant_id=kwargs["tenant_id"], provider_id=kwargs["provider_id"],
                newapi_user_id=kwargs.get("old_token_user_id"), newapi_token_id=kwargs["old_token_id"],
                token_name=kwargs.get("old_token_name", ""), operation_type="revoke",
                operation_key=kwargs["old_operation_key"],
                desired_model_ids=kwargs.get("old_desired_model_ids", []),
                desired_expires_at=kwargs.get("old_desired_expires_at"),
                policy_revision=kwargs.get("old_policy_revision", ""),
            )
        return access

    def get_relay_token_operation(self, operation_key):
        return self.operations.get(operation_key)

    def list_relay_token_operations(self, *, tenant_id=None, provider_id=None):
        return [
            operation for operation in self.operations.values()
            if (tenant_id is None or operation.get("tenant_id") == tenant_id)
            and (provider_id is None or operation.get("provider_id") == provider_id)
        ]

    def cancel_relay_token_revoke_on_adoption(self, *, tenant_id, provider_id, newapi_token_id):
        cancelled = 0
        for operation in self.operations.values():
            if (
                operation.get("tenant_id") == tenant_id
                and operation.get("provider_id") == provider_id
                and operation.get("newapi_token_id") == newapi_token_id
                and operation.get("operation_type") in {"revoke", "delete"}
                and operation.get("status") != "succeeded"
            ):
                operation["status"] = "succeeded"
                cancelled += 1
        return cancelled

    def record_relay_token(self, **kwargs):
        token = dict(kwargs, status="active", revoked=False)
        self.tokens[kwargs["newapi_token_id"]] = token
        self.events.append(("record", kwargs["newapi_token_id"]))
        return token

    def ensure_relay_token_operation(self, **kwargs):
        key = kwargs["operation_key"]
        if key in self.operations:
            operation = self.operations[key]
            operation.update({k: v for k, v in kwargs.items() if k not in {"operation_key"}})
            if operation["status"] != "succeeded":
                operation["status"] = "pending"
            return operation
        operation = dict(kwargs, operation_id=key, status="pending", attempt_count=0)
        self.operations[key] = operation
        self.events.append(("operation", kwargs["operation_type"], key))
        return operation

    def mark_relay_token_operation_succeeded(self, operation_id):
        for operation in self.operations.values():
            if operation["operation_id"] == operation_id:
                operation["status"] = "succeeded"

    def mark_relay_token_operation_failed(self, operation_id, *, error, next_attempt_at, increment_attempt=True):
        for operation in self.operations.values():
            if operation["operation_id"] == operation_id:
                operation["status"] = "failed"
                operation["last_error"] = error
                operation["next_attempt_at"] = next_attempt_at
                if increment_attempt:
                    operation["attempt_count"] += 1

    def bind_relay_token_operation(self, operation_id, token_id):
        for operation in self.operations.values():
            if operation["operation_id"] == operation_id:
                operation["newapi_token_id"] = token_id

    def mark_relay_token_revoked(self, *, tenant_id, provider_id, newapi_token_id):
        if newapi_token_id in self.tokens:
            self.tokens[newapi_token_id]["status"] = "revoked"
            self.tokens[newapi_token_id]["revoked"] = True

    def claim_relay_token_operation(self, operation_id, *, force=False, claim_owner=None):
        operation = next((item for item in self.operations.values() if item["operation_id"] == operation_id), None)
        if operation is None or operation["status"] in {"running", "succeeded"}:
            return None
        operation["status"] = "running"
        operation["attempt_count"] += 1
        operation["claim_owner"] = claim_owner
        return operation

    def claim_relay_token_operations(self, *, limit=100, force=False, tenant_id=None, provider_id=None, claim_owner=None):
        result = []
        for operation in self.operations.values():
            if operation["status"] == "succeeded":
                continue
            if not force and operation.get("next_attempt_at") is not None and operation["next_attempt_at"] > NOW:
                continue
            if tenant_id is not None and operation["tenant_id"] != tenant_id:
                continue
            if provider_id is not None and operation["provider_id"] != provider_id:
                continue
            operation["status"] = "running"
            operation["attempt_count"] += 1
            result.append(operation)
            if len(result) >= limit:
                break
        return result


class FakeNewAPI:
    def __init__(self, *, revoke_errors=0):
        self.calls = []
        self.next_token_id = 20
        self.revoke_errors = revoke_errors

    def create_relay_token(self, **kwargs):
        self.calls.append(("create", kwargs["name"], list(kwargs["model_ids"])))
        self.next_token_id += 1
        return self.next_token_id, f"new-{self.next_token_id}"

    def revoke_relay_token(self, **kwargs):
        self.calls.append(("revoke", kwargs["token_id"]))
        if self.revoke_errors:
            self.revoke_errors -= 1
            raise NewApiError("upstream temporarily unavailable")
        return True


class UnknownCreateNewAPI(FakeNewAPI):
    def __init__(self):
        super().__init__()
        self.reconcile_calls = 0

    def create_relay_token(self, **kwargs):
        self.calls.append(("create", kwargs["name"], list(kwargs["model_ids"])))
        raise NewApiError("NewAPI request outcome is unknown")

    def reconcile_relay_token(self, **_kwargs):
        self.reconcile_calls += 1
        return None


class ExistingUserNewAPI(FakeNewAPI):
    def find_user(self, _username):
        return {"id": 11}


class FreshNewAPI(FakeNewAPI):
    def find_user(self, _username):
        return None

    def create_user(self, **_kwargs):
        return 11

    def add_user_quota(self, _user_id, _quota):
        return None

    def get_user_quota(self, *, dashboard_token, user_id):
        return 0

    def login(self, _username, _password):
        return "dashboard", 11

    def generate_management_token(self, _dashboard_token, _user_id):
        return "management-key"


class BootstrapRecoveryNewAPI(ExistingUserNewAPI):
    def get_user_quota(self, *, dashboard_token, user_id):
        return 0

    def add_user_quota(self, _user_id, _quota):
        return None

    def login(self, _username, _password):
        return "dashboard", 11

    def generate_management_token(self, _dashboard_token, _user_id):
        return "management-key"


class QuotaCrashNewAPI(FreshNewAPI):
    def __init__(self):
        super().__init__()
        self.quota = 0
        self.add_calls = 0
        self.created = False

    def find_user(self, _username):
        return {"id": 11} if self.created else None

    def create_user(self, **_kwargs):
        self.created = True
        return 11

    def get_user_quota(self, *, dashboard_token, user_id):
        return self.quota

    def add_user_quota(self, _user_id, quota):
        self.add_calls += 1
        self.quota += quota
        if self.add_calls == 1:
            raise NewApiError("quota response lost after upstream mutation")


class QuotaAlreadyAppliedNewAPI(BootstrapRecoveryNewAPI):
    def get_user_quota(self, *, dashboard_token, user_id):
        return 1_000_000_000

    def add_user_quota(self, _user_id, _quota):
        raise AssertionError("quota must be reconciled, not added twice")


def _service(repo, newapi, *, refs, now=NOW, heartbeat_interval=60):
    return PlatformProviderService(
        repo, newapi, FakeCrypto(), "http://relay/v1",
        enterprise_repository=FakeEnterprise(refs), clock=lambda: now,
        renewal_window=timedelta(hours=24),
        heartbeat_interval=heartbeat_interval,
    )


def test_relay_token_name_preserves_monotonic_generation_suffix_when_bounded():
    first = _relay_token_name("tenant-1", "provider-code-that-is-long", 7)
    second = _relay_token_name("tenant-1", "provider-code-that-is-long", 8)

    assert len(first) <= 30 and len(second) <= 30
    assert first.endswith("-v7")
    assert second.endswith("-v8")
    assert first != second


def test_adopting_token_completes_matching_safety_revoke_receipt():
    class FallbackAdoptionRepo(LifecycleRepo):
        upsert_access_with_relay_token = None

        def cancel_relay_token_revoke_on_adoption(self, *, tenant_id, provider_id, newapi_token_id):
            assert (tenant_id, provider_id) == ("tenant-1", "p1")
            cancelled = 0
            for operation in self.operations.values():
                if (
                    operation.get("tenant_id") == tenant_id
                    and operation.get("provider_id") == provider_id
                    and operation.get("newapi_token_id") == newapi_token_id
                    and operation.get("operation_type") in {"revoke", "delete"}
                    and operation.get("status") != "succeeded"
                ):
                    operation["status"] = "succeeded"
                    cancelled += 1
            return cancelled

    repo = FallbackAdoptionRepo(_access(models=("m1",), token_id=7))
    pending = repo.ensure_relay_token_operation(
        tenant_id="tenant-1", provider_id="p1", newapi_user_id=11, newapi_token_id=99,
        token_name="replacement", operation_type="revoke", operation_key="revoke:99",
        desired_model_ids=["m1"], desired_expires_at=NOW + timedelta(days=1),
        policy_revision="policy",
    )
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)

    service._persist_access(
        tenant_id="tenant-1", provider_id="p1", relay_token="replacement-key",
        management_token="management-key", allowed_model_ids=["m1"], username="attenant",
        user_id=11, token_id=99, expires_at=NOW + timedelta(days=1), policy_revision="policy",
        token_name="replacement", old_access=repo.access,
    )

    assert pending["status"] == "succeeded"


def test_unknown_token_create_is_reconciled_without_a_second_post():
    newapi = UnknownCreateNewAPI()
    service = _service(LifecycleRepo(_access()), newapi, refs=[{"provider_id": "p1", "model_id": "m1"}])
    operation = {
        "operation_id": "relay:issue:unknown",
        "status": "running",
        "create_attempt_state": "not_started",
    }

    with pytest.raises(NewApiError, match="outcome is unknown"):
        service._issue_relay_token(
            operation,
            dashboard_token="management",
            user_id=11,
            name="aiteam-tenant-v2",
            model_ids=["m1"],
            expired_time=int((NOW + timedelta(days=1)).timestamp()),
        )
    assert operation["create_attempt_state"] == "unknown"

    with pytest.raises(NewApiError, match="refusing another POST"):
        service._issue_relay_token(
            operation,
            dashboard_token="management",
            user_id=11,
            name="aiteam-tenant-v2",
            model_ids=["m1"],
            expired_time=int((NOW + timedelta(days=1)).timestamp()),
        )
    assert len(newapi.calls) == 1
    assert newapi.reconcile_calls == 1


def test_unknown_user_create_is_reconciled_without_a_second_post():
    class UnknownUserNewAPI(FreshNewAPI):
        def __init__(self):
            super().__init__()
            self.user_create_calls = 0

        def create_user(self, **_kwargs):
            self.user_create_calls += 1
            raise NewApiError("NewAPI request outcome is unknown")

    newapi = UnknownUserNewAPI()
    service = _service(LifecycleRepo(None), newapi, refs=[{"provider_id": "p1", "model_id": "m1"}])
    operation = {
        "operation_id": "relay:bootstrap:unknown",
        "status": "running",
        "user_create_state": "not_started",
    }

    with pytest.raises(NewApiError, match="outcome is unknown"):
        service._ensure_bootstrap_user(
            operation,
            tenant_id="tenant-1",
            username="attenant",
            password="bootstrap-password",
        )
    assert operation["user_create_state"] == "unknown"

    with pytest.raises(NewApiError, match="refusing another POST"):
        service._ensure_bootstrap_user(
            operation,
            tenant_id="tenant-1",
            username="attenant",
            password="bootstrap-password",
        )
    assert newapi.user_create_calls == 1


def test_relay_lifecycle_lifespan_runs_bounded_recovery_and_stops_cleanly():
    from fastapi import FastAPI

    async def run():
        app = FastAPI()
        called = asyncio.Event()
        limits = []

        def recover(*, limit):
            limits.append(limit)
            called.set()

        from types import SimpleNamespace

        app.state._platform_provider_service = SimpleNamespace(
            recover_relay_token_operations=recover,
        )
        install_relay_token_lifecycle_lifespan(app, interval_seconds=5, batch_limit=20)
        async with app.router.lifespan_context(app):
            await asyncio.wait_for(called.wait(), timeout=1)
        assert limits == [20]

    asyncio.run(run())


def test_resolve_tenant_access_acquires_policy_lock_before_access_lock():
    events = []

    class OrderedRepo(LifecycleRepo):
        @contextmanager
        def relay_policy_lock(self, tenant_id):
            events.append(("policy", "enter", tenant_id))
            yield
            events.append(("policy", "exit", tenant_id))

        @contextmanager
        def relay_access_lock(self, tenant_id, provider_id):
            events.append(("access", "enter", tenant_id, provider_id))
            yield
            events.append(("access", "exit", tenant_id, provider_id))

    repo = OrderedRepo(_access(models=("m1",)))
    enterprise = FakeEnterprise([{"provider_id": "p1", "model_id": "m1"}])
    service = PlatformProviderService(
        repo, ExistingUserNewAPI(), FakeCrypto(), "http://relay/v1",
        enterprise_repository=enterprise, clock=lambda: NOW,
        renewal_window=timedelta(hours=24),
    )

    result = service.resolve_tenant_access(
        tenant_id="tenant-1", provider_id="p1", model_ids=["m1"],
    )

    assert result["relay_token"] == "relay-key"
    assert events == [
        ("policy", "enter", "tenant-1"),
        ("access", "enter", "tenant-1", "p1"),
        ("access", "exit", "tenant-1", "p1"),
        ("policy", "exit", "tenant-1"),
    ]


def test_initial_issue_stages_management_credential_for_restart_recovery():
    repo = LifecycleRepo(None)
    newapi = FreshNewAPI()
    service = _service(repo, newapi, refs=[{"provider_id": "p1", "model_id": "m1"}])

    result = service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert result["relay_token"].startswith("new-")
    assert repo.access.status == "active"
    assert repo.access.newapi_token_id is not None
    assert any(op["operation_type"] == "issue" for op in repo.operations.values())


def test_bootstrap_quota_crash_recovers_without_double_add_before_issue():
    repo = LifecycleRepo(None)
    newapi = QuotaCrashNewAPI()
    service = _service(repo, newapi, refs=[{"provider_id": "p1", "model_id": "m1"}])

    with pytest.raises(Conflict, match="provisioning failed"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    bootstrap = next(op for op in repo.operations.values() if op["operation_type"] == "bootstrap")
    assert bootstrap["bootstrap_state"] == "quota_pending"
    assert newapi.add_calls == 1
    recovered = service.recover_relay_token_operations(
        force=True, tenant_id="tenant-1", provider_id="p1",
    )
    assert recovered == {"processed": 1, "succeeded": 1, "failed": 0}
    assert newapi.add_calls == 1

    result = service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])
    assert result["relay_token"].startswith("new-")
    assert newapi.add_calls == 1


def test_bootstrap_receipt_recovers_user_management_credential_after_restart():
    repo = LifecycleRepo(None)
    access, operation = repo.stage_relay_access_with_operation(
        tenant_id="tenant-1", provider_id="p1", encrypted_management_token=b"",
        encrypted_bootstrap_password=b"bootstrap-password", encrypted_token=b"",
        allowed_model_ids=["m1"], newapi_username="attenant",
        policy_revision="policy", operation_key="relay:bootstrap:test",
        expires_at=NOW + timedelta(days=1),
    )
    service = _service(repo, BootstrapRecoveryNewAPI(), refs=[{"provider_id": "p1", "model_id": "m1"}])

    service._recover_operation(operation)

    assert repo.access.newapi_user_id == 11
    assert repo.access.encrypted_management_token == b"management-key"
    assert repo.access.encrypted_bootstrap_password is None


def test_bootstrap_quota_pending_recovery_accepts_observed_quota_without_double_add():
    repo = LifecycleRepo(None)
    access, operation = repo.stage_relay_access_with_operation(
        tenant_id="tenant-1", provider_id="p1", encrypted_management_token=b"",
        encrypted_bootstrap_password=b"bootstrap-password", encrypted_token=b"",
        allowed_model_ids=["m1"], newapi_username="attenant",
        policy_revision="policy", operation_key="relay:bootstrap:quota",
        expires_at=NOW + timedelta(days=1),
    )
    operation.update({"bootstrap_state": "quota_pending", "quota_before": 0, "quota_delta": 1_000_000_000})
    service = _service(repo, QuotaAlreadyAppliedNewAPI(), refs=[{"provider_id": "p1", "model_id": "m1"}])

    service._recover_operation(operation)

    assert repo.access.encrypted_management_token == b"management-key"
    assert operation["bootstrap_state"] == "management_ready"


def test_expired_access_is_not_reused_and_runtime_access_is_fail_closed():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW - timedelta(seconds=1)))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=[{"provider_id": "p1", "model_id": "m1"}])

    result = service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert result["relay_token"].startswith("new-")
    assert repo.access.newapi_token_id != 7
    assert [call[0] for call in newapi.calls] == ["create", "revoke"]
    with pytest.raises(Conflict, match="expired"):
        service._runtime_access(PROVIDER, replace(repo.access, expires_at=NOW - timedelta(seconds=1)))


def test_model_scope_shrink_revokes_before_issuing_narrow_replacement():
    repo = LifecycleRepo(_access())
    repo.tokens[7] = {"status": "active"}
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=[{"provider_id": "p1", "model_id": "m1"}])

    service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert newapi.calls[0] == ("revoke", 7)
    assert newapi.calls[1][0] == "create"
    assert repo.tokens[7]["status"] == "revoked"
    assert repo.access.allowed_model_ids == ["m1"]
    assert repo.access.status == "active"


def test_missing_local_token_id_is_fenced_with_reconciliation_receipt():
    repo = LifecycleRepo(_access(models=("m1",), token_id=None))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)

    with pytest.raises(Conflict, match="lifecycle identity"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert repo.access.status == "revoked"
    assert any(
        op["operation_type"] == "revoke" and op["newapi_token_id"] is None
        for op in repo.operations.values()
    )
    assert newapi.calls == []


def test_deny_all_revokes_existing_access_and_does_not_issue_a_token():
    repo = LifecycleRepo(_access(models=("m1",)))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=[])

    with pytest.raises(Conflict, match="no allowed models"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert newapi.calls == [("revoke", 7)]
    assert repo.access.status == "revoked"


def test_near_expiry_renews_then_retires_old_token():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)

    result = service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert result["relay_token"].startswith("new-")
    assert newapi.calls[0][0] == "create"
    assert newapi.calls[1] == ("revoke", 7)
    revoke_operations = [op for op in repo.operations.values() if op["operation_type"] == "revoke"]
    assert revoke_operations and revoke_operations[0]["newapi_token_id"] == 7
    assert repo.access.status == "active"


def test_removed_model_is_fenced_before_invalid_request_returns_even_when_policy_adds_another():
    repo = LifecycleRepo(_access(models=("m1", "m2")))
    repo.tokens[7] = {"status": "active"}
    newapi = ExistingUserNewAPI()
    service = _service(
        repo,
        newapi,
        refs=[{"provider_id": "p1", "model_id": "m2"}, {"provider_id": "p1", "model_id": "m3"}],
    )

    with pytest.raises(NotFound, match="platform model not found"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert newapi.calls == [("revoke", 7)]
    assert repo.access.status == "revoked"


def test_inline_lifecycle_receipt_has_unique_claim_owner_per_claim():
    repo = LifecycleRepo(None)
    service = _service(repo, FreshNewAPI(), refs=[{"provider_id": "p1", "model_id": "m1"}])
    operations = [
        service._ensure_operation(
            tenant_id="tenant-1", provider_id="p1", newapi_user_id=11, newapi_token_id=None,
            token_name=f"aiteam-tenant-newapi-v{index}", operation_type="issue",
            operation_key=f"relay:issue:claim-{index}", desired_model_ids=["m1"],
            desired_expires_at=NOW + timedelta(days=1), policy_revision="rev",
        )
        for index in (1, 2)
    ]

    assert service._claim_operation(operations[0]) is operations[0]
    assert service._claim_operation(operations[1]) is operations[1]
    assert service._claim_operation(operations[0]) is None
    assert operations[0]["claim_owner"].startswith("operation-")
    assert operations[0]["claim_owner"] != operations[1]["claim_owner"]
    assert service.heartbeat_relay_token_operation(operations[0]) is operations[0]


def test_recovery_issue_revalidates_provider_publication_before_upstream_create():
    repo = LifecycleRepo(_access(models=("m1",), status="revoked", token_id=None))
    repo.provider = replace(PROVIDER, status="disabled")
    newapi = FreshNewAPI()
    service = _service(repo, newapi, refs=None)
    operation = {
        "operation_id": "issue-disabled",
        "tenant_id": "tenant-1",
        "provider_id": "p1",
        "newapi_user_id": 11,
        "newapi_token_id": None,
        "token_name": "aiteam-tenant-newapi-v1",
        "operation_type": "issue",
        "desired_model_ids": ["m1"],
        "desired_expires_at": NOW + timedelta(days=1),
        "policy_revision": "rev",
        "expected_access_version": 1,
        "expected_access_token_id": None,
    }

    with pytest.raises(NewApiError, match="no longer published"):
        service._recover_operation(operation)
    assert newapi.calls == []


class CreateKeyFailureNewAPI(ExistingUserNewAPI):
    def create_relay_token(self, **kwargs):
        self.calls.append(("create", kwargs["name"], list(kwargs["model_ids"])))
        raise NewApiError("full key unavailable", token_id=99)


class PolicyFlipNewAPI(ExistingUserNewAPI):
    def __init__(self, flip):
        super().__init__()
        self.flip = flip

    def create_relay_token(self, **kwargs):
        self.calls.append(("create", kwargs["name"], list(kwargs["model_ids"])))
        self.flip()
        return 99, "replacement"


def test_successful_create_then_local_persist_failure_restarts_with_exact_revoke_receipt():
    class CreateTokenThenPersistenceFailure(FakeNewAPI):
        def create_relay_token(self, **kwargs):
            self.calls.append(("create", kwargs["name"], list(kwargs["model_ids"])))
            return 99, "replacement-key"

    class PersistFailureRepo(LifecycleRepo):
        def upsert_access_with_relay_token(self, **_kwargs):
            raise RuntimeError("simulated local access staging failure")

    repo = PersistFailureRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    newapi = CreateTokenThenPersistenceFailure(revoke_errors=1)
    service = _service(repo, newapi, refs=None)

    with pytest.raises(Conflict, match="provisioning failed"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    revoke = next(
        item for item in repo.operations.values()
        if item["operation_type"] == "revoke" and item["newapi_token_id"] == 99
    )
    assert revoke["status"] == "failed"
    assert newapi.calls == [("create", "aiteam-tenant-1-newapi-v2", ["m1"]), ("revoke", 99)]

    restarted = _service(repo, newapi, refs=None)
    recovery = restarted.recover_relay_token_operations(
        force=True, tenant_id="tenant-1", provider_id="p1",
    )
    assert recovery == {"processed": 2, "succeeded": 1, "failed": 1}
    assert revoke["status"] == "succeeded"
    assert newapi.calls[-1] == ("revoke", 99)
    assert sum(call[0] == "create" for call in newapi.calls) == 1


def test_binding_failure_leaves_restart_revoke_obligation_for_created_token():
    class CreateTokenNewAPI(FakeNewAPI):
        def create_relay_token(self, **kwargs):
            self.calls.append(("create", kwargs["name"], list(kwargs["model_ids"])))
            return 99, "replacement-key"

    class BindingFailureRepo(LifecycleRepo):
        def bind_relay_token_operation(self, _operation_id, _token_id):
            raise RuntimeError("simulated receipt binding failure")

    repo = BindingFailureRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    newapi = CreateTokenNewAPI()
    service = _service(repo, newapi, refs=None)

    with pytest.raises(Conflict, match="provisioning failed"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    revoke = next(
        item for item in repo.operations.values()
        if item["operation_type"] == "revoke" and item["newapi_token_id"] == 99
    )
    assert revoke["status"] == "pending"
    assert newapi.calls == [("create", "aiteam-tenant-1-newapi-v2", ["m1"])]

    restarted = _service(repo, newapi, refs=None)
    recovery = restarted.recover_relay_token_operations(
        force=True, tenant_id="tenant-1", provider_id="p1",
    )
    assert recovery["succeeded"] == 1
    assert revoke["status"] == "succeeded"
    assert newapi.calls[-1] == ("revoke", 99)
    assert sum(call[0] == "create" for call in newapi.calls) == 1


def test_fenced_inactive_token_advances_next_issue_generation():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    newapi = CreateKeyFailureNewAPI()
    service = _service(repo, newapi, refs=None)

    for _ in range(2):
        with pytest.raises(Conflict, match="provisioning failed"):
            service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    names = [call[1] for call in newapi.calls if call[0] == "create"]
    assert len(names) == 2 and names[0] != names[1]


def test_issue_recovery_without_access_cas_is_fail_closed():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(days=2), token_id=8, version=2))
    newapi = FreshNewAPI()
    service = _service(repo, newapi, refs=None)
    operation = {
        "operation_id": "legacy-issue", "tenant_id": "tenant-1", "provider_id": "p1",
        "newapi_user_id": 11, "newapi_token_id": None, "token_name": "relay-v1",
        "operation_type": "issue", "desired_model_ids": ["m1"],
        "desired_expires_at": NOW + timedelta(days=1), "policy_revision": "policy",
    }

    with pytest.raises(NewApiError, match="access CAS"):
        service._recover_operation(operation)
    assert newapi.calls == []


def test_adopted_current_token_cancels_matching_safety_revoke():
    repo = LifecycleRepo(_access(models=("m1",), token_id=99, version=2))
    pending = repo.ensure_relay_token_operation(
        tenant_id="tenant-1", provider_id="p1", newapi_user_id=11, newapi_token_id=99,
        token_name="relay-v2", operation_type="revoke", operation_key="revoke:current",
        desired_model_ids=["m1"], desired_expires_at=NOW + timedelta(days=1),
        policy_revision="policy",
    )
    service = _service(repo, ExistingUserNewAPI(), refs=None)
    operation = {
        "operation_id": "adopted-issue", "tenant_id": "tenant-1", "provider_id": "p1",
        "newapi_user_id": 11, "newapi_token_id": 99, "token_name": "relay-v2",
        "operation_type": "issue", "desired_model_ids": ["m1"],
        "desired_expires_at": NOW + timedelta(days=1), "policy_revision": "policy",
    }

    service._reconcile_superseded_issue_token(
        operation,
        repo.access,
        tenant_id="tenant-1",
        provider_id="p1",
        token_id=99,
    )

    assert pending["status"] == "succeeded"

    # A restart worker must also recognize the already-adopted current token
    # before dispatching the safety receipt upstream.
    service._recover_operation(pending)
    assert pending["status"] == "succeeded"
    assert service._newapi.calls == []


def test_bound_stale_issue_receipt_is_exactly_revoked_before_supersede():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(days=2), token_id=8, version=2))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)
    operation = {
        "operation_id": "stale-bound", "tenant_id": "tenant-1", "provider_id": "p1",
        "newapi_user_id": 11, "newapi_token_id": 99, "token_name": "relay-v2",
        "operation_type": "issue", "desired_model_ids": ["m1"],
        "desired_expires_at": NOW + timedelta(days=1), "policy_revision": "policy",
        "expected_access_version": 1, "expected_access_token_id": 7,
    }

    with pytest.raises(NewApiError, match="superseded") as exc_info:
        service._recover_operation(operation)

    assert exc_info.value.token_id == 99
    assert newapi.calls == [("revoke", 99)]
    revoke = next(
        item for item in repo.operations.values()
        if item["operation_type"] == "revoke" and item["newapi_token_id"] == 99
    )
    assert revoke["status"] == "succeeded"


def test_stale_issue_receipt_cannot_overwrite_newer_access():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(days=2), token_id=8, version=2))
    newapi = FreshNewAPI()
    service = _service(repo, newapi, refs=None)
    operation = {
        "operation_id": "stale", "tenant_id": "tenant-1", "provider_id": "p1",
        "newapi_user_id": 11, "newapi_token_id": None, "token_name": "relay-v2",
        "operation_type": "issue", "desired_model_ids": ["m1"],
        "desired_expires_at": NOW + timedelta(days=1), "policy_revision": "policy",
        "expected_access_version": 1, "expected_access_token_id": 7,
    }

    with pytest.raises(NewApiError, match="superseded"):
        service._recover_operation(operation)
    assert newapi.calls == []
    assert repo.access.newapi_token_id == 8


def test_access_commit_rejects_takeover_after_service_precheck():
    class TakeoverRepo(LifecycleRepo):
        def upsert_access_with_relay_token(self, **kwargs):
            assert kwargs["operation_id"] == "takeover"
            assert kwargs["claim_owner"] == "owner-a"
            self.operations["takeover"]["claim_owner"] = "owner-b"
            raise RuntimeError("relay lifecycle access commit claim is stale")

    repo = TakeoverRepo(_access(models=("m1",), expires_at=NOW + timedelta(days=2), token_id=7, version=1))
    operation = {
        "operation_id": "takeover",
        "status": "running",
        "claim_owner": "owner-a",
    }
    repo.operations["takeover"] = dict(operation)
    service = _service(repo, ExistingUserNewAPI(), refs=None)

    with pytest.raises(RuntimeError, match="claim is stale"):
        service._persist_access(
            tenant_id="tenant-1", provider_id="p1", relay_token="stale-key",
            management_token="management-key", allowed_model_ids=["m1"], username="attenant",
            user_id=11, token_id=88, expires_at=NOW + timedelta(days=1), policy_revision="policy",
            token_name="relay-v2", old_access=repo.access, operation=operation,
        )

    assert repo.access.newapi_token_id == 7
    assert repo.operations["takeover"]["claim_owner"] == "owner-b"


def test_expired_issue_receipt_reconciles_recorded_token_without_create():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(days=2), token_id=7, version=1))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)
    operation = {
        "operation_id": "expired-recorded", "tenant_id": "tenant-1", "provider_id": "p1",
        "newapi_user_id": 11, "newapi_token_id": 99, "token_name": "relay-v2",
        "operation_type": "issue", "desired_model_ids": ["m1"],
        "desired_expires_at": NOW - timedelta(seconds=1), "policy_revision": "policy",
        "expected_access_version": 1, "expected_access_token_id": 7,
    }

    with pytest.raises(NewApiError, match="receipt expired") as exc_info:
        service._recover_operation(operation)

    assert exc_info.value.token_id == 99
    assert newapi.calls == [("revoke", 99)]
    revoke = next(
        item for item in repo.operations.values()
        if item["operation_type"] == "revoke" and item["newapi_token_id"] == 99
    )
    assert revoke["status"] == "succeeded"
    assert repo.access.newapi_token_id == 7


def test_expired_issue_receipt_without_recorded_id_never_creates():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(days=2), token_id=7, version=1))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)
    operation = {
        "operation_id": "expired-unbound", "tenant_id": "tenant-1", "provider_id": "p1",
        "newapi_user_id": 11, "newapi_token_id": None, "token_name": "relay-v2",
        "operation_type": "issue", "desired_model_ids": ["m1"],
        "desired_expires_at": NOW - timedelta(seconds=1), "policy_revision": "policy",
        "expected_access_version": 1, "expected_access_token_id": 7,
    }

    with pytest.raises(NewApiError, match="receipt expired"):
        service._recover_operation(operation)

    assert newapi.calls == []


def test_failed_local_access_read_does_not_revoke_observed_token():
    class UnreadableRepo(LifecycleRepo):
        def get_access(self, _tenant_id, _provider_id):
            raise RuntimeError("database unavailable")

    repo = UnreadableRepo(_access(models=("m1",), token_id=99))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)

    service._reconcile_failed_issue(
        {"operation_id": "issue", "status": "running"},
        tenant_id="tenant-1", provider_id="p1", management_token="management-key", user_id=11,
        token_name="relay-v2", allowed_model_ids=["m1"], expires_at=NOW + timedelta(days=1),
        policy_revision="policy", error=NewApiError("receipt read failed", token_id=88),
    )

    assert newapi.calls == []
    obligation = repo.operations["relay:revoke:tenant-1:p1:88:"]
    assert obligation["operation_type"] == "revoke"
    assert obligation["newapi_token_id"] == 88
    assert obligation["status"] == "pending"


def test_post_commit_failure_does_not_revoke_current_active_token():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(days=2), token_id=99))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)

    service._reconcile_failed_issue(
        {"operation_id": "issue"}, tenant_id="tenant-1", provider_id="p1",
        management_token="management-key", user_id=11, token_name="relay-v2",
        allowed_model_ids=["m1"], expires_at=NOW + timedelta(days=1),
        policy_revision="policy", error=NewApiError("receipt read failed", token_id=99),
    )

    assert newapi.calls == []
    assert repo.operations == {}


def test_policy_change_after_create_revokes_new_token_before_commit():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    policy = FakeEnterprise([{"provider_id": "p1", "model_id": "m1"}])
    newapi = PolicyFlipNewAPI(lambda: setattr(policy, "refs", [{"provider_id": "p1", "model_id": "m2"}]))
    service = PlatformProviderService(
        repo, newapi, FakeCrypto(), "http://relay/v1", enterprise_repository=policy,
        clock=lambda: NOW, renewal_window=timedelta(hours=24),
    )

    with pytest.raises(Conflict, match="provisioning failed"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert repo.access.newapi_token_id == 7
    assert [call[0] for call in newapi.calls] == ["create", "revoke", "revoke"]
    assert {call[1] for call in newapi.calls if call[0] == "revoke"} == {7, 99}
    assert any(op["operation_type"] == "revoke" and op["newapi_token_id"] == 99 for op in repo.operations.values())


def test_uncertain_created_token_is_recorded_by_id_for_recovery_revoke():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    newapi = CreateKeyFailureNewAPI()
    service = _service(repo, newapi, refs=None)

    with pytest.raises(Conflict, match="provisioning failed"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    revoke_ops = [op for op in repo.operations.values() if op["operation_type"] == "revoke"]
    assert revoke_ops and revoke_ops[0]["newapi_token_id"] == 99
    assert revoke_ops[0]["status"] == "succeeded"
    assert [call[0] for call in newapi.calls] == ["create", "revoke"]


def test_failed_safety_revoke_blocks_unbounded_replacement_generations():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    newapi = CreateKeyFailureNewAPI(revoke_errors=1)
    service = _service(repo, newapi, refs=None)

    with pytest.raises(Conflict, match="provisioning failed"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])
    with pytest.raises(Conflict, match="cleanup is pending"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    assert sum(call[0] == "create" for call in newapi.calls) == 1


def test_failed_revoke_is_recorded_and_recovery_retries_without_reissuing():
    repo = LifecycleRepo(_access(models=("m1",), expires_at=NOW + timedelta(hours=1)))
    newapi = ExistingUserNewAPI(revoke_errors=1)
    service = _service(repo, newapi, refs=None)

    result = service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])
    assert result["relay_token"].startswith("new-")
    assert sum(call[0] == "create" for call in newapi.calls) == 1
    failed = [op for op in repo.operations.values() if op["operation_type"] == "revoke"]
    assert failed and failed[0]["status"] == "failed"

    recovered = service.recover_relay_token_operations(
        force=True, tenant_id="tenant-1", provider_id="p1",
    )

    assert recovered == {"processed": 1, "succeeded": 1, "failed": 0}
    assert sum(call[0] == "create" for call in newapi.calls) == 1
    assert failed[0]["status"] == "succeeded"


def test_service_pricing_publication_and_catalog_boundaries():
    now = NOW
    provider = PROVIDER
    model = MODELS[0]
    rate = RateRow(
        "rate-1", "p1", "m1", 1, "known", "token", Decimal("1"), Decimal("2"),
        None, None, None, "USD", "manual", None, now, None, True,
    )
    state = {"provider": provider, "status_result": model, "published": [model]}

    class Repo:
        def get_provider(self, _provider_id):
            return state["provider"]

        def get_model(self, _provider_id, _model_id):
            return model

        def current_rate(self, _provider_id, _model_id):
            return rate

        def create_rate(self, *_args, **_kwargs):
            return rate

        def set_model_status(self, *_args, **_kwargs):
            return state["status_result"]

        def publish_priced_models(self, _provider_id):
            return state["published"]

        def list_models(self, _provider_id, **_kwargs):
            return [model]

        def list_providers(self, **_kwargs):
            return [provider]

        def ensure_internal_provider(self, **_kwargs):
            return provider

    service = PlatformProviderService(Repo(), None, FakeCrypto(), "https://relay/v1")
    assert service.set_rate(
        "p1", "m1", source="manual", effective_from=now,
        input_usd_per_million=Decimal("1"), output_usd_per_million=Decimal("2"),
    ).rate_id == rate.rate_id
    with pytest.raises(Conflict, match="requires input and output"):
        service.set_rate("p1", "m1", input_usd_per_million=None, output_usd_per_million=Decimal("1"))
    assert service.publish_model("p1", "m1").model_id == "m1"
    state["status_result"] = None
    with pytest.raises(NotFound, match="platform model"):
        service.publish_model("p1", "m1")
    state["provider"] = replace(provider, status="draft")
    with pytest.raises(Conflict, match="publish the large-model"):
        service.publish_priced_models("p1")
    state["provider"] = provider
    assert service.publish_priced_models("p1") == {"published": 1}
    ref = PlatformModelRef(provider_id="p1", provider_version=1, model_id="m1", model_version=1)
    assert service.validate_model_ref(ref, require_published=True) == ref

    class MissingEnterprise:
        def get_by_tenant_id(self, _tenant_id):
            raise NotFound("missing")

    service = PlatformProviderService(
        Repo(), None, FakeCrypto(), "https://relay/v1", enterprise_repository=MissingEnterprise(),
    )
    assert service._allowed_model_refs("tenant-1") == []


def test_service_catalog_discovery_and_publish_guards():
    class CatalogRepo:
        def __init__(self):
            self.provider = PROVIDER
            self.models = list(MODELS)
            self.rates = {"m1": None, "m2": None, "m3": None}

        def get_provider(self, _provider_id):
            return self.provider

        def get_model(self, _provider_id, _model_id):
            return MODELS[0]

        def list_models(self, _provider_id, **_kwargs):
            return self.models

        def list_providers(self, **_kwargs):
            return [self.provider]

        def current_rate(self, _provider_id, model_id):
            return self.rates.get(model_id)

        def upsert_discovered_models(self, _provider_id, _model_ids):
            return [MODELS[0]]

        def set_model_status(self, _provider_id, _model_id, _status):
            return None

        def publish_priced_models(self, _provider_id):
            return []

        def ensure_internal_provider(self, **_kwargs):
            return self.provider

    class Discovery:
        def __init__(self, result=None, error=None):
            self.result = result
            self.error = error

        def get_channel_models(self, _channel_id):
            if self.error:
                raise self.error
            return self.result

    repo = CatalogRepo()
    service = PlatformProviderService(repo, Discovery(["m1"]), FakeCrypto(), "http://relay/v1")
    assert service.sync_models("p1")[0].model_id == "m1"
    with pytest.raises(Conflict, match="channel"):
        service._sync_models(replace(PROVIDER, newapi_channel_id=None))
    with pytest.raises(Conflict, match="discovery failed"):
        PlatformProviderService(repo, Discovery(error=NewApiError("gateway")), FakeCrypto(), "http://relay/v1").sync_models("p1")
    with pytest.raises(Conflict, match="discovered no models"):
        PlatformProviderService(repo, Discovery([]), FakeCrypto(), "http://relay/v1").sync_models("p1")

    with pytest.raises(Conflict, match="known active price"):
        service.publish_model("p1", "m1")
    repo.rates["m1"] = RateRow(
        "r1", "p1", "m1", 1, "known", "token", Decimal("1"), Decimal("1"),
        None, None, None, "USD", "manual", None, NOW, None, True,
    )
    with pytest.raises(NotFound, match="platform model"):
        service.publish_model("p1", "m1")
    repo.provider = replace(PROVIDER, status="draft")
    with pytest.raises(Conflict, match="not published"):
        service.validate_model_ref(
            PlatformModelRef(provider_id="p1", provider_version=1, model_id="m1", model_version=1),
            require_published=True,
        )
    with pytest.raises(Conflict, match="large-model"):
        service.publish_priced_models("p1")


def test_service_access_expiry_and_issue_expiry_guards():
    access = _access()
    service = _service(LifecycleRepo(access), ExistingUserNewAPI(), refs=None)
    assert service._access_is_effective(access, NOW)
    assert not service._access_is_effective(replace(access, status="revoked"), NOW)
    assert not service._access_is_effective(replace(access, newapi_token_id=None), NOW)
    assert not service._access_is_effective(replace(access, expires_at=None), NOW)
    naive = replace(access, expires_at=(NOW + timedelta(days=1)).replace(tzinfo=None))
    assert service._access_is_effective(naive, NOW)
    assert service._access_needs_renewal(replace(access, expires_at=NOW + timedelta(hours=1)), NOW)
    assert service._access_needs_renewal(replace(access, status="revoked"), NOW)

    operation = {"operation_id": "issue-expiry", "status": "running", "create_attempt_state": "not_started"}
    with pytest.raises(NewApiError, match="invalid expiry"):
        service._issue_relay_token(
            operation, dashboard_token="management", user_id=11, name="relay", model_ids=["m1"], expired_time=-10**20,
        )
    with pytest.raises(NewApiError, match="expired before upstream"):
        service._issue_relay_token(
            operation, dashboard_token="management", user_id=11, name="relay", model_ids=["m1"], expired_time=int((NOW - timedelta(seconds=1)).timestamp()),
        )


def test_service_bootstrap_rejects_upstream_identity_and_quota_inconsistency():
    class MismatchLogin(FreshNewAPI):
        def login(self, _username, _password):
            return "dashboard", 12

    repo = LifecycleRepo(None)
    service = _service(repo, MismatchLogin(), refs=[{"provider_id": "p1", "model_id": "m1"}])
    with pytest.raises(NewApiError, match="identity mismatch"):
        service._provision_relay_access(
            provider=PROVIDER, tenant_id="tenant-1", provider_id="p1", existing=None,
            allowed_model_ids=["m1"], policy_revision="policy",
        )

    class NegativeQuota(FreshNewAPI):
        def get_user_quota(self, *, dashboard_token, user_id):
            return -1

    repo = LifecycleRepo(None)
    service = _service(repo, NegativeQuota(), refs=[{"provider_id": "p1", "model_id": "m1"}])
    with pytest.raises(NewApiError, match="quota is invalid"):
        service._provision_relay_access(
            provider=PROVIDER, tenant_id="tenant-1", provider_id="p1", existing=None,
            allowed_model_ids=["m1"], policy_revision="policy",
        )


def test_service_public_price_sync_counts_unmatched_manual_and_known():
    model_a = replace(MODELS[0], model_id="m1")
    model_b = replace(MODELS[1], model_id="m2")
    model_c = replace(MODELS[2], model_id="m3")
    manual = RateRow(
        "r1", "p1", "m2", 1, "known", "token", Decimal("1"), Decimal("2"), None, None, None,
        "USD", "manual", None, NOW, None, True,
    )
    known = RateRow(
        "r2", "p1", "m3", 1, "known", "token", Decimal("3"), Decimal("4"), None, None, None,
        "USD", "public_reference", "v1", NOW, None, False,
    )

    class Repo:
        def get_provider(self, _provider_id):
            return PROVIDER

        def list_models(self, _provider_id, **_kwargs):
            return [model_a, model_b, model_c]

        def current_rate(self, _provider_id, model_id):
            return {"m1": None, "m2": manual, "m3": known}[model_id]

    class Pricing:
        def fetch(self):
            return {
                "m1": PublicModelPrice(Decimal("8"), Decimal("8")),
                "m2": PublicModelPrice(Decimal("9"), Decimal("9")),
                "m3": PublicModelPrice(Decimal("3"), Decimal("4"), source_version="v1"),
            }

    service = PlatformProviderService(Repo(), None, FakeCrypto(), "https://relay/v1", Pricing())
    updates = []
    service.set_rate = lambda *_args, **values: updates.append(values)
    result = service.sync_public_prices("p1", force=True)
    assert result == {
        "source": "models.dev", "updated": 1, "skipped_known": 1,
        "skipped_manual": 1, "unmatched": 0,
    }
    assert updates[0]["source"] == "public_reference"


def test_service_resolution_reuses_effective_access_and_rejects_input_edges():
    repo = LifecycleRepo(_access(models=("m1", "m2")))
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)
    result = service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])
    assert result["relay_token"] == "relay-key"
    assert newapi.calls == []

    empty_repo = LifecycleRepo(None)
    empty_service = _service(empty_repo, ExistingUserNewAPI(), refs=None)
    with pytest.raises(Conflict, match="no allowed models"):
        empty_service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=[])
    with pytest.raises(Conflict, match="only include published"):
        empty_service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["not-published"])

    requested_empty_repo = LifecycleRepo(_access(models=("m1",)))
    requested_empty_service = _service(requested_empty_repo, ExistingUserNewAPI(), refs=None)
    with pytest.raises(Conflict, match="at least one model"):
        requested_empty_service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=[])


def test_service_disabled_provider_and_policy_failure_fence_existing_access():
    repo = LifecycleRepo(_access(models=("m1",)))
    repo.provider = replace(PROVIDER, status="disabled")
    newapi = ExistingUserNewAPI()
    service = _service(repo, newapi, refs=None)
    with pytest.raises(Conflict, match="not published"):
        service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])
    assert newapi.calls == [("revoke", 7)]

    failed_repo = LifecycleRepo(_access(models=("m1",)))
    failed_repo.provider = replace(PROVIDER, status="disabled")
    failed_newapi = FakeNewAPI(revoke_errors=1)
    failed_service = _service(failed_repo, failed_newapi, refs=None)
    with pytest.raises(Conflict, match="revocation failed"):
        failed_service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])

    class FlippingEnterprise:
        def __init__(self):
            self.calls = 0

        def get_by_tenant_id(self, _tenant_id):
            self.calls += 1
            refs = [{"provider_id": "p1", "model_id": "m1"}] if self.calls == 1 else [{"provider_id": "p1", "model_id": "m2"}]
            return type("Account", (), {"allowed_model_refs": refs})()

    policy_repo = LifecycleRepo(_access(models=("m1", "m2")))
    policy_repo.tokens[7] = {"status": "active"}
    policy_service = PlatformProviderService(
        policy_repo, ExistingUserNewAPI(), FakeCrypto(), "http://relay/v1",
        enterprise_repository=FlippingEnterprise(), clock=lambda: NOW,
        renewal_window=timedelta(hours=24),
    )
    with pytest.raises(Conflict, match="policy changed"):
        policy_service.resolve_tenant_access(tenant_id="tenant-1", provider_id="p1", model_ids=["m1"])


def test_service_adapter_fallbacks_revoke_delete_and_runtime_guards():
    access = _access()
    calls = []

    class UpdateOnly:
        def update_relay_token(self, **kwargs):
            calls.append(("update", kwargs))
            return {"success": True}

    service = _service(LifecycleRepo(access), UpdateOnly(), refs=None)
    assert service._revoke_upstream(access, 7) is True
    assert calls[0][1]["status"] == 2

    class DeleteOnly:
        def delete_token(self, **kwargs):
            calls.append(("delete", kwargs))
            return True

    calls.clear()
    service = _service(LifecycleRepo(access), DeleteOnly(), refs=None)
    assert service._revoke_upstream(access, 7) is True
    assert calls[0][0] == "delete"
    assert service._delete_upstream(access, 7) is True

    class Unsupported:
        pass

    service = _service(LifecycleRepo(access), Unsupported(), refs=None)
    with pytest.raises(NewApiError, match="unsupported"):
        service._revoke_upstream(access, 7)
    with pytest.raises(NewApiError, match="unsupported"):
        service._delete_upstream(access, 7)
    with pytest.raises(NewApiError, match="identity"):
        service._revoke_upstream(replace(access, newapi_user_id=None), 7)


def test_service_claim_heartbeat_and_upstream_lease_edges():
    service = _service(object(), object(), refs=None)
    pending = {"operation_id": "pending", "status": "pending", "attempt_count": 0}
    assert service._claim_operation(pending) is pending
    assert service._claim_operation({"operation_id": "done", "status": "succeeded"}) is None
    assert service.heartbeat_relay_token_operation({"status": "pending"}) is None
    expired = {
        "operation_id": "expired", "status": "running", "claim_owner": "owner",
        "lease_until": NOW - timedelta(seconds=1),
    }
    assert service.heartbeat_relay_token_operation(expired) is None

    lease_lost = {"operation_id": "lease", "status": "running", "claim_owner": "owner"}
    service.heartbeat_relay_token_operation = lambda _operation: None
    with pytest.raises(NewApiError, match="lease is no longer owned"):
        service._call_upstream(lease_lost, lambda: True)

    heartbeat_calls = 0

    def heartbeat_after_callback(_operation):
        nonlocal heartbeat_calls
        heartbeat_calls += 1
        return object() if heartbeat_calls == 1 else None

    service.heartbeat_relay_token_operation = heartbeat_after_callback
    with pytest.raises(NewApiError, match="lease expired") as lease_error:
        service._call_upstream(lease_lost, lambda: (88, "token"))
    assert lease_error.value.token_id == 88


def test_claim_heartbeat_runs_during_a_long_upstream_callback_and_stops_cleanly():
    service = _service(object(), object(), refs=None, heartbeat_interval=0.01)
    operation = {
        "operation_id": "long-callback",
        "status": "running",
        "claim_owner": "owner",
    }
    heartbeat_seen = threading.Event()
    heartbeat_calls = 0

    def heartbeat(_operation):
        nonlocal heartbeat_calls
        heartbeat_calls += 1
        if heartbeat_calls >= 2:
            heartbeat_seen.set()
        return object()

    service.heartbeat_relay_token_operation = heartbeat

    def callback():
        assert heartbeat_seen.wait(1)
        assert heartbeat_calls >= 2
        return "result"

    assert service._call_upstream(operation, callback) == "result"
    # One preflight, at least one in-flight refresh, and one final refresh;
    # stop_heartbeat joins the worker before the final refresh is made.
    assert heartbeat_calls >= 3
    assert not any(
        thread.is_alive() and thread.name == "relay-claim-heartbeat"
        for thread in threading.enumerate()
    )


def test_lost_in_flight_heartbeat_blocks_success_and_preserves_token_id():
    service = _service(object(), object(), refs=None, heartbeat_interval=0.01)
    operation = {
        "operation_id": "lost-callback",
        "status": "running",
        "claim_owner": "owner",
    }
    heartbeat_lost = threading.Event()
    heartbeat_calls = 0

    def heartbeat(_operation):
        nonlocal heartbeat_calls
        heartbeat_calls += 1
        if heartbeat_calls >= 2:
            heartbeat_lost.set()
            return None
        return object()

    service.heartbeat_relay_token_operation = heartbeat

    def callback():
        assert heartbeat_lost.wait(1)
        return 88, "token"

    with pytest.raises(NewApiError, match="lease expired") as exc_info:
        service._call_upstream(operation, callback)
    assert exc_info.value.token_id == 88
    assert heartbeat_calls == 2


def test_service_recovery_handles_update_delete_and_invalid_receipts():
    access = _access()
    class UpdateNewAPI(ExistingUserNewAPI):
        def __init__(self):
            super().__init__()
            self.updated = []

        def update_relay_token(self, **kwargs):
            self.updated.append(kwargs)
            return {"success": True}

    update_api = UpdateNewAPI()
    update_repo = LifecycleRepo(access)
    update_service = _service(update_repo, update_api, refs=None)
    update_service._recover_operation({
        "operation_id": "update", "status": "running", "claim_owner": "owner",
        "tenant_id": "tenant-1", "provider_id": "p1", "operation_type": "update",
        "newapi_user_id": 11, "newapi_token_id": 7, "token_name": "relay-v1",
        "desired_model_ids": ["m1"], "desired_expires_at": NOW + timedelta(days=1),
        "policy_revision": "policy",
    })
    assert update_api.updated[0]["token_id"] == 7

    class DeleteNewAPI(ExistingUserNewAPI):
        def delete_relay_token(self, **kwargs):
            self.calls.append(("delete", kwargs["token_id"]))
            return True

    delete_api = DeleteNewAPI()
    delete_repo = LifecycleRepo(replace(access, status="revoked"))
    delete_service = _service(delete_repo, delete_api, refs=None)
    delete_service._recover_operation({
        "operation_id": "delete", "status": "running", "claim_owner": "owner",
        "tenant_id": "tenant-1", "provider_id": "p1", "operation_type": "delete",
        "newapi_user_id": 11, "newapi_token_id": 7, "token_name": "relay-v1",
        "desired_model_ids": [], "desired_expires_at": NOW, "policy_revision": "policy",
    })
    assert delete_api.calls == [("delete", 7)]

    invalid_service = _service(LifecycleRepo(access), ExistingUserNewAPI(), refs=None)
    with pytest.raises(NewApiError, match="invalid scope"):
        invalid_service._recover_operation({"operation_type": "revoke"})
    missing_service = _service(LifecycleRepo(None), ExistingUserNewAPI(), refs=None)
    with pytest.raises(NewApiError, match="unavailable"):
        missing_service._recover_operation({
            "tenant_id": "tenant-1", "provider_id": "p1", "operation_type": "update",
            "newapi_token_id": 7,
        })
