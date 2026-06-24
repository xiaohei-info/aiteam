# tests/test_compile.py
from manifest import Manifest, Node
from client import FakeMulticaClient
from compile import compile_manifest

def test_compile_writes_blocked_by_and_worker():
    m = Manifest(meta={}, nodes={
        "M0": Node("M0", "agent-be"),
        "M1": Node("M1", "agent-fe", ["M0"], reviewer="agent-rev", risk="high"),
    })
    c = FakeMulticaClient(issues={
        "M0": {"key": "M0", "id": "M0", "status": "todo", "blocked_by": [], "worker": None,
               "reviewer": None, "review_verdict": None},
        "M1": {"key": "M1", "id": "M1", "status": "todo", "blocked_by": [], "worker": None,
               "reviewer": None, "review_verdict": None},
    })
    compile_manifest(m, c)
    got = c.list_issues()
    assert got["M1"]["blocked_by"] == ["M0"]
    assert got["M1"]["worker"] == "agent-fe"
    assert got["M1"]["reviewer"] == "agent-rev"
    assert got["M1"]["risk"] == "high"
    assert got["M0"]["blocked_by"] == []     # 空依赖也显式写
