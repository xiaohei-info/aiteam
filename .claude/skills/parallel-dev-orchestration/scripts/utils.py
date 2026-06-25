"""
工具函数模块
"""
import subprocess
from datetime import datetime


def format_duration(seconds: float) -> str:
    """格式化时长为可读格式。"""
    if seconds < 60:
        return f"{int(seconds)}s"
    minutes = int(seconds // 60)
    remaining_seconds = int(seconds % 60)
    if minutes < 60:
        if remaining_seconds > 0:
            return f"{minutes}m {remaining_seconds}s"
        return f"{minutes}m"
    hours = minutes // 60
    remaining_minutes = minutes % 60
    parts = [f"{hours}h"]
    if remaining_minutes > 0:
        parts.append(f"{remaining_minutes}m")
    if remaining_seconds > 0:
        parts.append(f"{remaining_seconds}s")
    return " ".join(parts)


def commit_manifest(path: str, message: str, repo_root: str = ".") -> bool:
    """git add <path> + git commit + git push。

    幂等：无变更时跳过。push 失败醒目告警但不中断编排。
    不自动 merge（PR 评审是外部门控）。
    """
    abs_path = path if path.startswith("/") else f"{repo_root}/{path}"
    r = subprocess.run(["git", "add", abs_path], cwd=repo_root,
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"git add 失败: {r.stderr.strip()}")
        return False
    r = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=repo_root,
                       capture_output=True, text=True)
    if r.returncode == 0:
        return False
    r = subprocess.run(["git", "commit", "-m", message], cwd=repo_root,
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"git commit 失败: {r.stderr.strip()}")
        return False
    r = subprocess.run(["git", "push"], cwd=repo_root,
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"git push 失败: {r.stderr.strip()}")
        print(f"  manifest 已本地 commit 但未 push——跨机器口径可能滞后！")
    return True


def render_progress(manifest, completed: set, failed: set) -> str:
    """从 manifest + completed/failed 生成全局进度 digest 文本。"""
    total = len(manifest.nodes)
    done = len(completed)
    fail = len(failed)
    in_flight = sum(1 for n in manifest.nodes.values()
                    if n.status in ("in_progress", "in_review"))
    todo = total - done - fail - in_flight
    pct = done / total * 100 if total > 0 else 0

    bar_width = 20
    filled = int(bar_width * pct / 100)
    bar = "=" * filled + "-" * (bar_width - filled)

    lines = [
        f"[{bar}] {done}/{total} ({pct:.0f}%)",
        f"done={sorted(completed) if completed else []}",
        f"failed={sorted(failed) if failed else []}",
        f"in_progress={in_flight} todo={todo}",
    ]
    return "\n".join(lines)
