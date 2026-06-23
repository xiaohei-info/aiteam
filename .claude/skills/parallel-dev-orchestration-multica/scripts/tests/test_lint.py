# tests/test_lint.py
from manifest import Manifest, Node
from lint import lint

POOL = {"agent-be", "agent-fe", "agent-rev"}

def mk(nodes):  # nodes: list[Node]
    return Manifest(meta={}, nodes={n.id: n for n in nodes})

def test_clean_manifest_no_errors():
    m = mk([Node("M0", "agent-be"), Node("M1", "agent-fe", ["M0"], reviewer="agent-rev")])
    assert lint(m, POOL) == []

def test_worker_not_in_pool():
    m = mk([Node("M0", "ghost")])
    errs = lint(m, POOL)
    assert any("ghost" in e and "pool" in e for e in errs)

def test_blocked_by_unknown_node():
    m = mk([Node("M0", "agent-be", ["NOPE"])])
    assert any("NOPE" in e for e in lint(m, POOL))

def test_cycle_detected():
    m = mk([Node("A", "agent-be", ["B"]), Node("B", "agent-fe", ["A"])])
    assert any("cycle" in e.lower() for e in lint(m, POOL))

def test_reviewer_equals_worker():
    m = mk([Node("M0", "agent-be", reviewer="agent-be")])
    assert any("reviewer" in e and "worker" in e for e in lint(m, POOL))
