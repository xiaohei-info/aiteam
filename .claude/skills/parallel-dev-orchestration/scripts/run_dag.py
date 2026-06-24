#!/usr/bin/env python3
"""
DAG 编排引擎 - 使用 Run 生命周期接口

改进：
- 引擎统一管理 Run 生命周期（创建、查询、恢复）
- 业务层不再直接操作 storage
- 引擎内部自动保存检查点和事件日志
"""
import sys
import time
import argparse
from pathlib import Path
from typing import Dict, Set, Optional

# 添加当前目录到 path
sys.path.insert(0, str(Path(__file__).parent))

from core import load_manifest, Manifest, lint, frontier, downstream_of
from utils import format_duration

# 引入引擎
from engines import create_engine_from_env, create_engine_from_config, CollaborationEngine, WorkItemStatus, Run, RunStatus


# ==================== 核心执行逻辑 ====================

def dispatch_worker(
    engine: CollaborationEngine,
    key: str,
    item_id: str,
    worker_name: str,
    run: Run
) -> str:
    """派发 worker：assign → 轮询到完成 → 检查产物

    返回: "ok" | "failed"
    """
    # 分配任务给 worker
    engine.assign_work_item(item_id, worker_name, "worker")

    print(f"  📤 派发任务 {key} 给 {worker_name}")

    # 记录事件
    engine._log_event(run.id, "node_started", {
        "node_key": key,
        "worker": worker_name
    })

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
                print(f"  ✅ 任务 {key} 完成，产物: {work_item.artifacts}")
                engine._log_event(run.id, "node_completed", {
                    "node_key": key,
                    "artifacts": work_item.artifacts
                })
                return "ok"
            else:
                reason = "缺少 PR 产物"
                print(f"  ❌ 任务 {key} 失败: {reason}")
                engine._log_event(run.id, "node_failed", {
                    "node_key": key,
                    "reason": reason
                })
                return "failed"

        elif work_item.status == WorkItemStatus.FAILED:
            reason = "Worker run failed"
            print(f"  ❌ 任务 {key} 失败: {reason}")
            engine._log_event(run.id, "node_failed", {
                "node_key": key,
                "reason": reason
            })
            return "failed"

    # 超时
    print(f"  ⏰ 任务 {key} 超时")
    engine._log_event(run.id, "node_failed", {
        "node_key": key,
        "reason": "执行超时"
    })
    return "failed"


def run_gate(
    engine: CollaborationEngine,
    key: str,
    item_id: str,
    reviewer_name: Optional[str],
    run: Run
) -> str:
    """派发 reviewer：assign → 轮询 → 读 verdict

    返回: "approve" | "reject"
    """
    if not reviewer_name:
        return "approve"  # 无 reviewer = 自动通过

    # 分配任务给 reviewer
    engine.assign_work_item(item_id, reviewer_name, "reviewer")

    print(f"  🔍 派发审核 {key} 给 {reviewer_name}")

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
                print(f"  ✅ 审核通过: {key}")
                return "approve"
            else:
                print(f"  ❌ 审核拒绝: {key} - {work_item.review_verdict}")
                engine._log_event(run.id, "node_failed", {
                    "node_key": key,
                    "reason": f"Reviewer blocked: {work_item.review_verdict}"
                })
                return "reject"

    # 超时，视为拒绝
    print(f"  ⏰ 审核超时: {key}")
    engine._log_event(run.id, "node_failed", {
        "node_key": key,
        "reason": "审核超时"
    })
    return "reject"


