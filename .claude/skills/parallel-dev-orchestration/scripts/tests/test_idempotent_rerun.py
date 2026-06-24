# tests/test_idempotent_rerun.py
"""
幂等重跑测试：同一个 manifest 用 mock 引擎跑两遍 start_new_run，
第二遍应当复用第一遍已 DONE 的节点（不重派、不新建 work item）。

这个测试覆盖 execute_dag + create_run + start_new_run 完整链路，
专门捕捉『重跑会全量重做已完成节点』这类缺陷。
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import tempfile

from engines import create_engine_from_config, WorkItemStatus, RunStatus
from run_dag import start_new_run


def _write_manifest(path, members):
    """写一个两层 DAG：A → B(C 依赖 A)"""
    yaml_text = (
        "meta:\n"
        "  name: idempotent-test\n"
        "  squad: sq\n"
        "nodes:\n"
        f"  - id: A\n"
        f"    worker: {members[0]}\n"
        f"    title: A\n"
        f"    description: task A\n"
        f"  - id: B\n"
        f"    worker: {members[1]}\n"
        f"    title: B\n"
        f"    description: task B\n"
        f"    blocked_by: [A]\n"
    )
    with open(path, "w") as f:
        f.write(yaml_text)


def _capture_new_work_item_ids(engine):
    """记录引擎当前已存在的 work_item id 集合"""
    return {it.id for it in engine._work_items.values()}


def test_rerun_reuses_done_nodes():
    """第二遍重跑：A/B 已 DONE → 0 个新建、completed 一致、不重派"""
    with tempfile.TemporaryDirectory() as state_dir:
        env = {
            "ENGINE_TYPE": "mock",
            "MOCK_WORKSPACE_ID": "ws",
            "MOCK_STATE_DIR": state_dir,
            "MOCK_AUTO_COMPLETE": "true",
            "MOCK_AUTO_COMPLETE_DELAY": "0",
            "POLLING_INTERVAL": "1",
        }
        engine = create_engine_from_config("mock", "ws", **env)
        # create_engine_from_config 不解析 POLLING_INTERVAL（只有 from_env 解析），
        # 这里直接设小，避免 dispatch_worker 每 30s 轮询一次拖慢测试
        engine.config.polling_interval = 1
        # mock 默认成员挂在 workspace_id 下；测试用的 squad 单独注入
        engine._members["sq"] = ["alice", "bob"]

        manifest_path = os.path.join(state_dir, "dAG.yaml")
        _write_manifest(manifest_path, ["alice", "bob"])

        # 第一遍：A、B 都跑到 DONE
        start_new_run(manifest_path, engine=engine)

        ids_after_first = _capture_new_work_item_ids(engine)
        assert len(ids_after_first) == 2, f"第一遍应建 2 个 work item，实际 {len(ids_after_first)}"

        # 确认第一遍两个都 DONE（create_run 按派发作用域 squad_id 存 work item）
        for key in ("A", "B"):
            it = engine.find_work_item_by_dag_key("sq", key)
            assert it is not None and it.status == WorkItemStatus.DONE, f"{key} 应 DONE"

        # 第二遍：同一 manifest 重跑
        start_new_run(manifest_path, engine=engine)

        ids_after_second = _capture_new_work_item_ids(engine)
        # 关键断言：没有产生新的 work item
        assert ids_after_second == ids_after_first, (
            "第二遍重跑不应新建 work item！"
            f" 第一遍={ids_after_first} 第二遍={ids_after_second}"
        )


def test_rerun_with_modified_failed_node_redoes_only_that():
    """模拟失败重派：第一遍 A/B 都 DONE；leader 人为把 B 退回 BLOCKED（代表失败改派）后重跑：
    A 已 DONE → 复用不重派；B 非 DONE → 重置重派，最终再 DONE。全程不产生新 work item。"""
    with tempfile.TemporaryDirectory() as state_dir:
        env = {
            "ENGINE_TYPE": "mock",
            "MOCK_WORKSPACE_ID": "ws",
            "MOCK_STATE_DIR": state_dir,
            "MOCK_AUTO_COMPLETE": "true",
            "MOCK_AUTO_COMPLETE_DELAY": "0",
            "POLLING_INTERVAL": "1",
        }
        engine = create_engine_from_config("mock", "ws", **env)
        engine.config.polling_interval = 1
        engine._members["sq"] = ["alice", "bob"]

        manifest_path = os.path.join(state_dir, "dag.yaml")
        _write_manifest(manifest_path, ["alice", "bob"])

        # 第一遍：A、B 都自动跑到 DONE
        start_new_run(manifest_path, engine=engine)
        a_item = engine.find_work_item_by_dag_key("sq", "A")
        b_item = engine.find_work_item_by_dag_key("sq", "B")
        assert a_item.status == WorkItemStatus.DONE
        assert b_item.status == WorkItemStatus.DONE
        a_id_first, b_id_first = a_item.id, b_item.id

        # leader 发现 B 实际有问题（或要换 worker），把 B 退回 BLOCKED
        engine.update_status(b_item.id, WorkItemStatus.BLOCKED)
        b_item.artifacts = None

        # 第二遍：重跑。A 复用 DONE，B 非 DONE 重置重派
        start_new_run(manifest_path, engine=engine)

        a_item2 = engine.find_work_item_by_dag_key("sq", "A")
        b_item2 = engine.find_work_item_by_dag_key("sq", "B")

        # A 是 DONE → 复用同一个 item_id，保持 DONE
        assert a_item2.id == a_id_first, "A 已 DONE 应复用原 item，不重建"
        assert a_item2.status == WorkItemStatus.DONE, "复用的 A 应保持 DONE"

        # B 非 DONE → 复用同一 item_id 但被重派（最终自动完成到 DONE）
        assert b_item2.id == b_id_first, "B 非 DONE 期间也应复用原 item_id（避免孤儿 issue）"
        assert b_item2.status == WorkItemStatus.DONE, f"重派后 B 应再 DONE，实际 {b_item2.status}"

        # 重跑全程没有产生第 3、第 4 个 work item
        ids = {it.id for it in engine._work_items.values()}
        assert len(ids) == 2, f"重跑不应新建 work item，实际 {len(ids)} 个: {ids}"