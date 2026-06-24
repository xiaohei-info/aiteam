#!/usr/bin/env python3
"""
DAG 编排引擎 - 使用通用引擎抽象

流程：manifest → lint → compile → run_dag
支持：断点续跑、进度可视化、多引擎（multica/github/mock）
"""
import sys
import time
import argparse
from pathlib import Path
from typing import Dict, Set, Optional

# 添加当前目录到 path
sys.path.insert(0, str(Path(__file__).parent))

from manifest import load_manifest, Manifest
from lint import lint
from graph import frontier, downstream_of
from storage import StorageBackend, MulticaIssueStorage, LocalFileStorage
from state import EngineState
from progress import ProgressReporter
from utils import generate_run_id, format_duration

# 引入引擎
from engines import create_engine_from_env, create_engine_from_config, CollaborationEngine, WorkItemStatus


# ==================== 引擎适配层 ====================

def get_squad_members(engine: CollaborationEngine, workspace_id: str) -> Set[str]:
    """获取 workspace 中所有成员的名字集合"""
    members = engine.list_members(workspace_id)
    return set(members)


def create_work_items_from_manifest(
    engine: CollaborationEngine,
    manifest: Manifest
) -> Dict[str, str]:
    """从 manifest 创建工作单元（如果不存在）

    返回 {dag_key: work_item_id} 映射
    """
    workspace_id = manifest.meta.get("squad")
    if not workspace_id:
        raise ValueError("manifest.meta 缺少 'squad' (workspace_id)")

    key_to_id = {}

    # 为每个 manifest 节点创建或查找对应工作单元
    for key, node in manifest.nodes.items():
        node_title = getattr(node, 'title', None) or key
        node_desc = getattr(node, 'description', None) or f"Task {key}"

        # 查找已有工作单元
        existing_item = engine.find_work_item_by_dag_key(workspace_id, key)

        if existing_item:
            key_to_id[key] = existing_item.id
            print(f"  找到已有任务: {key} -> {existing_item.id}")
        else:
            # 创建新工作单元
            work_item = engine.create_work_item(
                workspace_id=workspace_id,
                title=node_title,
                description=node_desc,
                dag_key=key,
                worker=node.worker,
                reviewer=getattr(node, 'reviewer', None),
                blocked_by=node.blocked_by,
                wave=getattr(node, 'wave', None),
                initial_status=WorkItemStatus.TODO
            )
            key_to_id[key] = work_item.id
            print(f"  创建新任务: {key} -> {work_item.id}")

    return key_to_id


def list_work_items_snapshot(
    engine: CollaborationEngine,
    key_to_id: Dict[str, str]
) -> Dict[str, Dict]:
    """读取当前所有工作单元状态，返回 {key: item_dict}"""
    snapshot = {}

    for key, item_id in key_to_id.items():
        work_item = engine.get_work_item(item_id)

        # 转换为旧格式（兼容 frontier 计算）
        snapshot[key] = {
            "id": item_id,
            "status": work_item.status.value,
            "worker": work_item.worker,
            "reviewer": work_item.reviewer,
            "blocked_by": work_item.blocked_by
        }

    return snapshot


def dispatch_worker(
    engine: CollaborationEngine,
    key: str,
    item_id: str,
    worker_name: str,
    workspace_id: str,
    progress: ProgressReporter
) -> str:
    """派发 worker：assign → 轮询 runs 到终态 → 检查产物

    返回: "ok" | "failed"
    """
    # 分配任务给 worker
    engine.assign_work_item(item_id, worker_name, "worker")

    # 报告节点开始
    progress.update_progress("node_started", node_key=key, worker=worker_name)

    # 轮询等待完成
    polling_interval = engine.config.polling_interval
    max_wait_time = 3600  # 最长等待 1 小时
    elapsed = 0

    while elapsed < max_wait_time:
        time.sleep(polling_interval)
        elapsed += polling_interval

        # 查询当前状态
        work_item = engine.get_work_item(item_id)

        # 检查是否完成
        if work_item.status == WorkItemStatus.DONE:
            # 检查产物
            if work_item.artifacts and ("pr" in work_item.artifacts or "PR" in str(work_item.artifacts)):
                progress.update_progress("node_completed", node_key=key, artifacts=str(work_item.artifacts))
                return "ok"
            else:
                reason = "缺少 PR 产物"
                progress.update_progress("node_failed", node_key=key, reason=reason)
                return "failed"

        elif work_item.status == WorkItemStatus.FAILED:
            reason = "Worker run failed"
            progress.update_progress("node_failed", node_key=key, reason=reason)
            return "failed"

    # 超时
    progress.update_progress("node_failed", node_key=key, reason="执行超时")
    return "failed"