def execute_dag(
    engine: CollaborationEngine,
    run: Run,
    manifest: Manifest,
    key_to_id: Dict[str, str]
):
    """执行 DAG 编排循环

    Args:
        engine: 引擎实例
        run: Run 对象
        manifest: Manifest 对象
        key_to_id: {dag_key: item_id} 映射
    """
    workspace_id = run.workspace_id
    completed = set()
    failed = set()

    print(f"\n=== 开始执行 DAG ===")
    print(f"  总任务数: {run.total_tasks}")

    while True:
        # 读取当前状态快照
        snapshot = {}
        for key, item_id in key_to_id.items():
            work_item = engine.get_work_item(item_id)
            snapshot[key] = {
                "id": item_id,
                "status": work_item.status.value,
                "worker": work_item.worker,
                "reviewer": work_item.reviewer,
                "blocked_by": work_item.blocked_by
            }

        # 计算 frontier（考虑失败隔离）
        blocked = downstream_of(snapshot, failed)
        ready = [k for k in frontier(snapshot) if k not in blocked and k not in failed and k not in completed]

        if not ready:
            # 检查是否全部完成或失败
            if len(completed) + len(failed) >= len(key_to_id):
                break

            # 还有任务但都被阻塞，继续等待
            print(f"  ⏸️  所有任务都被阻塞，等待 {engine.config.polling_interval}s 后重试...")
            time.sleep(engine.config.polling_interval)
            continue

        # 派发任务（简化：顺序执行）
        for key in ready[:1]:  # 一次只处理一个
            item_id = key_to_id[key]
            node = manifest.nodes[key]
            worker = node.worker
            reviewer = getattr(node, 'reviewer', None)

            print(f"\n▶️  处理任务: {key}")

            # 派发 worker
            engine.update_status(item_id, WorkItemStatus.IN_PROGRESS)
            result = dispatch_worker(engine, key, item_id, worker, run)

            if result != "ok":
                engine.update_status(item_id, WorkItemStatus.BLOCKED)
                failed.add(key)
                # 保存检查点
                engine._save_checkpoint(run.id, key_to_id, list(completed), list(failed))
                continue

            # 派发 reviewer（如果有）
            if reviewer:
                engine.update_status(item_id, WorkItemStatus.IN_REVIEW)
                gate_result = run_gate(engine, key, item_id, reviewer, run)

                if gate_result == "approve":
                    engine.update_status(item_id, WorkItemStatus.DONE)
                    completed.add(key)
                else:
                    engine.update_status(item_id, WorkItemStatus.BLOCKED)
                    failed.add(key)
            else:
                # 无 reviewer，直接标记完成
                engine.update_status(item_id, WorkItemStatus.DONE)
                completed.add(key)

            # 保存检查点
            engine._save_checkpoint(run.id, key_to_id, list(completed), list(failed))

    # 最终汇总
    print(f"\n=== DAG 执行完成 ===")
    print(f"  ✅ 完成: {len(completed)}/{run.total_tasks}")
    print(f"  ❌ 失败: {len(failed)}/{run.total_tasks}")
    print(f"  📊 成功率: {len(completed) / run.total_tasks * 100:.1f}%")

    # 记录完成事件
    engine._log_event(run.id, "engine_completed", {
        "completed": list(completed),
        "failed": list(failed),
        "success_rate": len(completed) / run.total_tasks * 100 if run.total_tasks > 0 else 0
    })


# ==================== 主流程 ====================

