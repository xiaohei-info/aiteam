from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from manager_service.hindsight_client import HindsightSettings, HindsightUnavailable
from manager_service.hindsight_credentials import (
    HindsightLeaseStore,
    HindsightRuntimeService,
    derive_hindsight_bank_id,
)
from shared.contracts.snapshot import EmployeeExecutionSnapshot
from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, NotFound


class _Snapshot:
    def __init__(self, memory_policy: dict | None = None):
        self.value = EmployeeExecutionSnapshot(
            employee_id="employee-1",
            version="4",
            snapshot_version="snap-4",
            memory_policy=memory_policy,
        )

    def _ensure_runnable(self, ctx, *, employee_id: str):
        if employee_id != self.value.employee_id:
            raise NotFound("employee is not runnable")

    def generate(self, ctx, *, member_id: str, employee_id: str, employee_version=None):
        if employee_id != self.value.employee_id:
            raise Forbidden("member is not authorized for this expert")
        return self.value


def _settings() -> HindsightSettings:
    return HindsightSettings(
        "https://hindsight.internal",
        "manager-service-secret",
        "/recall",
        "/retain",
        "/delete",
        "/api/manager/hindsight",
        300,
    )


def _ctx(member_id: str = "member-1") -> TenantContext:
    return TenantContext(tenant_id="tenant-1", user_id=member_id, roles=["member"])


def test_employee_bank_scope_ignores_member_but_separates_employees():
    assert derive_hindsight_bank_id("tenant-1", "member-1", "employee-1") == derive_hindsight_bank_id("tenant-1", "member-2", "employee-1")
    assert derive_hindsight_bank_id("tenant-1", "member-1", "employee-1") != derive_hindsight_bank_id("tenant-1", "member-1", "employee-2")


def test_runtime_config_is_authorized_and_bank_scoped_without_snapshot_secret():
    snapshot = _Snapshot({"enabled": True, "allowed_operations": ["recall", "retain"]})
    service = HindsightRuntimeService(snapshot_service=snapshot, settings=_settings())

    result = service.runtime_config(_ctx(), employee_id="employee-1")

    assert result.base_url == "/api/manager/hindsight"
    assert result.bank_id == derive_hindsight_bank_id(
        "tenant-1", "member-1", "employee-1"
    )
    assert result.token
    assert result.token != "manager-service-secret"
    assert result.token not in repr(result)
    assert result.expires_at > datetime.now(timezone.utc)
    assert "token" not in snapshot.value.model_dump(mode="json")


def test_rotation_invalidates_old_lease_and_issues_new_version():
    snapshot = _Snapshot({"enabled": True})
    service = HindsightRuntimeService(snapshot_service=snapshot, settings=_settings())
    first = service.runtime_config(_ctx(), employee_id="employee-1")
    reused = service.runtime_config(_ctx(), employee_id="employee-1")
    rotated = service.runtime_config(_ctx(), employee_id="employee-1", rotate=True)

    assert reused.token == first.token
    assert rotated.version == first.version + 1
    assert rotated.token != first.token
    with pytest.raises(Exception, match="expired or revoked"):
        service.leases.resolve(first.token, bank_id=first.bank_id)
    assert (
        service.leases.resolve(rotated.token, bank_id=rotated.bank_id).lease_id
        == rotated.lease_id
    )


def test_revoke_is_member_scoped_and_does_not_return_token():
    snapshot = _Snapshot({"enabled": True})
    service = HindsightRuntimeService(snapshot_service=snapshot, settings=_settings())
    config = service.runtime_config(_ctx(), employee_id="employee-1")

    with pytest.raises(NotFound):
        service.revoke(_ctx("member-2"), lease_id=config.lease_id)
    result = service.revoke(_ctx(), lease_id=config.lease_id)
    assert result.status == "revoked"
    assert "token" not in result.model_dump()
    with pytest.raises(Exception, match="expired or revoked"):
        service.leases.resolve(config.token, bank_id=config.bank_id)


def test_disabled_policy_and_missing_upstream_fail_closed():
    disabled_snapshot = _Snapshot({"enabled": True})
    disabled = HindsightRuntimeService(
        snapshot_service=disabled_snapshot,
        settings=_settings(),
    )
    old = disabled.runtime_config(_ctx(), employee_id="employee-1")
    disabled_snapshot.value.memory_policy = {"enabled": False}
    with pytest.raises(Forbidden):
        disabled.runtime_config(_ctx(), employee_id="employee-1")
    with pytest.raises(Exception, match="expired or revoked"):
        disabled.leases.resolve(old.token, bank_id=old.bank_id)

    missing = HindsightRuntimeService(
        snapshot_service=_Snapshot({"enabled": True}),
        settings=HindsightSettings(None, None, None, None, None),
    )
    with pytest.raises(HindsightUnavailable):
        missing.runtime_config(_ctx(), employee_id="employee-1")


def test_lease_store_expiry_is_fail_closed():
    now = [datetime(2026, 1, 1, tzinfo=timezone.utc)]
    store = HindsightLeaseStore(ttl_seconds=30, now=lambda: now[0])
    lease = store.issue(
        tenant_id="t",
        member_id="m",
        employee_id="e",
        snapshot_version="s",
        policy={"enabled": True},
        bank_id="bank",
    )
    now[0] += timedelta(seconds=31)
    with pytest.raises(Exception, match="expired or revoked"):
        store.resolve(lease.token, bank_id="bank")
