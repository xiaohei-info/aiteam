#!/usr/bin/env python3
"""
固定引擎入口: manifest → lint → compile → run_dag
支持断点续跑和进度可视化
"""
import sys
import json
import subprocess
import time
import argparse
from pathlib import Path

# 添加当前目录到 path 以便 import 其他模块
sys.path.insert(0, str(Path(__file__).parent))

from manifest import load_manifest, Manifest
from lint import lint
from graph import frontier, downstream_of
from storage import StorageBackend, MulticaIssueStorage, LocalFileStorage
from state import EngineState
from progress import ProgressReporter
from utils import generate_run_id, format_duration


def run_multica(args, capture=True):
    """调 multica CLI,返回 stdout(JSON 解析后)或原始文本"""
    cmd = ["multica"] + args
    result = subprocess.run(cmd, capture_output=capture, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"multica 调用失败: {' '.join(cmd)}\n{result.stderr}")
    if capture and result.stdout.strip():
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            return result.stdout.strip()
    return None


def get_squad_members(workspace_id):
    """获取 workspace 中所有 agent 的名字集合"""
    agents = run_multica(["agent", "list", "--workspace-id", workspace_id, "--output", "json"])
    if isinstance(agents, list):
        return {agent.get("name") for agent in agents if agent.get("name")}
    return set()


def create_issues_from_manifest(manifest: Manifest):
    """从 manifest 创建 multica issues(如果不存在)
    返回 {key: issue_id} 映射
    """
    workspace_id = manifest.meta.get("squad")
    if not workspace_id:
        raise ValueError("manifest.meta 缺少 'squad' (workspace_id)")

    result = run_multica(["issue", "list", "--workspace-id", workspace_id, "--output", "json"])

    # 处理返回值：可能是 list 或 dict with 'issues' key
    if isinstance(result, dict) and 'issues' in result:
        issues = result['issues']
    elif isinstance(result, list):
        issues = result
    else:
        issues = []

    key_to_id = {}

    # 为每个 manifest 节点创建或查找对应 issue
    for key, node in manifest.nodes.items():
        node_title = getattr(node, 'title', None) or key
        node_desc = getattr(node, 'description', None) or f"Task {key}"

        # 查找已有 issue(通过 title 包含 [DAG:key])
        found = None
        dag_marker = f"[DAG:{key}]"
        if isinstance(issues, list):
            for issue in issues:
                if dag_marker in issue.get("title", ""):
                    found = issue["id"]
                    break

        if not found:
            # 创建新 issue
            result = run_multica([
                "issue", "create",
                "--workspace-id", workspace_id,
                "--title", f"{dag_marker} {node_title}",
                "--description", node_desc,
                "--status", "todo",
                "--output", "json"
            ])
            found = result["id"] if isinstance(result, dict) else None

        if found:
            key_to_id[key] = found

    return key_to_id


def compile_metadata(manifest: Manifest, key_to_id: dict):
    """单向编译:manifest → issue metadata(blocked_by/worker/reviewer)"""
    for key, node in manifest.nodes.items():
        issue_id = key_to_id.get(key)
        if not issue_id:
            continue

        # blocked_by(依赖的 issue id 列表)
        blocked_ids = [key_to_id[dep] for dep in node.blocked_by if dep in key_to_id]
        if blocked_ids:
            run_multica([
                "issue", "metadata", "set", issue_id,
                "--key", "blocked_by",
                "--value", json.dumps(blocked_ids)
            ], capture=False)

        # worker
        run_multica([
            "issue", "metadata", "set", issue_id,
            "--key", "worker",
            "--value", node.worker
        ], capture=False)

        # reviewer(可选)
        if node.reviewer:
            run_multica([
                "issue", "metadata", "set", issue_id,
                "--key", "reviewer",
                "--value", node.reviewer
            ], capture=False)

        # gate(可选)
        if hasattr(node, 'gate') and node.gate:
            run_multica([
                "issue", "metadata", "set", issue_id,
                "--key", "gate",
                "--value", json.dumps(node.gate)
            ], capture=False)


