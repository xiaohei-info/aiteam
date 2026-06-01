"""Focused tests for L2-S01 policy services: permission, idempotency, route_decision.

T01-T03: Permission matrix tests
T05:     Idempotency replay
T07-T08: Route decision output schema + routing behaviour
"""

from unittest.mock import MagicMock

import pytest

from team_panel.domain.enums import EnterpriseRole, SystemRole
from team_panel.domain.value_objects import RouteDecision
from team_panel.application.policies.permission_service import check_permission
from team_panel.application.policies.idempotency_service import check_or_create
from team_panel.application.policies.route_decision_service import decide_route


# ═══════════════════════════════════════════════════════════════════
# T01: owner can manage_enterprise
# ═══════════════════════════════════════════════════════════════════

class TestPermissionOwner:
    def test_owner_can_manage_enterprise(self):
        allowed, reason = check_permission(EnterpriseRole.OWNER, "manage_enterprise")
        assert allowed is True
        assert reason == ""

    def test_owner_can_manage_employees(self):
        allowed, _ = check_permission(EnterpriseRole.OWNER, "manage_employees")
        assert allowed is True

    def test_owner_can_view_billing(self):
        allowed, _ = check_permission(EnterpriseRole.OWNER, "view_billing")
        assert allowed is True

    def test_owner_can_manage_connectors(self):
        allowed, _ = check_permission(EnterpriseRole.OWNER, "manage_connectors")
        assert allowed is True

    def test_owner_can_view_all_conversations(self):
        allowed, _ = check_permission(EnterpriseRole.OWNER, "view_all_conversations")
        assert allowed is True

    def test_owner_cannot_do_system_actions(self):
        allowed, reason = check_permission(EnterpriseRole.OWNER, "system_read")
        assert allowed is False
        assert "lacks permission" in reason


# ═══════════════════════════════════════════════════════════════════
# T02: member cannot manage_employees
# ═══════════════════════════════════════════════════════════════════

class TestPermissionMember:
    def test_member_cannot_manage_employees(self):
        allowed, reason = check_permission(EnterpriseRole.MEMBER, "manage_employees")
        assert allowed is False
        assert "lacks permission" in reason

    def test_member_can_view_own_conversations(self):
        allowed, _ = check_permission(EnterpriseRole.MEMBER, "view_own_conversations")
        assert allowed is True

    def test_member_can_send_message(self):
        allowed, _ = check_permission(EnterpriseRole.MEMBER, "send_message")
        assert allowed is True

    def test_member_cannot_manage_enterprise(self):
        allowed, _ = check_permission(EnterpriseRole.MEMBER, "manage_enterprise")
        assert allowed is False

    def test_member_cannot_view_billing(self):
        allowed, _ = check_permission(EnterpriseRole.MEMBER, "view_billing")
        assert allowed is False


# ═══════════════════════════════════════════════════════════════════
# T03: system_admin cannot access enterprise data
# ═══════════════════════════════════════════════════════════════════

class TestPermissionSystemAdmin:
    def test_system_admin_can_system_read(self):
        allowed, _ = check_permission(SystemRole.SYSTEM_ADMIN, "system_read")
        assert allowed is True

    def test_system_admin_can_system_write(self):
        allowed, _ = check_permission(SystemRole.SYSTEM_ADMIN, "system_write")
        assert allowed is True

    def test_system_admin_cannot_access_enterprise_data(self):
        enterprise_actions = [
            "manage_enterprise",
            "manage_employees",
            "view_billing",
            "manage_connectors",
            "view_all_conversations",
            "view_own_conversations",
            "send_message",
        ]
        for action in enterprise_actions:
            allowed, reason = check_permission(SystemRole.SYSTEM_ADMIN, action)
            assert allowed is False, f"system_admin should not have '{action}'"
            assert "lacks permission" in reason

    def test_system_operator_read_only(self):
        allowed, _ = check_permission(SystemRole.SYSTEM_OPERATOR, "system_read")
        assert allowed is True
        allowed, _ = check_permission(SystemRole.SYSTEM_OPERATOR, "system_write")
        assert allowed is False


# ═══════════════════════════════════════════════════════════════════
# T05: idempotency key replay returns same run_id
# ═══════════════════════════════════════════════════════════════════

class TestIdempotency:
    def test_idempotency_key_replay_returns_same_run_id(self):
        from team_panel.domain.entities import TeamRun

        repo = MagicMock()
        existing_run = TeamRun(
            id="existing-run-001",
            enterprise_id="ent-1",
            conversation_id="conv-1",
            idempotency_key="key-abc-123",
        )
        repo.get_by_idempotency_key.return_value = existing_run

        result = check_or_create(
            run_repo=repo,
            idempotency_key="key-abc-123",
            run_id="new-run-002",
            conversation_id="conv-1",
            employee_id="emp-1",
        )
        assert result == "existing-run-001"
        repo.get_by_idempotency_key.assert_called_once_with("key-abc-123")

    def test_new_key_returns_supplied_run_id(self):
        repo = MagicMock()
        repo.get_by_idempotency_key.return_value = None

        result = check_or_create(
            run_repo=repo,
            idempotency_key="key-new-456",
            run_id="new-run-003",
            conversation_id="conv-2",
            employee_id="emp-2",
        )
        assert result == "new-run-003"

    def test_empty_key_raises_value_error(self):
        repo = MagicMock()
        with pytest.raises(ValueError, match="idempotency_key is required"):
            check_or_create(
                run_repo=repo,
                idempotency_key="",
                run_id="r1",
                conversation_id="c1",
                employee_id=None,
            )

    def test_none_key_raises_value_error(self):
        repo = MagicMock()
        with pytest.raises(ValueError, match="idempotency_key is required"):
            check_or_create(
                run_repo=repo,
                idempotency_key=None,
                run_id="r1",
                conversation_id="c1",
                employee_id=None,
            )


