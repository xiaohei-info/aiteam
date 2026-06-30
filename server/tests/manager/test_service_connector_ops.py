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
        self.status_upserted = False

    def get_status(self, _ctx, _connector_id):
        return self.status

    def create_test(self, *_args, **_kwargs):
        self.test_created = True

    def upsert_status(self, *_args, **_kwargs):
        self.status_upserted = True

    def get_grants(self, _ctx, _connector_id):
        return self.grants

    def set_grants(self, _ctx, connector_id, employee_ids):
        self.saved_employee_ids = employee_ids
        return _GrantsRow(connector_id, employee_ids)


def test_get_status_defaults_to_disconnected_when_missing():
    result = ConnectorOpsService(_Repo()).get_status(ctx(), "slack")

    assert result["status"] == "disconnected"
    assert result["connector_id"] == "slack"


def test_test_connector_records_status_and_test_result():
    repo = _Repo()

    result = ConnectorOpsService(repo).test_connector(ctx(), "slack")

    assert result["success"] is True
    assert repo.test_created is True
    assert repo.status_upserted is True


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