def list_issues_snapshot(key_to_id: dict):
    """读取当前所有 issue 状态,返回 {key: issue_dict}"""
    snapshot = {}
    for key, issue_id in key_to_id.items():
        issue = run_multica(["issue", "get", issue_id, "--output", "json"])
        if isinstance(issue, dict):
            # 规范化:status / metadata
            snapshot[key] = {
                "id": issue_id,
                "status": issue.get("status", "todo"),
                "worker": issue.get("metadata", {}).get("worker"),
                "reviewer": issue.get("metadata", {}).get("reviewer"),
                "blocked_by": json.loads(issue.get("metadata", {}).get("blocked_by", "[]"))
                    if isinstance(issue.get("metadata", {}).get("blocked_by"), str)
                    else issue.get("metadata", {}).get("blocked_by", [])
            }
    return snapshot


def resolve_agent_id(agent_name, workspace_id):
    """从 agent 名解析到 agent id(用于 assign)"""
    agents = run_multica(["agent", "list", "--workspace-id", workspace_id, "--output", "json"])

    if isinstance(agents, list):
        for agent in agents:
            if agent.get("name") == agent_name:
                return agent.get("id")

    raise ValueError(f"agent '{agent_name}' not found in workspace {workspace_id}")


def dispatch_worker(key, issue_id, worker_name, workspace_id, progress: ProgressReporter):
    """派发 worker:assign → 轮询 runs 到终态 → 检查产物"""
    # assign
    agent_id = resolve_agent_id(worker_name, workspace_id)
    run_multica(["issue", "assign", issue_id, "--to", agent_id], capture=False)

    # 报告节点开始
    progress.update_progress("node_started", node_key=key, worker=worker_name)

    # 轮询 runs 到终态
    while True:
        time.sleep(10)
        runs = run_multica(["issue", "runs", issue_id, "--output", "json"])
        if isinstance(runs, list) and runs:
            status = runs[0].get("status")
            if status in ["succeeded", "completed", "failed"]:
                # 检查 metadata.artifacts
                issue = run_multica(["issue", "get", issue_id, "--output", "json"])
                artifacts = issue.get("metadata", {}).get("artifacts", "")

                if status == "failed" or not (artifacts and ("PR:" in artifacts or "pr" in artifacts.lower())):
                    reason = "Worker run failed" if status == "failed" else "缺少 PR 产物"
                    progress.update_progress("node_failed", node_key=key, reason=reason)
                    return "failed"
                else:
                    progress.update_progress("node_completed", node_key=key, artifacts=artifacts)
                    return "ok"
    return "failed"


def run_gate(key, issue_id, reviewer_name, workspace_id, progress: ProgressReporter):
    """派发 reviewer:assign → 轮询 run → 读 verdict"""
    if not reviewer_name:
        return "approve"  # 无 reviewer = 自动通过

    agent_id = resolve_agent_id(reviewer_name, workspace_id)
    run_multica(["issue", "assign", issue_id, "--to", agent_id], capture=False)

    while True:
        time.sleep(10)
        runs = run_multica(["issue", "runs", issue_id, "--output", "json"])
        if isinstance(runs, list) and runs:
            status = runs[0].get("status")
            if status in ["succeeded", "completed", "failed"]:
                issue = run_multica(["issue", "get", issue_id, "--output", "json"])
                verdict = issue.get("metadata", {}).get("review_verdict", "blocked")

                if verdict == "pass" or verdict == "pass-with-nits":
                    return "approve"
                else:
                    progress.update_progress("node_failed", node_key=key, reason=f"Reviewer blocked: {verdict}")
                    return "reject"
    return "reject"


