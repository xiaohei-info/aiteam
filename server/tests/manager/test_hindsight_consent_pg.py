"""Actual RLS, effective-policy writers, persisted protocol evidence and facade races."""
import json
from unittest.mock import Mock

import pytest

from manager_service.employee_bindings_repositories import EmployeeMemorySettingRepository
from manager_service.hindsight_lease_repository import HindsightLeaseRepository
from manager_service.schemas import EmployeeConfigIn
from tests.manager.test_memory_policy_pg import memory_pg  # real, disposable Manager fixture
from tests.manager.test_hindsight_consent import PROTOCOL

pytestmark = pytest.mark.integration


def issue(f, protocol=PROTOCOL):
    body = {"employee_id": f.eid}
    if protocol is not None:
        body["client_protocol"] = protocol
    return f.client.post("/api/manager/hindsight/runtime-config", headers=f.headers(f.member, ["member"]), json=body)


def call(f, config, recall=False):
    return f.client.post(f"/api/manager/hindsight/v1/default/banks/{config['bank_id']}/memories" + ("/recall" if recall else ""),
        headers={"Authorization": "Bearer " + config["token"]}, json={"query": "fixture"} if recall else {"items": [{"content": "fixture manual capability"}]})


def test_real_route_legacy_new_protocol_and_durable_lease_restart(memory_pg):
    f = memory_pg
    old = issue(f, None).json()["data"]
    assert old["allowed_operations"] == ["recall"] and old["client_protocol"] is None
    assert call(f, old).status_code == 403 and call(f, old, recall=True).status_code == 200
    current = issue(f).json()["data"]
    assert current["allowed_operations"] == ["recall", "retain"] and current["explicit_auto_retain"] is False
    assert current["lease_id"] != old["lease_id"]
    with f.router.session(f.ctx) as session:
        row = session.execute("SELECT token_sha256,allowed_operations,policy_revision,client_protocol FROM hindsight_lease WHERE lease_id=%s", (current["lease_id"],)).fetchone()
    assert row[1:] == (["recall", "retain"], 1, PROTOCOL)
    assert current["token"] not in str(row)
    restarted = HindsightLeaseRepository(f.dsn, f.admin_url)
    lease = restarted.resolve(current["token"], bank_id=current["bank_id"])
    assert lease.token == "" and lease.client_protocol == PROTOCOL and lease.policy_revision == 1
    f.app.state._hindsight_facade.leases = restarted
    assert call(f, current).status_code == 200
    # Simulate the pre-negotiation additive-schema row: no permission is invented.
    with f.router.session(f.ctx) as session:
        session.execute("UPDATE hindsight_lease SET client_protocol=NULL WHERE lease_id=%s", (current["lease_id"],))
    assert call(f, current).status_code == 403 and call(f, current, recall=True).status_code == 200


def test_both_effective_policy_writers_cut_off_previous_write_revision(memory_pg):
    f = memory_pg
    settings = EmployeeMemorySettingRepository(f.router)
    settings.upsert(f.ctx, employee_id=f.eid, policy={"explicit_auto_retain": True})
    active = issue(f).json()["data"]
    assert active["explicit_auto_retain"] is True and call(f, active).status_code == 200
    settings.upsert(f.ctx, employee_id=f.eid, policy={"explicit_auto_retain": False})
    assert call(f, active).status_code == 403
    assert call(f, active, recall=True).status_code == 200
    manual = issue(f).json()["data"]
    assert manual["explicit_auto_retain"] is False and call(f, manual).status_code == 200
    # The legacy employee config API cannot update a separate execution truth.
    f.config.update(f.ctx, EmployeeConfigIn(display_name="memory fixture", memory_policy={"explicit_auto_retain": True}), employee_id=f.eid)
    assert call(f, manual).status_code == 403
    renewed = issue(f).json()["data"]
    assert renewed["explicit_auto_retain"] is True
    assert renewed["policy_revision"] == settings.get(f.ctx, employee_id=f.eid).revision
    # A no-op/presence-preserving setting edit does not strand a current lease.
    settings.update(f.ctx, employee_id=f.eid)
    assert call(f, renewed).status_code == 200
    with f.router.session(f.ctx) as session:
        session.execute("UPDATE member_grant SET member_ids='{}'::uuid[] WHERE resource_id=%s", (f.eid,))
    assert call(f, renewed).status_code == 403 and call(f, renewed, recall=True).status_code == 403


def test_real_policy_commit_after_preparation_is_before_native_authorization_fence(memory_pg):
    f = memory_pg
    before = issue(f).json()["data"]
    def prepare(ctx, **kwargs):
        EmployeeMemorySettingRepository(f.router).upsert(f.ctx, employee_id=f.eid, policy={"explicit_auto_retain": True})
        return kwargs["body"]
    f.app.state._hindsight_facade._retention = Mock(prepare=Mock(side_effect=prepare))
    assert call(f, before).status_code == 403
    assert f.seen == []


def test_policy_change_during_trusted_provisioning_returns_no_stale_consent(memory_pg):
    f = memory_pg
    previous = issue(f).json()["data"]
    def provision(*args, **kwargs):
        EmployeeMemorySettingRepository(f.router).upsert(f.ctx, employee_id=f.eid, policy={"explicit_auto_retain": True})
    f.app.state._hindsight_runtime_service._banks = Mock(ensure_bank=Mock(side_effect=provision))
    result = issue(f)
    assert result.status_code == 403
    assert "token" not in result.json()
    assert f.leases.get(previous["lease_id"]).revoked_at is not None
    assert f.seen == []
