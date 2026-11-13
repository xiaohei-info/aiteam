"""R5：企业生命周期联动 Manager、删除（closed→deleting→deleted）、恢复与保留期后清理。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from operation_service.admin_repository import AdminRepository
from operation_service.admin_service import AdminService
from operation_service.catalog_repository import CatalogRepository
from operation_service.manager_gateway import ManagerGateway
from operation_service.repository import InMemoryEnterpriseRepository
from operation_service.rollup_repository import CrossEnterpriseRollupRepository
from operation_service.schemas import ProvisionEnterpriseRequest
from operation_service.service import ProvisioningService
from shared.errors import Conflict, InvalidTransition, NotFound, ValidationProblem

NOW = datetime(2026, 11, 13, tzinfo=timezone.utc)


class Gateway(ManagerGateway):
    def __init__(self):
        self.calls: list[tuple] = []
        self.fail_status = False
        self.fail_purge = False

    def provision_tenant(self, req, *, idempotency_key): pass
    def sync_owner_bootstrap(self, req, *, idempotency_key): pass
    def notify_enterprise(self, req, *, idempotency_key): pass

    def set_tenant_status(self, tenant_id, status, *, reason=None, idempotency_key):
        if self.fail_status:
            raise RuntimeError("manager down")
        self.calls.append(("status", tenant_id, status, reason))

    def purge_tenant(self, tenant_id, *, idempotency_key):
        if self.fail_purge:
            raise RuntimeError("manager down")
        self.calls.append(("purge", tenant_id))


class Relay:
    def __init__(self, fail=False):
        self.revoked: list[str] = []
        self.fail = fail

    def revoke_tenant_access(self, tenant_id):
        if self.fail:
            raise RuntimeError("newapi down")
        self.revoked.append(tenant_id)


class Clock:
    def __init__(self):
        self.now = NOW

    def __call__(self):
        return self.now


@pytest.fixture
def env():
    admin, enterprises, gateway, relay, clock = AdminRepository(), InMemoryEnterpriseRepository(), Gateway(), Relay(), Clock()
    svc = AdminService(admin, enterprises, CatalogRepository(), CrossEnterpriseRollupRepository(),
                       manager_gateway=gateway, relay_access=relay, clock=clock)
    prov = ProvisioningService(enterprises, gateway, admin_repo=admin)
    out = prov.provision_enterprise(ProvisionEnterpriseRequest(enterprise_name="示例企业", owner_phone="13800000000"))
    tenant_id = enterprises.get(out.enterprise_id).tenant_id
    return svc, admin, enterprises, gateway, relay, clock, out.enterprise_id, tenant_id


def _statuses(gateway):
    return [c[2] for c in gateway.calls if c[0] == "status"]


def test_lifecycle_actions_sync_manager_first_and_fence_relay(env):
    svc, admin, _, gateway, relay, _, eid, tid = env
    svc.suspend(eid, reason="欠费")
    assert gateway.calls[-1] == ("status", tid, "suspended", "欠费")
    assert admin.get_state(eid).operation_status == "suspended" and relay.revoked == [tid]
    svc.reactivate(eid)
    assert _statuses(gateway) == ["suspended", "active"]
    svc.ban(eid, reason="违规")
    svc.close(eid)
    assert _statuses(gateway) == ["suspended", "active", "banned", "closed"]
    assert admin.get_state(eid).operation_status == "closed"


def test_manager_failure_leaves_local_state_unchanged(env):
    svc, admin, _, gateway, _, _, eid, _ = env
    gateway.fail_status = True
    with pytest.raises(RuntimeError):
        svc.suspend(eid, reason="x")
    assert admin.get_state(eid).operation_status == "active"


def test_relay_failure_does_not_block_status_change(env):
    svc, admin, _, _, relay, _, eid, _ = env
    relay.fail = True
    svc.suspend(eid)
    assert admin.get_state(eid).operation_status == "suspended"


def test_delete_requires_closed_and_matching_name(env):
    svc, admin, _, gateway, relay, _, eid, tid = env
    with pytest.raises(InvalidTransition):
        svc.delete(eid, confirm_name="示例企业")
    svc.close(eid)
    with pytest.raises(ValidationProblem):
        svc.delete(eid, confirm_name="别的名字")
    assert admin.get_state(eid).operation_status == "closed"
    svc.delete(eid, confirm_name="示例企业")
    state = admin.get_state(eid)
    assert state.operation_status == "deleted" and state.deleted_at == NOW
    assert gateway.calls[-1] == ("status", tid, "deleted", None)
    assert relay.revoked.count(tid) >= 2  # close + delete 都吊销


def test_delete_failure_stays_deleting_and_can_be_retried(env):
    svc, admin, _, gateway, _, _, eid, _ = env
    svc.close(eid)
    gateway.fail_status = True
    with pytest.raises(RuntimeError):
        svc.delete(eid, confirm_name="示例企业")
    assert admin.get_state(eid).operation_status == "deleting"
    gateway.fail_status = False
    svc.delete(eid, confirm_name="示例企业")
    assert admin.get_state(eid).operation_status == "deleted"


def test_deleted_hidden_from_default_list_but_filterable(env):
    svc, admin, *_rest, eid, _ = env
    svc.close(eid)
    svc.delete(eid, confirm_name="示例企业")
    assert [s.enterprise_id for s in admin.list_enterprises()] == []
    assert [s.enterprise_id for s in admin.list_enterprises(status="deleted")] == [eid]


def test_restore_within_retention_returns_to_closed(env):
    svc, admin, _, gateway, _, clock, eid, tid = env
    svc.close(eid)
    svc.delete(eid, confirm_name="示例企业")
    clock.now = NOW + timedelta(days=29)
    svc.restore(eid)
    assert admin.get_state(eid).operation_status == "closed"
    assert admin.get_state(eid).deleted_at is None
    assert gateway.calls[-1] == ("status", tid, "closed", None)


def test_restore_after_retention_or_when_not_deleted_is_rejected(env):
    svc, _, _, _, _, clock, eid, _ = env
    with pytest.raises(InvalidTransition):
        svc.restore(eid)
    svc.close(eid)
    svc.delete(eid, confirm_name="示例企业")
    clock.now = NOW + timedelta(days=31)
    with pytest.raises(Conflict):
        svc.restore(eid)


def test_purge_only_after_retention_then_anonymizes_and_blocks_restore(env):
    svc, admin, enterprises, gateway, _, clock, eid, tid = env
    svc.close(eid)
    svc.delete(eid, confirm_name="示例企业")
    clock.now = NOW + timedelta(days=29)
    with pytest.raises(Conflict):
        svc.purge(eid)
    clock.now = NOW + timedelta(days=31)
    svc.purge(eid)
    assert ("purge", tid) in gateway.calls
    account = enterprises.get(eid)
    assert account.enterprise_name != "示例企业" and account.owner_phone == ""
    assert account.enterprise_code == f"deleted-{tid}"
    assert admin.get_state(eid).purged_at == clock.now
    with pytest.raises(Conflict):
        svc.restore(eid)
    svc.purge(eid)  # 幂等：已清理再调不报错、不重复调用 Manager
    assert [c for c in gateway.calls if c[0] == "purge"] == [("purge", tid)]


def test_purge_manager_failure_keeps_data_and_is_retryable(env):
    svc, admin, enterprises, gateway, _, clock, eid, _ = env
    svc.close(eid)
    svc.delete(eid, confirm_name="示例企业")
    clock.now = NOW + timedelta(days=31)
    gateway.fail_purge = True
    with pytest.raises(RuntimeError):
        svc.purge(eid)
    assert enterprises.get(eid).enterprise_name == "示例企业" and admin.get_state(eid).purged_at is None
    gateway.fail_purge = False
    svc.purge(eid)
    assert admin.get_state(eid).purged_at is not None


def test_unknown_enterprise_is_not_found(env):
    svc = env[0]
    with pytest.raises(NotFound):
        svc.delete("nope", confirm_name="x")