def run_dag_loop(manifest: Manifest, state: EngineState, storage: StorageBackend, progress: ProgressReporter):
    """引擎循环:frontier → dispatch → gate → 下一轮"""
    workspace_id = state.workspace_id
    key_to_id = state.key_to_id
    failed = state.failed.copy()
    max_parallel = 1  # 简化实现:顺序执行

    while True:
        # 读当前状态快照
        issues_snapshot = list_issues_snapshot(key_to_id)

        # 计算 frontier(考虑失败隔离)
        blocked = downstream_of(issues_snapshot, failed)
        ready = [k for k in frontier(issues_snapshot) if k not in blocked and k not in failed]

        if not ready:
            break

        for key in ready[:max_parallel]:
            issue_id = key_to_id[key]
            worker = issues_snapshot[key].get("worker")
            reviewer = issues_snapshot[key].get("reviewer")

            # 派发 worker
            run_multica(["issue", "update", issue_id, "--status", "in_progress"], capture=False)
            result = dispatch_worker(key, issue_id, worker, workspace_id, progress)

            if result != "ok":
                run_multica(["issue", "update", issue_id, "--status", "blocked"], capture=False)
                failed.add(key)
                state.mark_failed(key)
                continue

            # 派发 reviewer(如果有)
            run_multica(["issue", "update", issue_id, "--status", "in_review"], capture=False)
            gate_result = run_gate(key, issue_id, reviewer, workspace_id, progress)

            if gate_result == "approve":
                run_multica(["issue", "update", issue_id, "--status", "done"], capture=False)
                state.mark_completed(key)
            else:
                run_multica(["issue", "update", issue_id, "--status", "blocked"], capture=False)
                failed.add(key)
                state.mark_failed(key)

    # 最终汇总
    final_snapshot = list_issues_snapshot(key_to_id)
    done = [k for k, it in final_snapshot.items() if it["status"] == "done"]

    summary = {
        "done": done,
        "failed": sorted(failed),
        "total": len(key_to_id),
        "success_rate": len(done) / len(key_to_id) * 100 if key_to_id else 0
    }

    progress.update_progress("engine_completed", summary=summary)

    return summary


