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


# ---- 存量状态补同步（升级前已暂停 / 封禁 / 注销的企业，Manager 侧仍是 active）----

def _provision(enterprises, gateway, admin, name):
    out = ProvisioningService(enterprises, gateway, admin_repo=admin).provision_enterprise(
        ProvisionEnterpriseRequest(enterprise_name=name, owner_phone="13800000000"),
    )
    return out.enterprise_id, enterprises.get(out.enterprise_id).tenant_id


def test_resync_pushes_every_non_active_status_to_manager(env):
    svc, admin, enterprises, gateway, relay, clock, active_id, active_tid = env
    suspended_id, suspended_tid = _provision(enterprises, gateway, admin, "暂停企业")
    deleting_id, deleting_tid = _provision(enterprises, gateway, admin, "删除中企业")
    deleted_id, deleted_tid = _provision(enterprises, gateway, admin, "已删除企业甲")
    purged_id, purged_tid = _provision(enterprises, gateway, admin, "已清理企业")
    svc.suspend(suspended_id, reason="欠费")
    svc.close(deleting_id)
    admin.set_operation_status(deleting_id, "deleting", normalized=True)
    svc.close(deleted_id)
    svc.delete(deleted_id, confirm_name="已删除企业甲")
    svc.close(purged_id)
    svc.delete(purged_id, confirm_name="已清理企业")
    clock.now = NOW + timedelta(days=31)
    svc.purge(purged_id)
    gateway.calls.clear()
    relay.revoked.clear()

    result = svc.resync_tenant_statuses()

    sent = {(c[1], c[2]) for c in gateway.calls if c[0] == "status"}
    # deleting 在 Manager 侧按“已注销”对待：删除尚未在 Manager 生效，重试删除时再改成 deleted。
    assert sent == {(suspended_tid, "suspended"), (deleting_tid, "closed"), (deleted_tid, "deleted")}
    assert set(relay.revoked) == {suspended_tid, deleting_tid, deleted_tid}
    assert result == {"synced": 3, "failed": []}
    assert active_tid not in {c[1] for c in gateway.calls} and purged_tid not in {c[1] for c in gateway.calls}
    # 只同步，不改 Operator 本地状态
    assert admin.get_state(suspended_id).operation_status == "suspended"
    assert admin.get_state(deleting_id).operation_status == "deleting"


def test_resync_reports_failures_and_continues(env):
    svc, admin, enterprises, gateway, _, _, eid, tid = env
    other_id, other_tid = _provision(enterprises, gateway, admin, "另一家")
    svc.suspend(eid)
    svc.ban(other_id, reason="违规")
    gateway.calls.clear()
    original = gateway.set_tenant_status

    def flaky(tenant_id, status, *, reason=None, idempotency_key):
        if tenant_id == tid:
            raise RuntimeError("manager down")
        return original(tenant_id, status, reason=reason, idempotency_key=idempotency_key)

    gateway.set_tenant_status = flaky
    result = svc.resync_tenant_statuses()
    assert result["synced"] == 1
    assert result["failed"] == [{"enterprise_id": eid, "status": "suspended", "error": "RuntimeError"}]
    assert ("status", other_tid, "banned", "违规") in gateway.calls


def test_resync_cli_prints_summary_and_exit_code(monkeypatch, capsys):
    import json

    from operation_service import tenant_status_resync

    class Stub:
        def __init__(self, result):
            self._result = result

        def resync_tenant_statuses(self):
            return self._result

    monkeypatch.setattr(tenant_status_resync, "get_admin_service", lambda: Stub({"synced": 2, "failed": []}))
    assert tenant_status_resync.main([]) == 0
    assert json.loads(capsys.readouterr().out) == {"synced": 2, "failed": []}
    failed = {"synced": 0, "failed": [{"enterprise_id": "e", "status": "banned", "error": "X"}]}
    monkeypatch.setattr(tenant_status_resync, "get_admin_service", lambda: Stub(failed))
    assert tenant_status_resync.main([]) == 1