def run_gate(
    engine: CollaborationEngine,
    key: str,
    item_id: str,
    reviewer_name: Optional[str],
    workspace_id: str,
    progress: ProgressReporter
) -> str:
    """派发 reviewer：assign → 轮询 run → 读 verdict

    返回: "approve" | "reject"
    """
    if not reviewer_name:
        return "approve"  # 无 reviewer = 自动通过

    # 分配任务给 reviewer
    engine.assign_work_item(item_id, reviewer_name, "reviewer")

    # 轮询等待审核完成
    polling_interval = engine.config.polling_interval
    max_wait_time = 1800  # 最长等待 30 分钟
    elapsed = 0

    while elapsed < max_wait_time:
        time.sleep(polling_interval)
        elapsed += polling_interval

        # 查询当前状态
        work_item = engine.get_work_item(item_id)

        # 检查审核结果
        if work_item.review_verdict:
            if work_item.review_verdict in ["pass", "pass-with-nits"]:
                return "approve"
            else:
                progress.update_progress("node_failed", node_key=key, reason=f"Reviewer blocked: {work_item.review_verdict}")
                return "reject"

    # 超时，视为拒绝
    progress.update_progress("node_failed", node_key=key, reason="审核超时")
    return "reject"


def run_dag_loop(
    engine: CollaborationEngine,
    manifest: Manifest,
    state: EngineState,
    storage: StorageBackend,
    progress: ProgressReporter
):
    """引擎循环：frontier → dispatch → gate → 下一轮"""
    workspace_id = state.workspace_id
    key_to_id = state.key_to_id
    failed = state.failed.copy()
    max_parallel = 1  # 简化实现：顺序执行

    while True:
        # 读当前状态快照
        snapshot = list_work_items_snapshot(engine, key_to_id)

        # 计算 frontier（考虑失败隔离）
        blocked = downstream_of(snapshot, failed)
        ready = [k for k in frontier(snapshot) if k not in blocked and k not in failed]

        if not ready:
            # 检查是否全部完成或失败
            all_keys = set(key_to_id.keys())
            completed = state.completed
            if len(completed) + len(failed) >= len(all_keys):
                break

            # 还有任务但都被阻塞，继续等待
            print(f"  所有任务都被阻塞，等待 {engine.config.polling_interval}s 后重试...")
            time.sleep(engine.config.polling_interval)
            continue

        for key in ready[:max_parallel]:
            item_id = key_to_id[key]
            worker = snapshot[key].get("worker")
            reviewer = snapshot[key].get("reviewer")

            # 派发 worker
            engine.update_status(item_id, WorkItemStatus.IN_PROGRESS)
            state.mark_started(key)

            result = dispatch_worker(engine, key, item_id, worker, workspace_id, progress)

            if result != "ok":
                engine.update_status(item_id, WorkItemStatus.BLOCKED)
                failed.add(key)
                state.mark_failed(key)
                continue

            # 派发 reviewer（如果有）
            if reviewer:
                engine.update_status(item_id, WorkItemStatus.IN_REVIEW)
                gate_result = run_gate(engine, key, item_id, reviewer, workspace_id, progress)

                if gate_result == "approve":
                    engine.update_status(item_id, WorkItemStatus.DONE)
                    state.mark_completed(key)
                else:
                    engine.update_status(item_id, WorkItemStatus.BLOCKED)
                    failed.add(key)
                    state.mark_failed(key)
            else:
                # 无 reviewer，直接标记完成
                engine.update_status(item_id, WorkItemStatus.DONE)
                state.mark_completed(key)

    # 最终汇总
    final_snapshot = list_work_items_snapshot(engine, key_to_id)
    done = [k for k, it in final_snapshot.items() if it["status"] == "done"]

    summary = {
        "done": done,
        "failed": sorted(failed),
        "total": len(key_to_id),
        "success_rate": len(done) / len(key_to_id) * 100 if key_to_id else 0
    }

    progress.update_progress("engine_completed", summary=summary)

    return summary


