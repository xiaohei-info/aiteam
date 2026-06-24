# tests/test_reassign.py
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from core import Manifest
from core.manifest import Node
from engines.models import EngineConfig, WorkItemStatus
from engines.mock import MockEngine
import run_dag


def _mk_engine(tmp_path, failing_workers="", failure_reason="quota exhausted",
               max_consecutive_failures=3):
    config = EngineConfig(
        engine_type="mock",
        workspace_id="ws-test",
        polling_interval=0,                # 不睡，加速测试
        max_consecutive_failures=max_consecutive_failures,
        extra={
            "MOCK_AUTO_COMPLETE": "true",
            "MOCK_AUTO_COMPLETE_DELAY": "0",  # 立即完成/失败
            "MOCK_STATE_DIR": str(tmp_path),
            "MOCK_FAILING_WORKERS": failing_workers,
            "MOCK_FAILURE_REASON": failure_reason,
        },
    )
    return MockEngine(config)


def _run(engine, manifest):
    run = engine.create_run("ws-test", manifest)
    checkpoint = engine._load_checkpoint(run.id)
    key_to_id = checkpoint["key_to_id"]
    run_dag.execute_dag(engine, run, manifest, key_to_id)
    return run


def _events(engine, run_id):
    path = Path(engine._state_dir) / run_id / "events.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_quota_failure_suspends_node_without_isolating_downstream(tmp_path):
    # A(alice, 配额耗尽) → B(bob)；C(charlie) 独立分支
    manifest = Manifest(meta={"squad": "sq"}, nodes={
        "A": Node(id="A", worker="alice"),
        "B": Node(id="B", worker="bob", blocked_by=["A"]),
        "C": Node(id="C", worker="charlie"),
    })
    engine = _mk_engine(tmp_path, failing_workers="alice")
    run = _run(engine, manifest)

    events = _events(engine, run.id)
    reassign_events = [e for e in events if e["type"] == "node_needs_reassign"]

    # A 进入待改派，事件已写，原因含配额关键词
    assert any(e["node_key"] == "A" and e["worker"] == "alice" for e in reassign_events)
    assert any("quota" in (e.get("reason") or "").lower() for e in reassign_events)

    # 独立分支 C 照常完成；B 因上游 A 卡住未完成，但不是被隔离为 failed
    completed = {e["node_key"] for e in events if e["type"] == "node_completed"}
    assert "C" in completed
    assert "B" not in completed


def test_consecutive_failures_trigger_reassign_without_quota_keyword(tmp_path):
    # 失败原因不含关键词，靠连续失败计数兜底；阈值设 1 → 一次失败即待改派
    manifest = Manifest(meta={"squad": "sq"}, nodes={
        "X": Node(id="X", worker="alice"),
    })
    engine = _mk_engine(tmp_path, failing_workers="alice",
                        failure_reason="some transient glitch",
                        max_consecutive_failures=1)
    run = _run(engine, manifest)

    events = _events(engine, run.id)
    assert any(e["type"] == "node_needs_reassign" and e["node_key"] == "X"
               for e in events)


def test_clean_dag_all_done(tmp_path):
    # 无故障：全部完成，无待改派
    manifest = Manifest(meta={"squad": "sq"}, nodes={
        "A": Node(id="A", worker="alice"),
        "B": Node(id="B", worker="bob", blocked_by=["A"]),
    })
    engine = _mk_engine(tmp_path)
    run = _run(engine, manifest)

    events = _events(engine, run.id)
    completed = {e["node_key"] for e in events if e["type"] == "node_completed"}
    assert completed == {"A", "B"}
    assert not [e for e in events if e["type"] == "node_needs_reassign"]