def start_new_run(manifest_path: str, engine: CollaborationEngine = None):
    """启动新的 run"""
    # 1. 加载 manifest
    print(f"=== 加载 manifest: {manifest_path} ===")
    manifest = load_manifest(manifest_path)

    workspace_id = manifest.meta.get("squad")
    if not workspace_id:
        print("❌ 错误: manifest.meta 缺少 'squad' (workspace_id)")
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
    members = engine.list_members(workspace_id)
    errors = lint(manifest, members)
    if errors:
        print("❌ Lint 失败:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("✅ Lint 通过")

    # 4. 创建 Run（引擎内部自动创建工作单元、保存 manifest 和状态）
    print(f"\n=== 创建 Run ===")
    run = engine.create_run(workspace_id, manifest)

    print(f"🚀 启动 run {run.id}")
    print(f"  总任务: {run.total_tasks}")
    print(f"  创建时间: {run.created_at}")

    # 5. 获取 key_to_id 映射（从检查点加载）
    checkpoint = engine._load_checkpoint(run.id)
    if not checkpoint:
        print("❌ 错误: 无法加载检查点")
        sys.exit(1)

    key_to_id = checkpoint["key_to_id"]

    # 6. 执行 DAG
    execute_dag(engine, run, manifest, key_to_id)

    # 7. 查询最终状态
    final_run = engine.get_run(run.id)
    if final_run:
        print(f"\n=== 最终状态 ===")
        print(f"  Run ID: {final_run.id}")
        print(f"  状态: {final_run.status.value}")
        print(f"  完成: {final_run.completed_tasks}/{final_run.total_tasks}")
        print(f"  失败: {final_run.failed_tasks}/{final_run.total_tasks}")
        print(f"  进度: {final_run.progress_percent:.1f}%")


def resume_run(run_id: str, engine: CollaborationEngine = None):
    """恢复运行"""
    # 1. 创建或获取引擎
    if engine is None:
        print("=== 初始化引擎 ===")
        engine = create_engine_from_env()

    # 2. 获取 run
    print(f"=== 恢复 run {run_id} ===")
    run = engine.get_run(run_id)

    if not run:
        print(f"❌ Run {run_id} 不存在")
        sys.exit(1)

    if run.status == RunStatus.COMPLETED:
        print(f"✅ Run {run_id} 已完成")
        return

    print(f"  状态: {run.status.value}")
    print(f"  进度: {run.completed_tasks}/{run.total_tasks} ({run.progress_percent:.1f}%)")

    # 3. 加载检查点
    checkpoint = engine._load_checkpoint(run_id)
    if not checkpoint:
        print("❌ 错误: 无法加载检查点")
        sys.exit(1)

    key_to_id = checkpoint["key_to_id"]

    # 4. 重新加载 manifest（从引擎加载）
    # TODO: 引擎需要提供 load_manifest 方法
    print("⚠️  警告: 恢复功能需要引擎实现 manifest 加载")
    print("   当前版本需要手动提供 manifest 文件")


def list_runs_command(engine: CollaborationEngine = None):
    """列出所有 runs"""
    if engine is None:
        engine = create_engine_from_env()

    runs = engine.list_runs()

    if not runs:
        print("📭 没有找到任何 run")
        return

    print(f"=== 历史 Runs（共 {len(runs)} 个）===\n")

    for run in runs:
        status_icon = {
            RunStatus.RUNNING: "🔄",
            RunStatus.COMPLETED: "✅",
            RunStatus.FAILED: "❌",
            RunStatus.PAUSED: "⏸️"
        }.get(run.status, "❓")

        print(f"{status_icon} {run.id}")
        print(f"   状态: {run.status.value}")
        print(f"   名称: {run.manifest_name}")
        print(f"   进度: {run.completed_tasks}/{run.total_tasks} ({run.progress_percent:.1f}%)")
        print(f"   创建: {run.created_at.strftime('%Y-%m-%d %H:%M:%S')}")
        print()


def main():
    """主入口"""
    parser = argparse.ArgumentParser(description="DAG 编排引擎 v3")
    parser.add_argument("manifest", nargs="?", help="manifest 文件路径")
    parser.add_argument("--engine", help="引擎类型（默认从 .env 读取）")
    parser.add_argument("--workspace", help="工作空间 ID（默认从 manifest 读取）")
    parser.add_argument("--resume", help="续跑：指定 run_id")
    parser.add_argument("--list", action="store_true", help="列出所有 runs")

    args = parser.parse_args()

    # 列出 runs
    if args.list:
        list_runs_command()
        return

    # 续跑
    if args.resume:
        resume_run(args.resume)
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

    start_new_run(args.manifest, engine=engine)


if __name__ == '__main__':
    main()
