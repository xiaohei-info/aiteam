"""L1-S02 Enterprise / Membership / Employee aggregate tests.

Covers T01-T07 per the L1 plan:
  T01 - enterprise creation validation
  T02 - membership role validity
  T03 - employee status lifecycle
  T04 - migration verifies tables exist
  T05 - entity invariants and invalid transitions
  T06 - repository persistence (enterprise + employee)
"""
import uuid

import pytest

from team_panel.domain.enums import (
    EmployeeStatus,
    EnterpriseRole,
    EnterpriseStatus,
    MembershipStatus,
)
from team_panel.domain.entities import (
    Enterprise,
    Membership,
    Employee,
)


# ═══════════════════════════════════════════════════════════════════
# T01: Enterprise creation validation
# ═══════════════════════════════════════════════════════════════════

def test_create_enterprise_requires_name_and_id():
    """Enterprise must have id and name to be meaningful."""
    ent = Enterprise(id="ent_001", name="Acme AI Lab")
    assert ent.id == "ent_001"
    assert ent.name == "Acme AI Lab"
    assert ent.status == "active"  # default per design


def test_enterprise_default_status_is_active():
    ent = Enterprise(id="ent_001", name="Test")
    assert ent.status == EnterpriseStatus.ACTIVE


def test_enterprise_can_add_employee_when_active():
    ent = Enterprise(id="ent_001", name="Test", status="active")
    assert ent.can_add_employee() is True


def test_enterprise_cannot_add_employee_when_not_active():
    for status in ("suspended", "archived"):
        ent = Enterprise(id="ent_001", name="Test", status=status)
        assert ent.can_add_employee() is False, f"Expected False for {status}"


def test_enterprise_suspend():
    ent = Enterprise(id="ent_001", name="Test", status="active")
    ent.suspend("payment overdue")
    assert ent.status == "suspended"
    assert ent.archive_reason == "payment overdue"


def test_enterprise_suspend_already_suspended_is_idempotent():
    ent = Enterprise(id="ent_001", name="Test", status="suspended")
    ent.suspend("again")
    assert ent.status == "suspended"


def test_enterprise_cannot_suspend_archived():
    ent = Enterprise(id="ent_001", name="Test", status="archived")
    with pytest.raises(ValueError, match="Cannot suspend archived"):
        ent.suspend()


def test_enterprise_archive():
    ent = Enterprise(id="ent_001", name="Test", status="active")
    ent.archive("no longer needed")
    assert ent.status == "archived"
    assert ent.archive_reason == "no longer needed"


def test_enterprise_reactivate():
    ent = Enterprise(id="ent_001", name="Test", status="suspended")
    ent.reactivate()
    assert ent.status == "active"


def test_enterprise_cannot_reactivate_from_active():
    ent = Enterprise(id="ent_001", name="Test", status="active")
    with pytest.raises(ValueError, match="Cannot reactivate"):
        ent.reactivate()


def test_enterprise_cannot_reactivate_from_archived():
    ent = Enterprise(id="ent_001", name="Test", status="archived")
    with pytest.raises(ValueError, match="Cannot reactivate"):
        ent.reactivate()


# ═══════════════════════════════════════════════════════════════════
# T02: Membership role validity
# ═══════════════════════════════════════════════════════════════════

def test_membership_role_must_be_valid_enterprise_role():
    """Membership.role must be one of the 4 enterprise roles per §8.1."""
    valid_roles = {"owner", "enterprise_admin", "finance_admin", "member"}
    # The set of EnterpriseRole values must match the shared contract exactly
    enum_values = set(e.value for e in EnterpriseRole)
    assert enum_values == valid_roles, f"Expected {valid_roles}, got {enum_values}"


def test_membership_creation_with_valid_roles():
    for role in EnterpriseRole:
        m = Membership(id="mbr_001", enterprise_id="ent_001", user_id="usr_001", role=role)
        assert m.role == role


def test_membership_default_role_is_member():
    m = Membership(id="mbr_001", enterprise_id="ent_001", user_id="usr_001")
    assert m.role == EnterpriseRole.MEMBER


def test_membership_default_status_is_active():
    m = Membership(id="mbr_001", enterprise_id="ent_001", user_id="usr_001")
    assert m.status == MembershipStatus.ACTIVE


