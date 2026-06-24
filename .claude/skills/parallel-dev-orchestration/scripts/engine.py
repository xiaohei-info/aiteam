# engine.py
from graph import frontier, downstream_of

def run_dag(client, dispatch_worker, run_gate, max_parallel=4):
    """固定 driver：连续 frontier → 派 worker → gate → status；失败按分支隔离。
    返回 {"done":[...], "failed":[...]}。max_parallel 为并发上限（此实现顺序处理一批，
    真并发在后续阶段用线程池替换循环体，语义不变）。"""
    failed = set()
    while True:
        issues = client.list_issues()
        # 隔离：已失败节点的下游不再 ready
        blocked = downstream_of(issues, failed)
        ready = [k for k in frontier(issues) if k not in blocked and k not in failed]
        if not ready:
            break
        for key in ready[:max_parallel] if max_parallel else ready:
            client.assign(key, issues[key].get("worker") or "w")
            client.set_status(key, "in_progress")
            if dispatch_worker(key) != "ok":
                client.set_status(key, "blocked")
                failed.add(key)
                continue
            client.set_status(key, "in_review")
            if run_gate(key) == "approve":
                client.set_status(key, "done")
            else:
                client.set_status(key, "blocked")
                failed.add(key)
    issues = client.list_issues()
    done = [k for k, it in issues.items() if it["status"] == "done"]
    return {"done": done, "failed": sorted(failed)}
