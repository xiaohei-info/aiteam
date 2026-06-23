#!/usr/bin/env python3
"""
固定引擎入口:manifest → lint → compile → run_dag
直接调 multica CLI (subprocess),不经过抽象层
"""
import sys
import json
import subprocess
import time
from pathlib import Path

# 添加当前目录到 path 以便 import 其他模块
sys.path.insert(0, str(Path(__file__).parent))

from manifest import load_manifest, Manifest
from lint import lint
from graph import frontier, downstream_of


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

    # 简化实现:假设 issue 已存在,通过 title 匹配 key
    # 真实实现需要 issue create 或检查已有
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
        # 从 node 提取 title 和 description
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
    """从 agent 名解析到 agent id(用于 assign)

    跨查询逻辑:
    1. multica agent list --workspace-id <id> 获取所有 agent (name + id)
    2. 按 name 匹配找到对应 agent id
    """
    # 获取 workspace 所有 agent
    agents = run_multica(["agent", "list", "--workspace-id", workspace_id, "--output", "json"])

    if isinstance(agents, list):
        # 按名字匹配
        for agent in agents:
            if agent.get("name") == agent_name:
                return agent.get("id")

    # 未找到，报错
    raise ValueError(f"agent '{agent_name}' not found in workspace {workspace_id}")


def dispatch_worker(key, issue_id, worker_name, workspace_id):
    """派发 worker:assign → 轮询 runs 到终态 → 检查产物
    返回 'ok' 或 'failed'
    """
    # assign
    agent_id = resolve_agent_id(worker_name, workspace_id)
    run_multica(["issue", "assign", issue_id, "--to", agent_id], capture=False)

    # 轮询 runs 到终态
    print(f"[{key}] 等待 worker {worker_name} 完成...")
    while True:
        time.sleep(10)
        runs = run_multica(["issue", "runs", issue_id, "--output", "json"])
        if isinstance(runs, list) and runs:
            status = runs[0].get("status")
            if status in ["succeeded", "completed", "failed"]:
                print(f"[{key}] worker run {status}")
                # 检查 metadata.artifacts(简化:只看是否有内容)
                issue = run_multica(["issue", "get", issue_id, "--output", "json"])
                artifacts = issue.get("metadata", {}).get("artifacts", "")
                if artifacts and ("PR:" in artifacts or "pr" in artifacts.lower()):
                    return "ok"
                else:
                    print(f"[{key}] 缺少 PR 产物")
                    return "failed"
    return "failed"


def run_gate(key, issue_id, reviewer_name, workspace_id):
    """派发 reviewer:assign → 轮询 run → 读 verdict
    返回 'approve' 或 'reject'
    """
    if not reviewer_name:
        return "approve"  # 无 reviewer = 自动通过

    agent_id = resolve_agent_id(reviewer_name, workspace_id)
    run_multica(["issue", "assign", issue_id, "--to", agent_id], capture=False)

    print(f"[{key}] 等待 reviewer {reviewer_name}...")
    while True:
        time.sleep(10)
        runs = run_multica(["issue", "runs", issue_id, "--output", "json"])
        if isinstance(runs, list) and runs:
            status = runs[0].get("status")
            if status in ["succeeded", "completed", "failed"]:
                # 读 review_verdict
                issue = run_multica(["issue", "get", issue_id, "--output", "json"])
                verdict = issue.get("metadata", {}).get("review_verdict", "blocked")
                if verdict == "pass" or verdict == "pass-with-nits":
                    return "approve"
                else:
                    print(f"[{key}] reviewer blocked")
                    return "reject"
    return "reject"


def run_dag_loop(manifest: Manifest, key_to_id: dict, workspace_id: str):
    """引擎循环:frontier → dispatch → gate → 下一轮"""
    failed = set()
    max_parallel = 1  # 简化实现:顺序执行

    while True:
        # 读当前状态快照
        issues_snapshot = list_issues_snapshot(key_to_id)

        # 计算 frontier(考虑失败隔离)
        blocked = downstream_of(issues_snapshot, failed)
        ready = [k for k in frontier(issues_snapshot) if k not in blocked and k not in failed]

        if not ready:
            print("=== 无 ready 节点,引擎终止 ===")
            break

        print(f"=== Frontier: {ready} ===")

        for key in ready[:max_parallel]:
            issue_id = key_to_id[key]
            worker = issues_snapshot[key].get("worker")
            reviewer = issues_snapshot[key].get("reviewer")

            print(f"\n[{key}] 开始派发 worker={worker}")

            # 派发 worker
            run_multica(["issue", "update", issue_id, "--status", "in_progress"], capture=False)
            result = dispatch_worker(key, issue_id, worker, workspace_id)

            if result != "ok":
                run_multica(["issue", "update", issue_id, "--status", "blocked"], capture=False)
                failed.add(key)
                print(f"[{key}] worker 失败,标记为 failed")
                continue

            # 派发 reviewer(如果有)
            run_multica(["issue", "update", issue_id, "--status", "in_review"], capture=False)
            gate_result = run_gate(key, issue_id, reviewer, workspace_id)

            if gate_result == "approve":
                run_multica(["issue", "update", issue_id, "--status", "done"], capture=False)
                print(f"[{key}] 完成 ✓")
            else:
                run_multica(["issue", "update", issue_id, "--status", "blocked"], capture=False)
                failed.add(key)
                print(f"[{key}] gate 失败,标记为 failed")

    # 最终汇总
    final_snapshot = list_issues_snapshot(key_to_id)
    done = [k for k, it in final_snapshot.items() if it["status"] == "done"]
    return {"done": done, "failed": sorted(failed)}


def main():
    if len(sys.argv) < 2:
        print("用法: run_dag.py <manifest.yaml>")
        sys.exit(1)

    manifest_path = sys.argv[1]

    # 1. 加载 manifest
    print(f"=== 加载 manifest: {manifest_path} ===")
    manifest = load_manifest(manifest_path)

    # 获取 workspace_id
    workspace_id = manifest.meta.get("squad")
    if not workspace_id:
        print("错误: manifest.meta 缺少 'squad' (workspace_id)")
        sys.exit(1)

    # 2. lint(需要 squad members)
    print("=== Lint manifest ===")
    members = get_squad_members(workspace_id)
    errors = lint(manifest, members)
    if errors:
        print("Lint 失败:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("Lint 通过 ✓")

    # 3. 创建/查找 issues
    print("=== 创建/查找 issues ===")
    key_to_id = create_issues_from_manifest(manifest)
    print(f"映射: {key_to_id}")

    # 4. 编译 metadata
    print("=== 编译 metadata ===")
    compile_metadata(manifest, key_to_id)

    # 5. 运行引擎
    print("\n=== 启动引擎 ===")
    result = run_dag_loop(manifest, key_to_id, workspace_id)

    # 6. 输出 digest
    print("\n=== Digest ===")
    print(f"Done: {len(result['done'])} {result['done']}")
    print(f"Failed: {len(result['failed'])} {result['failed']}")

    sys.exit(0 if not result['failed'] else 1)


if __name__ == "__main__":
    main()