# ==================== 主流程 ====================

def start_new_run(
    manifest_path: str,
    orchestrator_issue_id: str = None,
    storage_backend: str = "local",
    engine: CollaborationEngine = None
):
    """启动新的 run"""
    # 1. 加载 manifest
    print(f"=== 加载 manifest: {manifest_path} ===")
    manifest = load_manifest(manifest_path)

    workspace_id = manifest.meta.get("squad")
    if not workspace_id:
        print("错误: manifest.meta 缺少 'squad' (workspace_id)")
        sys.exit(1)

    # 2. 创建或获取引擎
    if engine is None:
        print("=== 初始化引擎 ===")
        engine = create_engine_from_env()
        print(f"  引擎类型: {engine.__class__.__name__}")
        print(f"  工作空间: {workspace_id}")
        print(f"  轮询间隔: {engine.config.polling_interval}s")

    # 3. Lint
    print("=== Lint manifest ===")
    members = get_squad_members(engine, workspace_id)
    errors = lint(manifest, members)
    if errors:
        print("Lint 失败:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("Lint 通过 ✓")

    # 4. 初始化存储
    if storage_backend == "multica" and orchestrator_issue_id:
        storage = MulticaIssueStorage(orchestrator_issue_id)
    else:
        storage = LocalFileStorage()

    # 5. 生成 run_id 并保存 manifest
    run_id = generate_run_id()
    with open(manifest_path) as f:
        manifest_content = f.read()
    manifest_ref = storage.save_manifest(manifest_content, run_id)

    print(f"\n🚀 新启动 run {run_id}")

    # 6. 创建/查找工作单元
    print("=== 创建/查找工作单元 ===")
    key_to_id = create_work_items_from_manifest(engine, manifest)

    # 7. 初始化引擎状态
    state = EngineState(
        run_id=run_id,
        manifest_ref=manifest_ref,
        workspace_id=workspace_id,
        orchestrator_issue_id=orchestrator_issue_id,
        key_to_id=key_to_id
    )

    # 8. 初始化进度报告器
    progress = ProgressReporter(state, storage, manifest, engine)
    progress.update_progress("engine_started")

    # 9. 运行引擎
    print("\n=== 启动引擎 ===")
    result = run_dag_loop(engine, manifest, state, storage, progress)

    # 10. 输出 digest
    print("\n=== Digest ===")
    print(f"  完成: {len(result['done'])}/{result['total']}")
    print(f"  失败: {len(result['failed'])}/{result['total']}")
    print(f"  成功率: {result['success_rate']:.1f}%")

    return result


def main():
    """主入口"""
    parser = argparse.ArgumentParser(description="DAG 编排引擎")
    parser.add_argument("manifest", nargs="?", help="manifest 文件路径")
    parser.add_argument("--orchestrator-issue", help="编排器 issue ID（用于进度报告）")
    parser.add_argument("--storage", choices=["local", "multica"], default="local", help="存储后端")
    parser.add_argument("--engine", help="引擎类型（默认从 .env 读取）")
    parser.add_argument("--workspace", help="工作空间 ID（默认从 manifest 读取）")
    parser.add_argument("--resume", help="续跑：指定 run_id")
    parser.add_argument("--list", action="store_true", help="列出所有 runs")

    args = parser.parse_args()

    # 列出 runs
    if args.list:
        print("TODO: 列出所有 runs")
        return

    # 续跑
    if args.resume:
        print("TODO: 续跑功能")
        return

    # 新运行
    if not args.manifest:
        parser.print_help()
        sys.exit(1)

    # 创建引擎（如果指定）
    engine = None
    if args.engine and args.workspace:
        print(f"=== 使用指定引擎: {args.engine} ===")
        engine = create_engine_from_config(args.engine, args.workspace)

    start_new_run(
        args.manifest,
        orchestrator_issue_id=args.orchestrator_issue,
        storage_backend=args.storage,
        engine=engine
    )


if __name__ == '__main__':
    main()
