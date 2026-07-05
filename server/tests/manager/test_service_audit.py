"""AuditService list/create round-trip."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

from manager_service.audit_service import AuditService


def _row(**kw):
    base = dict(
        event_id="e-1", event_type="enterprise.created",
        actor_id="u-1", target_type="enterprise", target_id="t-1",
        detail={}, created_at=datetime.utcnow(),
    )
    base.update(kw)
    return base


def test_list_events_roundtrips_row():
    repo = MagicMock()
    repo.list_events.return_value = [_row(), _row(event_id="e-2", event_type="employee.invited")]
    svc = AuditService(repo)
    out = svc.list_events(MagicMock(), event_type="enterprise.created")
    assert len(out) == 2
    assert out[0]["event_id"] == "e-1"
    assert out[0]["event_type"] == "enterprise.created"
    assert out[0]["detail"] == {}


def test_create_event_returns_mapped_dict():
    repo = MagicMock()
    repo.create_event.return_value = _row(event_type="employee.invited")
    svc = AuditService(repo)
    out = svc.create_event(MagicMock(), event_type="employee.invited", actor_id="u-2")
    repo.create_event.assert_called_once()
    assert out["event_id"] == "e-1"
    assert out["event_type"] == "employee.invited"
