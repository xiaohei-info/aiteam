# graph.py
DONE = "done"
TERMINAL = {"done", "cancelled"}
INFLIGHT = {"in_progress", "in_review"}

def is_done(issue) -> bool:
    return issue["status"] == DONE

def frontier(issues: dict) -> list:
    """status==todo 且所有 blocked_by 节点已 done 的节点 key（连续 frontier，不分层）。"""
    out = []
    for key, it in issues.items():
        if it["status"] != "todo":
            continue
        if all(issues.get(b, {}).get("status") == DONE for b in it["blocked_by"]):
            out.append(key)
    return out

def all_terminal(issues: dict) -> bool:
    return all(it["status"] in TERMINAL for it in issues.values())
