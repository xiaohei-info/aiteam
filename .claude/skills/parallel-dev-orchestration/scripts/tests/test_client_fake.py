# tests/test_client_fake.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from clients.multica import FakeMulticaClient

def test_fake_assign_then_status_and_list():
    c = FakeMulticaClient(issues={
        "M0": {"key": "M0", "id": "M0", "status": "todo", "blocked_by": [],
               "worker": None, "reviewer": None, "review_verdict": None},
    })
    c.assign("M0", "agent-be")
    c.set_status("M0", "in_progress")
    got = c.list_issues()
    assert got["M0"]["status"] == "in_progress"
    assert got["M0"]["assignee"] == "agent-be"

def test_fake_set_metadata_roundtrip():
    c = FakeMulticaClient(issues={"M1": {"key": "M1", "id": "M1", "status": "todo",
        "blocked_by": [], "worker": None, "reviewer": None, "review_verdict": None}})
    c.set_metadata("M1", "blocked_by", ["M0"])
    c.set_metadata("M1", "worker", "agent-fe")
    got = c.list_issues()["M1"]
    assert got["blocked_by"] == ["M0"] and got["worker"] == "agent-fe"