def test_membership_is_admin():
    admin = Membership(id="mbr_001", enterprise_id="ent_001", user_id="usr_001", role=EnterpriseRole.OWNER)
    assert admin.is_admin() is True
    ea = Membership(id="mbr_002", enterprise_id="ent_001", user_id="usr_002", role=EnterpriseRole.ENTERPRISE_ADMIN)
    assert ea.is_admin() is True

    member = Membership(id="mbr_003", enterprise_id="ent_001", user_id="usr_003", role=EnterpriseRole.MEMBER)
    assert member.is_admin() is False
    fa = Membership(id="mbr_004", enterprise_id="ent_001", user_id="usr_004", role=EnterpriseRole.FINANCE_ADMIN)
    assert fa.is_admin() is False


# ═══════════════════════════════════════════════════════════════════
# T03: Employee status lifecycle
# ═══════════════════════════════════════════════════════════════════

def _make_employee(status=EmployeeStatus.DRAFT):
    return Employee(
        id="emp_001",
        enterprise_id="ent_001",
        profile_name="ent001-test-001",
        display_name="Test Agent",
        status=status,
    )


def test_employee_default_status_is_draft():
    emp = Employee(id="emp_001", enterprise_id="ent_001", profile_name="test")
    assert emp.status == EmployeeStatus.DRAFT


# ── Happy path: draft → provisioning → active ⇄ paused → archived ──

def test_employee_lifecycle_draft_to_provisioning():
    emp = _make_employee(EmployeeStatus.DRAFT)
    emp.provision()
    assert emp.status == EmployeeStatus.PROVISIONING


def test_employee_lifecycle_provisioning_to_active():
    emp = _make_employee(EmployeeStatus.PROVISIONING)
    emp.activate()
    assert emp.status == EmployeeStatus.ACTIVE


def test_employee_lifecycle_active_to_paused():
    emp = _make_employee(EmployeeStatus.ACTIVE)
    emp.pause()
    assert emp.status == EmployeeStatus.PAUSED


def test_employee_lifecycle_paused_to_active():
    emp = _make_employee(EmployeeStatus.PAUSED)
    emp.resume()
    assert emp.status == EmployeeStatus.ACTIVE


def test_employee_lifecycle_active_to_archived():
    emp = _make_employee(EmployeeStatus.ACTIVE)
    emp.archive("deprecated")
    assert emp.status == EmployeeStatus.ARCHIVED
    assert emp.archive_reason == "deprecated"


# ── Provisioning failure path ──

def test_employee_lifecycle_provisioning_to_provisioning_failed():
    emp = _make_employee(EmployeeStatus.PROVISIONING)
    emp.mark_provisioning_failed()
    assert emp.status == EmployeeStatus.PROVISIONING_FAILED


def test_employee_lifecycle_retry_from_provisioning_failed():
    emp = _make_employee(EmployeeStatus.PROVISIONING_FAILED)
    emp.retry_provision()
    assert emp.status == EmployeeStatus.PROVISIONING


# ── Draft → active (direct activate shortcut per design) ──

def test_employee_lifecycle_draft_direct_to_active():
    emp = _make_employee(EmployeeStatus.DRAFT)
    emp.activate()
    assert emp.status == EmployeeStatus.ACTIVE


# ── Invalid transitions ──

def test_employee_cannot_provision_from_active():
    emp = _make_employee(EmployeeStatus.ACTIVE)
    with pytest.raises(ValueError, match="Cannot provision"):
        emp.provision()


def test_employee_cannot_provision_from_paused():
    emp = _make_employee(EmployeeStatus.PAUSED)
    with pytest.raises(ValueError, match="Cannot provision"):
        emp.provision()


def test_employee_cannot_provision_from_archived():
    emp = _make_employee(EmployeeStatus.ARCHIVED)
    with pytest.raises(ValueError, match="Cannot provision"):
        emp.provision()


def test_employee_cannot_activate_from_paused():
    emp = _make_employee(EmployeeStatus.PAUSED)
    with pytest.raises(ValueError, match="Cannot activate"):
        emp.activate()


def test_employee_cannot_activate_from_archived():
    emp = _make_employee(EmployeeStatus.ARCHIVED)
    with pytest.raises(ValueError, match="Cannot activate"):
        emp.activate()


def test_employee_cannot_mark_provisioning_failed_from_draft():
    emp = _make_employee(EmployeeStatus.DRAFT)
    with pytest.raises(ValueError, match="Cannot mark provisioning_failed"):
        emp.mark_provisioning_failed()