def start_new_run(manifest_path: str, orchestrator_issue_id: str = None,
                  storage_backend: str = "local"):
    """启动新的 run"""
    # 1. 加载 manifest
    print(f"=== 加载 manifest: {manifest_path} ===")
    manifest = load_manifest(manifest_path)

    workspace_id = manifest.meta.get("squad")
    if not workspace_id:
        print("错误: manifest.meta 缺少 'squad' (workspace_id)")
        sys.exit(1)

    # 2. Lint
    print("=== Lint manifest ===")
    members = get_squad_members(workspace_id)
    errors = lint(manifest, members)
    if errors:
        print("Lint 失败:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("Lint 通过 ✓")

    # 3. 初始化存储
    if storage_backend == "multica" and orchestrator_issue_id:
        storage = MulticaIssueStorage(orchestrator_issue_id)
    else:
        storage = LocalFileStorage()

    # 4. 生成 run_id 并保存 manifest
    run_id = generate_run_id()
    with open(manifest_path) as f:
        manifest_content = f.read()
    manifest_ref = storage.save_manifest(manifest_content, run_id)

    print(f"\n🚀 新启动 run {run_id}")

    # 5. 创建/查找 issues
    print("=== 创建/查找 issues ===")
    key_to_id = create_issues_from_manifest(manifest)

    # 6. 编译 metadata
    print("=== 编译 metadata ===")
    compile_metadata(manifest, key_to_id)

    # 7. 初始化引擎状态
    state = EngineState(
        run_id=run_id,
        manifest_ref=manifest_ref,
        workspace_id=workspace_id,
        orchestrator_issue_id=orchestrator_issue_id,
        key_to_id=key_to_id
    )

    # 8. 初始化进度报告器
    progress = ProgressReporter(state, storage, manifest)
    progress.update_progress("engine_started")

    # 9. 运行引擎
    print("\n=== 启动引擎 ===")
    result = run_dag_loop(manifest, state, storage, progress)

    # 10. 输出 digest
    print("\n=== Digest ===")
    print(f"Done: {len(result['done'])} {result['done']}")
    print(f"Failed: {len(result['failed'])} {result['failed']}")
    print(f"Success Rate: {result['success_rate']:.1f}%")

    return 0 if not result['failed'] else 1


def resume_run(run_id: str, orchestrator_issue_id: str = None,
               storage_backend: str = "local"):
    """续跑已有的 run"""
    # 初始化存储
    if storage_backend == "multica" and orchestrator_issue_id:
        storage = MulticaIssueStorage(orchestrator_issue_id)
    else:
        storage = LocalFileStorage()

    # 加载状态
    state_dict = storage.load_state(run_id)
    if not state_dict:
        print(f"错误: 找不到 run {run_id} 的状态")
        sys.exit(1)

    state = EngineState.from_dict(state_dict)

    # 加载 manifest
    manifest_content = storage.load_manifest(run_id)
    if not manifest_content:
        print(f"错误: 找不到 run {run_id} 的 manifest")
        sys.exit(1)

    # 临时保存并加载 manifest
    temp_path = f"/tmp/manifest_{run_id}.yaml"
    with open(temp_path, 'w') as f:
        f.write(manifest_content)
    manifest = load_manifest(temp_path)
    Path(temp_path).unlink(missing_ok=True)

    # 显示续跑信息
    stats = state.get_progress_stats()
    print(f"\n🔄 续跑 run {run_id}")
    print(f"   已完成: {stats['completed']} 个节点")
    print(f"   已失败: {stats['failed']} 个节点")
    print(f"   进行中: {stats['in_progress']} 个节点")
    print(f"   已用时间: {format_duration(state.get_elapsed_time())}")

    # 初始化进度报告器
    progress = ProgressReporter(state, storage, manifest)

    # 继续运行引擎
    print("\n=== 继续引擎 ===")
    result = run_dag_loop(manifest, state, storage, progress)

    # 输出 digest
    print("\n=== Digest ===")
    print(f"Done: {len(result['done'])} {result['done']}")
    print(f"Failed: {len(result['failed'])} {result['failed']}")
    print(f"Success Rate: {result['success_rate']:.1f}%")

    return 0 if not result['failed'] else 1


def list_runs_command(storage_backend: str = "local", orchestrator_issue_id: str = None):
    """列出所有 run"""
    if storage_backend == "multica" and orchestrator_issue_id:
        storage = MulticaIssueStorage(orchestrator_issue_id)
    else:
        storage = LocalFileStorage()

    runs = storage.list_runs()

    if not runs:
        print("没有找到任何 run")
        return 0

    print(f"\n找到 {len(runs)} 个 run:\n")
    for run_id in runs:
        state_dict = storage.load_state(run_id)
        if state_dict:
            state = EngineState.from_dict(state_dict)
            stats = state.get_progress_stats()
            elapsed = format_duration(state.get_elapsed_time())
            print(f"  {run_id}")
            print(f"    进度: {stats['completed']}/{stats['total']} ({stats['progress_pct']:.1f}%)")
            print(f"    失败: {stats['failed']} | 耗时: {elapsed}")
            print()
        else:
            print(f"  {run_id} (无状态信息)")

    return 0


def main():
    parser = argparse.ArgumentParser(description="Multica DAG 编排引擎")
    parser.add_argument("manifest", nargs="?", help="Manifest YAML 文件路径")
    parser.add_argument("--resume", metavar="RUN_ID", help="续跑指定的 run")
    parser.add_argument("--list", action="store_true", help="列出所有 run")
    parser.add_argument("--orchestrator-issue", help="Orchestrator issue ID（用于进度报告）")
    parser.add_argument("--storage", choices=["local", "multica"], default="local",
                       help="存储后端（默认: local）")

    args = parser.parse_args()

    # 列出 runs
    if args.list:
        sys.exit(list_runs_command(args.storage, args.orchestrator_issue))

    # 续跑
    if args.resume:
        sys.exit(resume_run(args.resume, args.orchestrator_issue, args.storage))

    # 新启动
    if not args.manifest:
        parser.print_help()
        sys.exit(1)

    sys.exit(start_new_run(args.manifest, args.orchestrator_issue, args.storage))


if __name__ == "__main__":
    main()
