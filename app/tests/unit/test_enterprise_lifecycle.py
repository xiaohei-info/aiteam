"""Unit tests for Enterprise lifecycle state machine and EnterpriseQuota.

AITEAM-246 / GitHub #291: Enterprise 缺少完整生命周期和审计.
Pure domain tests — no DB required.
"""
import pytest

from app.team_panel.domain.entities import Enterprise, EnterpriseQuota
from app.team_panel.domain.enums import EnterpriseStatus


def _enterprise(**overrides):
    base = dict(id="ent_001", slug="acme", name="Acme", owner_user_id="usr_owner")
    base.update(overrides)
    return Enterprise(**base)


# ═══════════════════════════════════════════════════════════════════
# EnterpriseStatus enum
# ═══════════════════════════════════════════════════════════════════

class TestEnterpriseStatusEnum:
    def test_full_state_machine_values(self):
        assert EnterpriseStatus.ACTIVE == "active"
        assert EnterpriseStatus.SUSPENDED == "suspended"
        assert EnterpriseStatus.BANNED == "banned"
        assert EnterpriseStatus.CLOSED == "closed"

    def test_archived_removed(self):
        # archived was replaced by the explicit banned/closed split.
        with pytest.raises(AttributeError):
            _ = EnterpriseStatus.ARCHIVED


# ═══════════════════════════════════════════════════════════════════
# Enterprise lifecycle transitions
# ═══════════════════════════════════════════════════════════════════

class TestEnterpriseLifecycle:
    def test_newly_created_is_active(self):
        ent = _enterprise()
        assert ent.status == "active"
        assert ent.is_operational() is True
        assert ent.can_add_employee() is True

    def test_suspend_transitions_to_suspended(self):
        ent = _enterprise()
        ent.suspend("temp hold")
        assert ent.status == "suspended"
        assert ent.is_operational() is False
        assert ent.can_add_employee() is False
        assert ent.archive_reason == "temp hold"

    def test_ban_transitions_to_banned(self):
        ent = _enterprise()
        ent.ban("policy violation")
        assert ent.status == "banned"
        assert ent.is_operational() is False
        assert ent.archive_reason == "policy violation"

    def test_close_is_terminal(self):
        ent = _enterprise()
        ent.close("customer churn")
        assert ent.status == "closed"
        assert ent.archive_reason == "customer churn"

    def test_reactivate_from_suspended(self):
        ent = _enterprise()
        ent.suspend("temp")
        ent.reactivate()
        assert ent.status == "active"

    def test_reactivate_from_banned(self):
        ent = _enterprise()
        ent.ban("violation")
        ent.reactivate()
        assert ent.status == "active"

    def test_reactivate_from_closed_raises(self):
        ent = _enterprise()
        ent.close("done")
        with pytest.raises(ValueError, match="Cannot reactivate from closed"):
            ent.reactivate()

    def test_reactivate_from_active_raises(self):
        ent = _enterprise()
        with pytest.raises(ValueError, match="Cannot reactivate from active"):
            ent.reactivate()

    def test_suspend_from_closed_raises(self):
        ent = _enterprise()
        ent.close("done")
        with pytest.raises(ValueError, match="Cannot transition from closed"):
            ent.suspend("nope")

    def test_ban_from_closed_raises(self):
        ent = _enterprise()
        ent.close("done")
        with pytest.raises(ValueError, match="Cannot transition from closed"):
            ent.ban("nope")

    def test_close_from_any_state(self):
        # close is allowed from active, suspended, banned.
        for setup in (lambda e: None,
                      lambda e: e.suspend("x"),
                      lambda e: e.ban("x")):
            ent = _enterprise()
            setup(ent)
            ent.close("terminal")
            assert ent.status == "closed"

    def test_double_suspend_is_idempotent(self):
        ent = _enterprise()
        ent.suspend("first")
        ent.suspend("second")
        assert ent.status == "suspended"
        assert ent.archive_reason == "first"

    def test_double_ban_is_idempotent(self):
        ent = _enterprise()
        ent.ban("first")
        ent.ban("second")
        assert ent.status == "banned"
        assert ent.archive_reason == "first"

    def test_double_close_is_idempotent(self):
        ent = _enterprise()
        ent.close("first")
        ent.close("second")
        assert ent.status == "closed"
        assert ent.archive_reason == "first"


# ═══════════════════════════════════════════════════════════════════
# EnterpriseQuota
# ═══════════════════════════════════════════════════════════════════

class TestEnterpriseQuota:
    def test_defaults(self):
        q = EnterpriseQuota(enterprise_id="ent_001")
        assert q.employee_quota == 50
        assert q.storage_quota_mb == 1024
        assert q.api_rate_limit == 100
        assert q.token_quota == 0

    def test_employee_headroom(self):
        q = EnterpriseQuota(enterprise_id="ent_001", employee_quota=10)
        assert q.employee_headroom(3) == 7
        assert q.employee_headroom(10) == 0
        assert q.employee_headroom(15) == 0
