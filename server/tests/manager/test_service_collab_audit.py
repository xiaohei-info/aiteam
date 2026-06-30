"""CollabAuditService orchestration-field round-trip (issue #295)."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

from manager_service.collab_audit_repository import CollabTemplateRow
from manager_service.collab_audit_service import CollabAuditService


def _row(**kw):
    base = dict(
        template_id="t-1", name="默认协作模板",
        routing_prompt="", handoff_prompt="", max_replies_per_message=3,
        planner_prompt="p", subtask_prompt="s", aggregate_prompt="a",
        is_default=True, updated_at=datetime.utcnow(),
    )
    base.update(kw)
    return CollabTemplateRow(**base)


def test_get_template_roundtrips_orchestration_fields():
    repo = MagicMock()
    repo.get_template.return_value = _row()
    svc = CollabAuditService(repo)
    out = svc.get_template(MagicMock())
    assert out["planner_prompt"] == "p"
    assert out["subtask_prompt"] == "s"
    assert out["aggregate_prompt"] == "a"
    assert out["is_default"] is True


def test_put_template_roundtrips_orchestration_fields():
    repo = MagicMock()
    repo.upsert_template.return_value = _row(planner_prompt="new-p")
    svc = CollabAuditService(repo)
    out = svc.put_template(MagicMock(), planner_prompt="new-p", subtask_prompt="s2",
                           aggregate_prompt="a2", is_default=False)
    # All four orchestration fields should be forwarded to the repo.
    repo.upsert_template.assert_called_once()
    kwargs = repo.upsert_template.call_args.kwargs
    assert kwargs["planner_prompt"] == "new-p"
    assert kwargs["subtask_prompt"] == "s2"
    assert kwargs["aggregate_prompt"] == "a2"
    assert kwargs["is_default"] is False
    assert out["planner_prompt"] == "new-p"


def test_get_template_creates_default_when_missing():
    repo = MagicMock()
    repo.get_template.return_value = None
    repo.upsert_template.return_value = _row()
    svc = CollabAuditService(repo)
    out = svc.get_template(MagicMock())
    repo.upsert_template.assert_called_once()
    assert out["template_id"] == "t-1"