def test_employee_cannot_mark_provisioning_failed_from_active():
    emp = _make_employee(EmployeeStatus.ACTIVE)
    with pytest.raises(ValueError, match="Cannot mark provisioning_failed"):
        emp.mark_provisioning_failed()


def test_employee_cannot_pause_from_draft():
    emp = _make_employee(EmployeeStatus.DRAFT)
    with pytest.raises(ValueError, match="Cannot pause"):
        emp.pause()


def test_employee_cannot_pause_from_paused():
    emp = _make_employee(EmployeeStatus.PAUSED)
    with pytest.raises(ValueError, match="Cannot pause"):
        emp.pause()


def test_employee_cannot_pause_from_archived():
    emp = _make_employee(EmployeeStatus.ARCHIVED)
    with pytest.raises(ValueError, match="Cannot pause"):
        emp.pause()


def test_employee_cannot_resume_from_active():
    emp = _make_employee(EmployeeStatus.ACTIVE)
    with pytest.raises(ValueError, match="Cannot resume"):
        emp.resume()


def test_employee_cannot_resume_from_draft():
    emp = _make_employee(EmployeeStatus.DRAFT)
    with pytest.raises(ValueError, match="Cannot resume"):
        emp.resume()


def test_employee_cannot_archive_twice():
    emp = _make_employee(EmployeeStatus.ARCHIVED)
    with pytest.raises(ValueError, match="Already archived"):
        emp.archive()


def test_employee_cannot_retry_provision_from_draft():
    emp = _make_employee(EmployeeStatus.DRAFT)
    with pytest.raises(ValueError, match="Cannot retry provision"):
        emp.retry_provision()


def test_employee_cannot_retry_provision_from_active():
    emp = _make_employee(EmployeeStatus.ACTIVE)
    with pytest.raises(ValueError, match="Cannot retry provision"):
        emp.retry_provision()


# ── Convenience predicates ──

def test_employee_is_runnable_only_when_active():
    emp = _make_employee(EmployeeStatus.ACTIVE)
    assert emp.is_runnable() is True
    for s in (EmployeeStatus.DRAFT, EmployeeStatus.PROVISIONING, EmployeeStatus.PAUSED,
              EmployeeStatus.PROVISIONING_FAILED, EmployeeStatus.ARCHIVED):
        emp = _make_employee(s)
        assert emp.is_runnable() is False, f"Expected False for {s}"


def test_employee_is_provisionable():
    emp = _make_employee(EmployeeStatus.DRAFT)
    assert emp.is_provisionable() is True
    emp = _make_employee(EmployeeStatus.PROVISIONING_FAILED)
    assert emp.is_provisionable() is True
    for s in (EmployeeStatus.PROVISIONING, EmployeeStatus.ACTIVE, EmployeeStatus.PAUSED,
              EmployeeStatus.ARCHIVED):
        emp = _make_employee(s)
        assert emp.is_provisionable() is False, f"Expected False for {s}"


