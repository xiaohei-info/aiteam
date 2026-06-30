"""ConnectorOpsService branch and regression tests."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from manager_service.connector_ops_service import ConnectorOpsService

from ._fake_router import ctx


@dataclass
class _StatusRow:
    connector_id: str
    status: str
    last_check_at: datetime | None = None
    error_message: str | None = None


@dataclass
class _GrantsRow:
    connector_id: str
    employee_ids: list[str]


class _Repo:
    def __init__(self, grants: _GrantsRow | None = None, status: _StatusRow | None = None):
        self.grants = grants
        self.status = status
        self.saved_employee_ids: list[str] | None = None
        self.test_created = False
        self.last_test_success: bool | None = None
        self.last_status: str | None = None
        self.last_error: str | None = None

    def get_status(self, _ctx, _connector_id):
        return self.status

    def create_test(self, _ctx, _connector_id, *, success, latency_ms, message):
        self.test_created = True
        self.last_test_success = success

    def upsert_status(self, _ctx, _connector_id, *, status, error_message):
        self.status_upserted_set = True
        self.last_status = status
        self.last_error = error_message

    def get_grants(self, _ctx, _connector_id):
        return self.grants

    def set_grants(self, _ctx, connector_id, employee_ids):
        self.saved_employee_ids = employee_ids
        return _GrantsRow(connector_id, employee_ids)


def test_get_status_defaults_to_disconnected_when_missing():
    result = ConnectorOpsService(_Repo()).get_status(ctx(), "slack")

    assert result["status"] == "disconnected"
    assert result["connector_id"] == "slack"


def test_test_connector_valid_records_success_and_connected_status():
    repo = _Repo()
    result = ConnectorOpsService(repo).test_connector(
        ctx(), "feishu", auth_scheme="oauth2",
        config_schema_json='{"properties":{"app_id":{"type":"string"}}}',
    )

    assert result["success"] is True
    assert result["auth_scheme"] == "oauth2"
    assert result["flow"] == "authorization_code"
    assert repo.test_created is True
    assert repo.last_test_success is True
    assert repo.last_status == "connected"
    assert repo.last_error is None


def test_test_connector_invalid_connector_id_records_error():
    repo = _Repo()
    result = ConnectorOpsService(repo).test_connector(ctx(), "___bad", auth_scheme="oauth2")

    assert result["success"] is False
    assert result["auth_scheme"] is None
    assert repo.test_created is True
    assert repo.last_test_success is False
    assert repo.last_status == "error"
    assert repo.last_error and "connector_id" in repo.last_error


def test_test_connector_unsupported_auth_scheme_records_error():
    repo = _Repo()
    result = ConnectorOpsService(repo).test_connector(ctx(), "acme", auth_scheme="ftp")

    assert result["success"] is False
    assert repo.last_status == "error"
    assert repo.last_error and "auth_scheme" in repo.last_error


def test_test_connector_bad_config_schema_records_error():
    repo = _Repo()
    result = ConnectorOpsService(repo).test_connector(ctx(), "acme", auth_scheme="api_key",
                                                 config_schema_json="not-json")

    assert result["success"] is False
    assert repo.last_status == "error"
    assert repo.last_error and "JSON" in repo.last_error


def test_test_connector_missing_auth_scheme_records_error():
    """'slack' valid id but no auth_scheme/config — issue #296: must NOT pass as stub."""
    repo = _Repo()
    result = ConnectorOpsService(repo).test_connector(ctx(), "slack")

    assert result["success"] is False
    assert repo.last_status == "error"


def test_set_grants_merges_with_existing_grants():
    repo = _Repo(grants=_GrantsRow("slack", ["emp-a", "emp-b"]))

    result = ConnectorOpsService(repo).set_grants(ctx(), "slack", ["emp-b", "emp-c"], "grant")

    assert set(result["employee_ids"]) == {"emp-a", "emp-b", "emp-c"}
    assert set(repo.saved_employee_ids or []) == {"emp-a", "emp-b", "emp-c"}


def test_revoke_removes_only_requested_employee_ids():
    repo = _Repo(grants=_GrantsRow("slack", ["emp-a", "emp-b", "emp-c"]))

    result = ConnectorOpsService(repo).set_grants(ctx(), "slack", ["emp-b"], "revoke")

    assert set(result["employee_ids"]) == {"emp-a", "emp-c"}
    assert set(repo.saved_employee_ids or []) == {"emp-a", "emp-c"}


def test_revoke_without_existing_grants_saves_empty_list():
    repo = _Repo()

    result = ConnectorOpsService(repo).set_grants(ctx(), "slack", ["emp-b"], "revoke")

    assert result["employee_ids"] == []
    assert repo.saved_employee_ids == []
