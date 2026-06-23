# tests/test_engine.py
from client import FakeMulticaClient
from engine import run_dag

def base(issues):
    return FakeMulticaClient(issues={k: dict(key=k, id=k, status=s, blocked_by=b,
        worker="w", reviewer=None, review_verdict=None) for k, (s, b) in issues.items()})

def test_linear_dag_runs_to_done():
    c = base({"M0": ("todo", []), "M1": ("todo", ["M0"])})
    res = run_dag(c, dispatch_worker=lambda k: "ok", run_gate=lambda k: "approve", max_parallel=4)
    assert set(res["done"]) == {"M0", "M1"} and res["failed"] == []
    assert c.list_issues()["M1"]["status"] == "done"

def test_worker_failure_isolates_downstream():
    c = base({"A": ("todo", []), "B": ("todo", ["A"]), "D": ("todo", [])})
    res = run_dag(c, dispatch_worker=lambda k: "fail" if k == "A" else "ok",
                  run_gate=lambda k: "approve", max_parallel=4)
    assert "A" in res["failed"]
    assert "B" not in res["done"]            # 下游被隔离，未跑
    assert "D" in res["done"]                # 健康分支照常完成

def test_gate_changes_then_no_progress_reported_failed():
    c = base({"M0": ("todo", [])})
    res = run_dag(c, dispatch_worker=lambda k: "ok",
                  run_gate=lambda k: "changes", max_parallel=1)
    assert "M0" in res["failed"] and res["done"] == []   # 评审打回且本轮未过 → 计入失败集交 orchestrator

def test_resume_skips_already_done():
    c = base({"M0": ("done", []), "M1": ("todo", ["M0"])})
    calls = []
    run_dag(c, dispatch_worker=lambda k: calls.append(k) or "ok",
            run_gate=lambda k: "approve", max_parallel=4)
    assert calls == ["M1"]                   # M0 已 done，不重派