# ═══════════════════════════════════════════════════════════════════
# T07: route_decision output schema matches RouteDecision value object
# ═══════════════════════════════════════════════════════════════════

class TestRouteDecisionOutputSchema:
    def test_route_decision_output_schema_single_agent(self):
        result = decide_route("hello world", ["emp-1", "emp-2"], route_hint="single_agent")
        assert isinstance(result, RouteDecision)
        assert result.route_mode == "single_agent"
        assert result.target_employee_ids == ()
        assert result.planner_employee_id == ""

    def test_route_decision_output_schema_orchestration(self):
        result = decide_route("hello world", ["emp-1", "emp-2"], route_hint="orchestration")
        assert isinstance(result, RouteDecision)
        assert result.route_mode == "orchestration"
        assert result.target_employee_ids == ("emp-1", "emp-2")
        assert result.planner_employee_id == ""

    def test_route_decision_output_schema_auto_no_mentions(self):
        result = decide_route("hello world", ["emp-1", "emp-2"], route_hint="auto")
        assert isinstance(result, RouteDecision)
        assert result.route_mode == "single_agent"

    def test_route_decision_output_schema_auto_with_mentions(self):
        result = decide_route("@emp-1 @emp-2 please help", ["emp-1", "emp-2"], route_hint="auto")
        assert isinstance(result, RouteDecision)
        assert result.route_mode == "orchestration"
        assert result.target_employee_ids == ("emp-1", "emp-2")

    def test_route_decision_output_schema_auto_single_mention(self):
        """A single @mention still returns single_agent (needs >1 for orchestration)."""
        result = decide_route("@emp-1 help me", ["emp-1", "emp-2"], route_hint="auto")
        assert isinstance(result, RouteDecision)
        assert result.route_mode == "single_agent"
        assert result.target_employee_ids == ()

    def test_route_decision_output_schema_auto_no_match(self):
        """When message mentions IDs that are not in available_employee_ids."""
        result = decide_route("@ghost help", ["emp-1", "emp-2"], route_hint="auto")
        assert isinstance(result, RouteDecision)
        assert result.route_mode == "single_agent"

    def test_route_decision_returns_frozen_dataclass(self):
        result = decide_route("hello", ["emp-1"], route_hint="single_agent")
        with pytest.raises(Exception):
            result.route_mode = "orchestration"  # frozen dataclass


# ═══════════════════════════════════════════════════════════════════
# Additional cross-cutting tests for permission service
# ═══════════════════════════════════════════════════════════════════

class TestPermissionEdgeCases:
    def test_empty_role_returns_false(self):
        allowed, reason = check_permission("", "any_action")
        assert allowed is False
        assert "required" in reason

    def test_empty_action_returns_false(self):
        allowed, reason = check_permission(EnterpriseRole.OWNER, "")
        assert allowed is False
        assert "required" in reason

    def test_unknown_role_returns_false(self):
        allowed, reason = check_permission("non_existent_role", "any_action")
        assert allowed is False
        assert "unknown" in reason

    def test_enterprise_admin_cannot_manage_enterprise(self):
        allowed, _ = check_permission(EnterpriseRole.ENTERPRISE_ADMIN, "manage_enterprise")
        assert allowed is False

    def test_enterprise_admin_can_manage_employees(self):
        allowed, _ = check_permission(EnterpriseRole.ENTERPRISE_ADMIN, "manage_employees")
        assert allowed is True

    def test_finance_admin_can_view_billing(self):
        allowed, _ = check_permission(EnterpriseRole.FINANCE_ADMIN, "view_billing")
        assert allowed is True

    def test_finance_admin_can_export_data(self):
        allowed, _ = check_permission(EnterpriseRole.FINANCE_ADMIN, "export_data")
        assert allowed is True

    def test_finance_admin_cannot_manage_employees(self):
        allowed, _ = check_permission(EnterpriseRole.FINANCE_ADMIN, "manage_employees")
        assert allowed is False


# ═══════════════════════════════════════════════════════════════════
# Route decision string-based tests (accepting raw string as role_hint)
# ═══════════════════════════════════════════════════════════════════

class TestRouteDecisionDefault:
    def test_default_hint_is_auto(self):
        result = decide_route("hello world", ["emp-1", "emp-2"])
        assert result.route_mode == "single_agent"

    def test_auto_with_three_mentions(self):
        ids = ["emp-a", "emp-b", "emp-c"]
        result = decide_route("@emp-a @emp-b @emp-c urgent", ids)
        assert result.route_mode == "orchestration"
        assert set(result.target_employee_ids) == {"emp-a", "emp-b", "emp-c"}

    def test_mention_is_substring_match(self):
        """V1: mentions are detected by simple substring match."""
        ids = ["sales_bot"]
        # "bot" is not an exact ID, but sales_bot contains "bot" as substring — and
        # _extract_mentions checks if the ID appears in the text, not the other way.
        result = decide_route("ask @sales_bot to handle this", ids)
        assert result.route_mode == "single_agent"  # only 1 mention
