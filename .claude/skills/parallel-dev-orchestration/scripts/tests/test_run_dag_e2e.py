"""
端到端测试（manifest 驱动）：对 mock 和 multica（fake CLI）各跑一遍 start_new_run 完整链路。

断言：两层 DAG A->B 跑到全 done；manifest 节点回填 work_item_id、status=done；
幂等重跑已 done 且有 work_item_id 的节点 0 新建；blocked 重跑只重做该节点；reconcile 纠正状态。
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from core import load_manifest, set_node, save_manifest
from engines import create_engine_from_config, WorkItemStatus
from run_dag import start_new_run, reconcile


# ==================== mock 引擎 helper ====================

def _make_mock_engine(state_dir):
    env = {
        "ENGINE_TYPE": "mock",
        "MOCK_WORKSPACE_ID": "ws",
        "MOCK_AUTO_COMPLETE": "true",
        "MOCK_AUTO_COMPLETE_DELAY": "0",
        "POLLING_INTERVAL": "1",
    }
    engine = create_engine_from_config("mock", "ws", **env)
    engine.config.polling_interval = 0.001  # 近即时但避免 elapsed+=0 死循环
    engine._members["sq"] = ["alice", "bob", "carol"]
    return engine


# ==================== fake multica CLI ====================

_FAKE_MULTICA_SCRIPT = r'''#!/usr/bin/env python3
"""Fake multica CLI for testing. Simulates issue CRUD via a JSON store."""
import sys
import json
import os

STORE = os.environ.get("FAKE_MULTICA_STORE", "/tmp/fake_multica_store.json")

def _load():
    if os.path.exists(STORE):
        with open(STORE) as f:
            return json.load(f)
    return {"issues": {}, "agents": [{"id": "a1", "name": "alice"}, {"id": "a2", "name": "bob"}, {"id": "a3", "name": "carol"}], "squads": {"sq": ["alice", "bob", "carol"]}, "next_id": 1}

def _save(data):
    with open(STORE, "w") as f:
        json.dump(data, f)

def main():
    args = sys.argv[1:]
    # Strip --workspace-id and its value
    filtered = []
    i = 0
    while i < len(args):
        if args[i] == "--workspace-id":
            i += 2
            continue
        filtered.append(args[i])
        i += 1
    args = filtered

    data = _load()

    if args[:2] == ["issue", "create"]:
        title = desc = status = None
        j = 2
        while j < len(args):
            if args[j] == "--title": title = args[j+1]; j += 2
            elif args[j] == "--description": desc = args[j+1]; j += 2
            elif args[j] == "--status": status = args[j+1]; j += 2
            elif args[j] == "--output": j += 2
            else: j += 1
        issue_id = str(data["next_id"])
        data["next_id"] += 1
        issue = {"id": issue_id, "title": title, "description": desc or "", "status": status or "todo", "metadata": {}, "assignees": [], "comments": []}
        data["issues"][issue_id] = issue
        _save(data)
        print(json.dumps({"id": issue_id}))
        return

    if args[:2] == ["issue", "get"]:
        issue_id = args[2]
        issue = data["issues"].get(issue_id)
        if not issue:
            print(json.dumps({"error": "not found"}), file=sys.stderr)
            sys.exit(1)
        # Auto-complete: if assigned and in_progress, mark done
        if issue["status"] == "in_progress" and issue.get("assignees"):
            issue["status"] = "done"
            issue["metadata"]["artifacts"] = {"pr": f"https://fake/pr/{issue_id}"}
            _save(data)
        elif issue["status"] == "in_review" and issue.get("assignees"):
            issue["metadata"]["review_verdict"] = "pass"
            issue["metadata"]["review_comment"] = "LGTM"
            issue["status"] = "done"
            issue["metadata"]["artifacts"] = {"pr": f"https://fake/pr/{issue_id}"}
            _save(data)
        print(json.dumps(issue))
        return

    if args[:3] == ["issue", "metadata", "set"]:
        issue_id = args[3]
        key = val = None
        j = 4
        while j < len(args):
            if args[j] == "--key": key = args[j+1]; j += 2
            elif args[j] == "--value": val = args[j+1]; j += 2
            else: j += 1
        issue = data["issues"].get(issue_id)
        if issue:
            try:
                issue["metadata"][key] = json.loads(val) if val and val.startswith("[") or val.startswith("{") else val
            except:
                issue["metadata"][key] = val
            _save(data)
        return

    if args[:2] == ["issue", "update"]:
        issue_id = args[2]
        j = 3
        while j < len(args):
            if args[j] == "--status":
                issue = data["issues"].get(issue_id)
                if issue:
                    issue["status"] = args[j+1]
                    _save(data)
                j += 2
            else: j += 1
        return

    if args[:2] == ["issue", "list"]:
        issues = list(data["issues"].values())
        if "--status" in args:
            idx = args.index("--status")
            st = args[idx+1]
            issues = [i for i in issues if i["status"] == st]
        print(json.dumps(issues))
        return

    if args[:3] == ["issue", "comment", "add"]:
        issue_id = args[3]
        msg = None
        j = 4
        while j < len(args):
            if args[j] == "--content": msg = args[j+1]; j += 2
            else: j += 1
        issue = data["issues"].get(issue_id)
        if issue:
            issue["comments"].append(msg)
            _save(data)
        return

    if args[:2] == ["issue", "assign"]:
        issue_id = args[2]
        agent_id = None
        j = 3
        while j < len(args):
            if args[j] == "--to": agent_id = args[j+1]; j += 2
            else: j += 1
        issue = data["issues"].get(issue_id)
        if issue:
            issue["assignees"].append(agent_id)
            _save(data)
        return

    if args[:2] == ["agent", "list"]:
        print(json.dumps(data["agents"]))
        return

    if args[:3] == ["squad", "member", "list"]:
        squad_id = args[3]
        names = data["squads"].get(squad_id, [])
        print(json.dumps([{"name": n} for n in names]))
        return

    print(f"Unknown command: {args}", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    main()
'''


def _make_multica_engine(tmp_path):
    """Create a MulticaEngine with a fake multica CLI on PATH."""
    store_path = str(tmp_path / "multica_store.json")
    os.environ["FAKE_MULTICA_STORE"] = store_path
    # Reset store
    with open(store_path, "w") as f:
        json.dump({"issues": {}, "agents": [{"id": "a1", "name": "alice"}, {"id": "a2", "name": "bob"}, {"id": "a3", "name": "carol"}], "squads": {"sq": ["alice", "bob", "carol"]}, "next_id": 1}, f)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake_cli = bin_dir / "multica"
    fake_cli.write_text(_FAKE_MULTICA_SCRIPT)
    fake_cli.chmod(0o755)

    # Inject PATH
    old_path = os.environ.get("PATH", "")
    os.environ["PATH"] = f"{bin_dir}:{old_path}"

    engine = create_engine_from_config("multica", "ws")
    engine.config.squad_id = "sq"
    engine.config.polling_interval = 0.001
    return engine


# ==================== shared manifest ====================

def _write_manifest(path):
    yaml_text = (
        "meta:\n"
        "  name: e2e-test\n"
        "  squad: sq\n"
        "nodes:\n"
        "  - id: A\n"
        "    worker: alice\n"
        "    title: Task A\n"
        "    description: 'Build backend for A'\n"
        "  - id: B\n"
        "    worker: bob\n"
        "    title: Task B\n"
        "    description: 'Build frontend for B'\n"
        "    blocked_by: [A]\n"
    )
    with open(path, "w") as f:
        f.write(yaml_text)


# ==================== tests ====================

@pytest.mark.parametrize("engine_factory", ["mock", "multica"], ids=["mock", "multica"])
def test_e2e_full_dag_done(tmp_path, engine_factory, monkeypatch):
    """两层 DAG A->B 跑到全 done；manifest 回填 work_item_id + status=done。"""
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)

    if engine_factory == "mock":
        engine = _make_mock_engine(str(tmp_path))
    else:
        engine = _make_multica_engine(tmp_path)
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    start_new_run(manifest_path, engine=engine)

    m = load_manifest(manifest_path)
    assert m.nodes["A"].status == "done", f"A 应 done，实际 {m.nodes['A'].status}"
    assert m.nodes["B"].status == "done", f"B 应 done，实际 {m.nodes['B'].status}"
    assert m.nodes["A"].work_item_id is not None, "A 应回填 work_item_id"
    assert m.nodes["B"].work_item_id is not None, "B 应回填 work_item_id"
    assert m.nodes["A"].work_item_id != m.nodes["B"].work_item_id, "A/B work_item_id 不同"


@pytest.mark.parametrize("engine_factory", ["mock", "multica"], ids=["mock", "multica"])
def test_e2e_idempotent_rerun(tmp_path, engine_factory, monkeypatch):
    """重跑已 done 且有 work_item_id 的节点：0 新建、精准 get_work_item。"""
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)

    if engine_factory == "mock":
        engine = _make_mock_engine(str(tmp_path))
        import run_dag as rd
        monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)
    else:
        import run_dag as rd
        monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)
        engine = _make_multica_engine(tmp_path)

    # 第一遍
    start_new_run(manifest_path, engine=engine)
    m1 = load_manifest(manifest_path)
    a_id = m1.nodes["A"].work_item_id
    b_id = m1.nodes["B"].work_item_id

    # 记录平台 work item 数量
    if engine_factory == "mock":
        count_before = len(engine._work_items)
    else:
        store = json.load(open(os.environ["FAKE_MULTICA_STORE"]))
        count_before = len(store["issues"])

    # 第二遍重跑
    start_new_run(manifest_path, engine=engine)

    if engine_factory == "mock":
        count_after = len(engine._work_items)
    else:
        store = json.load(open(os.environ["FAKE_MULTICA_STORE"]))
        count_after = len(store["issues"])

    assert count_after == count_before, f"重跑不应新建 work item: before={count_before} after={count_after}"

    m2 = load_manifest(manifest_path)
    assert m2.nodes["A"].work_item_id == a_id, "A work_item_id 不变"
    assert m2.nodes["B"].work_item_id == b_id, "B work_item_id 不变"


@pytest.mark.parametrize("engine_factory", ["mock", "multica"], ids=["mock", "multica"])
def test_e2e_blocked_rerun_redoes_only_that(tmp_path, engine_factory, monkeypatch):
    """B 退回 blocked 重跑 -> 只重做 B，A 复用 done。"""
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)

    if engine_factory == "mock":
        engine = _make_mock_engine(str(tmp_path))
    else:
        engine = _make_multica_engine(tmp_path)
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    # 第一遍
    start_new_run(manifest_path, engine=engine)
    m1 = load_manifest(manifest_path)
    b_id = m1.nodes["B"].work_item_id
    assert m1.nodes["B"].status == "done"

    # 把 B 退回 blocked
    set_node(m1, "B", status="blocked")
    save_manifest(m1, manifest_path)

    # 平台侧也退回
    engine.update_status(b_id, WorkItemStatus.BLOCKED)

    # 第二遍
    start_new_run(manifest_path, engine=engine)

    m2 = load_manifest(manifest_path)
    assert m2.nodes["A"].status == "done", "A 保持 done"
    assert m2.nodes["B"].status == "done", f"重派后 B 应 done，实际 {m2.nodes['B'].status}"
    assert m2.nodes["B"].work_item_id == b_id, "B 复用原 work_item_id"


@pytest.mark.parametrize("engine_factory", ["mock", "multica"], ids=["mock", "multica"])
def test_e2e_reconcile_fixes_stale_status(tmp_path, engine_factory, monkeypatch):
    """reconcile：manifest 记 work_item_id 但 status 落后于平台（平台已 done）-> 补成 done。"""
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)

    if engine_factory == "mock":
        engine = _make_mock_engine(str(tmp_path))
    else:
        engine = _make_multica_engine(tmp_path)
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    # 第一遍跑到 done
    start_new_run(manifest_path, engine=engine)
    m1 = load_manifest(manifest_path)
    a_id = m1.nodes["A"].work_item_id
    assert m1.nodes["A"].status == "done"

    # 手改 manifest 让 status 落后
    set_node(m1, "A", status="todo")
    save_manifest(m1, manifest_path)

    # 只跑 reconcile，不跑 execute
    m2 = load_manifest(manifest_path)
    reconcile(engine, m2, manifest_path)

    m3 = load_manifest(manifest_path)
    assert m3.nodes["A"].status == "done", f"reconcile 应补成 done，实际 {m3.nodes['A'].status}"
    assert m3.nodes["A"].work_item_id == a_id, "work_item_id 不变"


@pytest.mark.parametrize("engine_factory", ["mock", "multica"], ids=["mock", "multica"])
def test_e2e_reconcile_clears_missing_work_item_id(tmp_path, engine_factory, monkeypatch):
    """reconcile：work_item_id 指向平台不存在的 item -> 清空待新建。"""
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)

    if engine_factory == "mock":
        engine = _make_mock_engine(str(tmp_path))
    else:
        engine = _make_multica_engine(tmp_path)
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    m = load_manifest(manifest_path)
    # 给 A 一个不存在的 work_item_id
    set_node(m, "A", work_item_id="99999", status="done")
    save_manifest(m, manifest_path)

    m2 = load_manifest(manifest_path)
    reconcile(engine, m2, manifest_path)

    m3 = load_manifest(manifest_path)
    assert m3.nodes["A"].work_item_id is None, "work_item_id 应被清空"
    assert m3.nodes["A"].status == "todo", "status 应被重置为 todo"


# ==================== 失败隔离 e2e ====================

def test_e2e_failure_isolation_terminates(tmp_path, monkeypatch):
    """A 失败 -> B 下游隔离标 blocked -> run 能终止（不 hang），digest 报告失败。

    之前 bug：downstream_of 算出的 blocked 节点不加入 failed，
    completed+failed>=total 永不成立 -> while True 死循环。
    """
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)  # A -> B

    engine = _make_mock_engine(str(tmp_path))
    engine.set_fail_keys({"A"})  # A 模拟失败
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    start_new_run(manifest_path, engine=engine)

    m = load_manifest(manifest_path)
    assert m.nodes["A"].status == "blocked", f"A 应 blocked，实际 {m.nodes['A'].status}"
    assert m.nodes["B"].status == "blocked", f"B 应 blocked（失败隔离），实际 {m.nodes['B'].status}"
    # 关键：run 正常终止了（没 hang），否则 timeout 会 fail）


def test_e2e_fix_upstream_rerun_downstream_recovers(tmp_path, monkeypatch):
    """A 失败 -> B blocked -> 修好 A 重跑 -> A done 且 B 恢复执行到 done。

    之前 bug：reset 循环只把 blocked/failed 重置为 todo，漏了因上游失败被标 blocked 的下游 ->
    上游修好后重跑，B 永远停在 blocked 不会重跑。
    """
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)  # A -> B

    engine = _make_mock_engine(str(tmp_path))
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    # 第一轮：A 失败 -> B blocked
    engine.set_fail_keys({"A"})
    start_new_run(manifest_path, engine=engine)

    m = load_manifest(manifest_path)
    assert m.nodes["A"].status == "blocked"
    assert m.nodes["B"].status == "blocked"

    # 修好 A：清掉 fail 注入
    engine.set_fail_keys(set())

    # 第二轮：重跑同一 manifest -> A 应 done，B 应从 blocked 恢复到 done
    start_new_run(manifest_path, engine=engine)

    m2 = load_manifest(manifest_path)
    assert m2.nodes["A"].status == "done", f"A 修好后应 done，实际 {m2.nodes['A'].status}"
    assert m2.nodes["B"].status == "done", f"B 应从 blocked 恢复到 done，实际 {m2.nodes['B'].status}"


# ==================== 接手在飞节点 e2e ====================

def test_e2e_harvest_inflight_node(tmp_path, monkeypatch):
    """接手在飞节点：manifest 记 A=in_progress（别的机器派的），reconcile 同步平台 done -> harvest 收割。

    之前 bug：reconcile 只同步 done 不同步 in_progress，接手方当 todo 重派 -> 双撞。
    且 execute_dag 没 harvest 分支，在飞节点变 done 后无人登记。
    """
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)  # A -> B

    engine = _make_mock_engine(str(tmp_path))
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    # 模拟别的机器已建 A 的 work item 并派发到 in_progress
    item_a = engine.create_work_item(
        workspace_id="sq",
        title="Task A",
        description="Build backend for A",
        dag_key="A",
        worker="alice",
    )
    engine.update_status(item_a.id, WorkItemStatus.IN_PROGRESS)

    # 写 manifest：A 有 work_item_id + status=in_progress（接手方拉到的状态）
    m = load_manifest(manifest_path)
    set_node(m, "A", work_item_id=item_a.id, status="in_progress")
    save_manifest(m, manifest_path)

    # 平台上把 A 标 done + 写 artifacts（模拟 worker 在 B 机器跑时完成了）
    engine.update_status(item_a.id, WorkItemStatus.DONE)
    engine.update_work_item_metadata(item_a.id, artifacts={"pr": "https://mock.example.com/pr/1"})

    # 现在跑 start_new_run：reconcile 应同步 A=done，harvest 无需做（已是 done），B 正常派发到 done
    start_new_run(manifest_path, engine=engine)

    m2 = load_manifest(manifest_path)
    assert m2.nodes["A"].status == "done", f"A 应 done（reconcile 同步），实际 {m2.nodes['A'].status}"
    assert m2.nodes["A"].work_item_id == item_a.id, "A work_item_id 不变"
    assert m2.nodes["B"].status == "done", f"B 应 done，实际 {m2.nodes['B'].status}"


def test_e2e_reconcile_syncs_in_progress(tmp_path, monkeypatch):
    """reconcile 全量同步：平台 in_progress -> manifest 补成 in_progress（不当 todo 重派）。"""
    manifest_path = str(tmp_path / "dag.yaml")
    _write_manifest(manifest_path)

    engine = _make_mock_engine(str(tmp_path))
    import run_dag as rd
    monkeypatch.setattr(rd, "commit_manifest", lambda *a, **k: False)

    # 平台上建 A 并标 in_progress
    item_a = engine.create_work_item(
        workspace_id="sq",
        title="Task A",
        description="Build backend for A",
        dag_key="A",
        worker="alice",
    )
    engine.update_status(item_a.id, WorkItemStatus.IN_PROGRESS)

    # manifest 记 A 有 work_item_id 但 status=todo（过时）
    m = load_manifest(manifest_path)
    set_node(m, "A", work_item_id=item_a.id, status="todo")
    save_manifest(m, manifest_path)

    # 只跑 reconcile
    m2 = load_manifest(manifest_path)
    reconcile(engine, m2, manifest_path)

    m3 = load_manifest(manifest_path)
    assert m3.nodes["A"].status == "in_progress", (
        f"reconcile 应同步平台 in_progress，实际 {m3.nodes['A'].status}"
    )
