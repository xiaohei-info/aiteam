"""L3-S04 Single Agent Run adapter — unit and integration tests.

Plan checklist items: T01 reject missing identity, T02 accept returns
runtime_handle, T03 dispatcher routes correctly.
"""

import pytest

from agent_gateway.adapters.single_agent import accept, validate_request
from agent_gateway.contracts import (
    GatewayAcceptResponse,
    RuntimeHandle,
    SingleAgentRunRequest,
)
from agent_gateway.runtime_dispatcher import dispatch


# ── Helpers ──────────────────────────────────────────────────────────────

def _valid_request(**overrides) -> SingleAgentRunRequest:
    defaults = dict(
        run_id="run_001",
        employee_id="emp_test",
        conversation_id="conv_test",
        message_text="Hello, agent!",
        enterprise_id="ent_test",
        idempotency_key="ik_001",
    )
    defaults.update(overrides)
    return SingleAgentRunRequest(**defaults)


# ── T01: reject missing business identity ───────────────────────────────

class TestRejectMissingIdentity:
    def test_reject_missing_employee_id(self):
        req = _valid_request(employee_id="")
        with pytest.raises(ValueError, match="employee_id"):
            validate_request(req)

    def test_reject_whitespace_employee_id(self):
        req = _valid_request(employee_id="   ")
        with pytest.raises(ValueError, match="employee_id"):
            validate_request(req)

    def test_reject_missing_conversation_id(self):
        req = _valid_request(conversation_id="")
        with pytest.raises(ValueError, match="conversation_id"):
            validate_request(req)

    def test_reject_missing_message_text(self):
        req = _valid_request(message_text="")
        with pytest.raises(ValueError, match="message_text"):
            validate_request(req)

    def test_reject_whitespace_message_text(self):
        req = _valid_request(message_text="   ")
        with pytest.raises(ValueError, match="message_text"):
            validate_request(req)

    def test_valid_request_passes_validation(self):
        validate_request(_valid_request())


# ── T02: accept returns runtime_handle ───────────────────────────────────

class TestAcceptReturnsRuntimeHandle:
    def test_accept_returns_gateway_accept_response(self, uow, seeded_enterprise):
        req = _valid_request()
        with uow:
            resp = accept(uow, req)
        assert isinstance(resp, GatewayAcceptResponse)
        assert resp.run_id == req.run_id
        assert resp.status == "queued"
        assert isinstance(resp.runtime_handle, RuntimeHandle)

    def test_accept_persists_runtime_binding(self, uow, seeded_enterprise):
        req = _valid_request()
        with uow:
            resp = accept(uow, req)
            assert isinstance(resp, GatewayAcceptResponse)
            # Verify binding was persisted inside the same transaction
            binding = uow.runtime_bindings().get_by_owner("team_run", req.run_id)
            assert binding is not None
            assert binding.owner_id == req.run_id
            assert binding.runtime_kind == "session"
            assert binding.profile_name == req.employee_id

    def test_accept_generates_session_id(self, uow, seeded_enterprise):
        req = _valid_request()
        with uow:
            resp = accept(uow, req)
        assert resp.runtime_handle.session_id is not None
        assert resp.runtime_handle.session_id.startswith("sess_")

    def test_accept_uses_explicit_profile_name(self, uow, seeded_enterprise):
        req = _valid_request(profile_name="custom-profile")
        with uow:
            resp = accept(uow, req)
            assert resp.runtime_handle.profile_name == "custom-profile"
            binding = uow.runtime_bindings().get_by_owner("team_run", req.run_id)
            assert binding.profile_name == "custom-profile"

    def test_accept_defaults_profile_name_to_employee_id(self, uow, seeded_enterprise):
        req = _valid_request(profile_name="")
        with uow:
            resp = accept(uow, req)
        assert resp.runtime_handle.profile_name == req.employee_id

    def test_accept_returns_stream_and_events_urls(self, uow, seeded_enterprise):
        req = _valid_request()
        with uow:
            resp = accept(uow, req)
        assert resp.stream_url == f"/api/team/runs/{req.run_id}/stream?cursor=0"
        assert resp.events_url == f"/api/team/runs/{req.run_id}/events?cursor=0"


# ── T03: dispatcher routing ─────────────────────────────────────────────

class TestDispatcherRouting:
    def test_dispatcher_routes_single_agent(self, uow, seeded_enterprise):
        req = _valid_request()
        with uow:
            resp = dispatch(uow, req)
        assert isinstance(resp, GatewayAcceptResponse)
        assert resp.run_id == req.run_id

    def test_dispatcher_rejects_unsupported_type(self, uow, seeded_enterprise):
        class BogusRequest:
            pass

        with uow, pytest.raises(NotImplementedError, match="BogusRequest"):
            dispatch(uow, BogusRequest())