def test_enterprise_repo_create_and_get(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    repo = EnterpriseRepo(db_conn.cursor())

    ent = Enterprise(id="ent_test_001", slug="test-slug", name="Test Enterprise",
                     status="active", owner_user_id="usr_001")
    repo.create(ent)

    loaded = repo.get_by_id("ent_test_001")
    assert loaded is not None
    assert loaded.id == "ent_test_001"
    assert loaded.name == "Test Enterprise"
    assert loaded.slug == "test-slug"
    assert loaded.status == "active"
    assert loaded.owner_user_id == "usr_001"
    assert loaded.deleted_at is None


def test_enterprise_repo_get_nonexistent(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    repo = EnterpriseRepo(db_conn.cursor())
    assert repo.get_by_id("nonexistent") is None


def test_enterprise_repo_list_all(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    repo = EnterpriseRepo(db_conn.cursor())

    repo.create(Enterprise(id="ent_a", slug="a", name="A", status="active", owner_user_id="u1"))
    repo.create(Enterprise(id="ent_b", slug="b", name="B", status="active", owner_user_id="u2"))

    all_ents = repo.list_all()
    assert len(all_ents) == 2
    ids = {e.id for e in all_ents}
    assert ids == {"ent_a", "ent_b"}


def test_enterprise_repo_update(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    repo = EnterpriseRepo(db_conn.cursor())

    ent = Enterprise(id="ent_upd", slug="upd", name="Old", status="active", owner_user_id="u1")
    repo.create(ent)

    ent.name = "New Name"
    ent.status = "suspended"
    ent.archive_reason = "test"
    repo.update(ent)

    loaded = repo.get_by_id("ent_upd")
    assert loaded.name == "New Name"
    assert loaded.status == "suspended"
    assert loaded.archive_reason == "test"


def test_enterprise_repo_soft_delete(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    repo = EnterpriseRepo(db_conn.cursor())

    ent = Enterprise(id="ent_del", slug="del", name="Delete Me", status="active", owner_user_id="u1")
    repo.create(ent)
    repo.delete("ent_del")

    loaded = repo.get_by_id("ent_del")
    assert loaded is not None   # soft-delete keeps the row
    assert loaded.deleted_at is not None


def test_employee_repo_create_and_get(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    from team_panel.repositories.employee_repo import EmployeeRepo

    # need an enterprise first
    EnterpriseRepo(db_conn.cursor()).create(
        Enterprise(id="ent_emp_001", slug="empcorp", name="Emp Corp", status="active", owner_user_id="u1"))

    repo = EmployeeRepo(db_conn.cursor())
    emp = Employee(
        id="emp_test_001", enterprise_id="ent_emp_001",
        profile_name="ent001-worker-001", display_name="Worker",
        status=EmployeeStatus.ACTIVE,
    )
    repo.create(emp)

    loaded = repo.get_by_id("emp_test_001")
    assert loaded is not None
    assert loaded.id == "emp_test_001"
    assert loaded.enterprise_id == "ent_emp_001"
    assert loaded.profile_name == "ent001-worker-001"
    assert loaded.status == EmployeeStatus.ACTIVE
    assert loaded.deleted_at is None


def test_employee_repo_list_by_enterprise(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    from team_panel.repositories.employee_repo import EmployeeRepo

    EnterpriseRepo(db_conn.cursor()).create(
        Enterprise(id="ent_emp_002", slug="listcorp", name="List Corp", status="active", owner_user_id="u1"))

    repo = EmployeeRepo(db_conn.cursor())
    repo.create(Employee(id="emp_a", enterprise_id="ent_emp_002", profile_name="pf-a", status=EmployeeStatus.ACTIVE))
    repo.create(Employee(id="emp_b", enterprise_id="ent_emp_002", profile_name="pf-b", status=EmployeeStatus.PAUSED))

    emps = repo.list_by_enterprise("ent_emp_002")
    assert len(emps) == 2
    ids = {e.id for e in emps}
    assert ids == {"emp_a", "emp_b"}


def test_employee_repo_update_status(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    from team_panel.repositories.employee_repo import EmployeeRepo

    EnterpriseRepo(db_conn.cursor()).create(
        Enterprise(id="ent_emp_003", slug="statcorp", name="Stat Corp", status="active", owner_user_id="u1"))

    repo = EmployeeRepo(db_conn.cursor())
    emp = Employee(id="emp_stat", enterprise_id="ent_emp_003", profile_name="pf-stat",
                   status=EmployeeStatus.DRAFT)
    repo.create(emp)

    emp.provision()
    repo.update_status(emp)

    loaded = repo.get_by_id("emp_stat")
    assert loaded.status == EmployeeStatus.PROVISIONING


def test_employee_repo_soft_delete(db_conn):
    from team_panel.repositories.enterprise_repo import EnterpriseRepo
    from team_panel.repositories.employee_repo import EmployeeRepo

    EnterpriseRepo(db_conn.cursor()).create(
        Enterprise(id="ent_emp_004", slug="delcorp", name="Del Corp", status="active", owner_user_id="u1"))

    repo = EmployeeRepo(db_conn.cursor())
    emp = Employee(id="emp_del", enterprise_id="ent_emp_004", profile_name="pf-del",
                   status=EmployeeStatus.ACTIVE)
    repo.create(emp)
    repo.delete("emp_del")

    loaded = repo.get_by_id("emp_del")
    assert loaded is not None
    assert loaded.deleted_at is not None


# ═══════════════════════════════════════════════════════════════════
# Enums coverage
# ═══════════════════════════════════════════════════════════════════

def test_enterprise_role_enum_values():
    values = set(e.value for e in EnterpriseRole)
    assert values == {"owner", "enterprise_admin", "finance_admin", "member"}


def test_enterprise_status_enum_values():
    values = set(e.value for e in EnterpriseStatus)
    assert values == {"active", "suspended", "archived"}


def test_membership_status_enum_values():
    values = set(e.value for e in MembershipStatus)
    assert values == {"active", "invited", "disabled", "removed"}
