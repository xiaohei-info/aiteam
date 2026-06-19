#!/usr/bin/env python3
"""orchestrate-tick —— 多 Agent 并行开发的中轴命令。

两件事:
  1) 全局进度真相源:观测 GitHub issue DAG,输出整张任务图的推进 digest
     (分 track/wave 进度、frontier、失败、变化、关键路径、死锁/完成判定)。
  2) loop 引擎:阻塞等待"值得决策的变化"或超时,用退出码告诉外层该怎么继续。

设计要点:
  - 纯逻辑(normalize/classify/digest/decide)与 GitHub IO(gh_fetch)分离,纯逻辑可离线测试。
  - "阻塞"= 内部按 interval 轮询的外壳;轮询花的是 cheap 的 gh 调用,不烧 agent token。
  - 一切动作幂等、真相只在 GitHub;命令被杀/重启不丢状态。

退出码(外层据此决定下一步):
   0  CHANGED        有进度变化(FYI),正常继续
  10  TIMEOUT        窗口内无变化,在跑的任务仍在跑 → 外层可直接再调(无需惊动 agent 推理)
  20  NEEDS_DECISION 有失败 / 死锁 → 需要 agent 决策(重跑/改 issue/补依赖/拆子卡)
  25  DISPATCH       有 ready 且未配自动派发钩子 → 需要 agent 认领并派活
  30  ALL_DONE       全部完成
用法:
  orchestrate.py status [-R owner/repo]                 # 立即打印全局进度,退出
  orchestrate.py tick   [-R owner/repo] [--timeout 600] # 阻塞推进,变化/超时返回
"""
from __future__ import annotations
import argparse, json, os, re, subprocess, sys, time

KEY_RE = re.compile(r"^\s*\[([^\]]+)\]")
STATUSES = ["done", "in_progress", "ready", "blocked", "failed"]

# ----------------------------- GitHub IO 层 -----------------------------

def gh_fetch(repo, limit=300):
    """一次拉全仓 issue(含原生依赖字段)。gh ≥2.94 才有 blockedBy/blocking。"""
    fields = ("number,title,state,assignees,labels,blockedBy,blocking,"
              "subIssuesSummary,closedByPullRequestsReferences")
    out = subprocess.run(
        ["gh", "issue", "list", "-R", repo, "--state", "all",
         "--limit", str(limit), "--json", fields],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gh issue list failed: {out.stderr.strip()}")
    return json.loads(out.stdout)

# ----------------------------- 纯逻辑层 -----------------------------

def normalize(raw, scope_labels, failed_labels):
    """raw(gh json) → {number: 规整 issue}。只保留带 scope label 的卡。"""
    sl, fl = set(scope_labels), set(failed_labels)
    issues = {}
    for it in raw:
        labels = {l["name"] for l in it.get("labels", [])}
        if sl and not (labels & sl):
            continue
        m = KEY_RE.match(it.get("title", ""))
        wave = "wave2" if "wave2" in labels else ("wave1" if "wave1" in labels else "?")
        track = next((l.split(":", 1)[1] for l in labels if l.startswith("track:")), "?")
        bb = (it.get("blockedBy") or {}).get("nodes", [])
        issues[it["number"]] = {
            "number": it["number"],
            "key": m.group(1) if m else str(it["number"]),
            "title": it.get("title", ""),
            "state": (it.get("state") or "").upper(),
            "assigned": len(it.get("assignees", [])) > 0,
            "wave": wave, "track": track,
            "blocked_by": [(n["number"], (n.get("state") or "").upper()) for n in bb],
            "blocking": [n["number"] for n in (it.get("blocking") or {}).get("nodes", [])],
            "failed": bool(labels & fl),
        }
    return issues


def classify(it):
    """派生状态(GitHub 只有 open/closed,其余由 label/assignee/依赖推导)。优先级有序。"""
    if it["state"] == "CLOSED":
        return "done"
    if it["failed"]:
        return "failed"
    if any(st == "OPEN" for _, st in it["blocked_by"]):
        return "blocked"
    if it["assigned"]:
        return "in_progress"
    return "ready"


def snapshot(issues):
    return {n: classify(it) for n, it in issues.items()}


def _counts(items):
    c = {s: 0 for s in STATUSES}
    for it in items:
        c[classify(it)] += 1
    c["total"] = len(items)
    c["percent"] = round(100 * c["done"] / c["total"]) if items else 0
    return c


def longest_open_chain(issues):
    """最长未完成依赖链(沿 blocking 方向)——给"全局推进脊柱"提示。"""
    memo = {}

    def dfs(n):
        if n in memo:
            return memo[n]
        if issues[n]["state"] == "CLOSED":
            memo[n] = []
            return []
        best = []
        for s in issues[n]["blocking"]:
            if s in issues and issues[s]["state"] != "CLOSED":
                r = dfs(s)
                if len(r) > len(best):
                    best = r
        memo[n] = [n] + best
        return memo[n]

    best = []
    for n in issues:
        if issues[n]["state"] == "CLOSED":
            continue
        r = dfs(n)
        if len(r) > len(best):
            best = r
    return [issues[n]["key"] for n in best]


def digest(issues, prev_snap):
    cur = snapshot(issues)
    transitions = [
        {"number": n, "key": issues[n]["key"], "from": prev_snap[n], "to": st}
        for n, st in cur.items() if n in prev_snap and prev_snap[n] != st
    ]
    items = list(issues.values())
    by_track, by_wave = {}, {}
    for it in items:
        by_track.setdefault(it["track"], []).append(it)
        by_wave.setdefault(it["wave"], []).append(it)
    brief = lambda it: {"number": it["number"], "key": it["key"], "title": it["title"]}
    overall = _counts(items)
    open_count = sum(1 for it in items if it["state"] == "OPEN")
    actionable = overall["ready"] + overall["in_progress"]
    return {
        "overall": overall,
        "by_track": {k: _counts(v) for k, v in sorted(by_track.items())},
        "by_wave": {k: _counts(v) for k, v in sorted(by_wave.items())},
        "frontier": {
            "ready": [brief(it) for it in items if classify(it) == "ready"],
            "in_progress": [brief(it) for it in items if classify(it) == "in_progress"],
        },
        "failures": [brief(it) for it in items if classify(it) == "failed"],
        "transitions": transitions,
        "critical_path": longest_open_chain(issues),
        "open_count": open_count,
        "all_done": open_count == 0 and len(items) > 0,
        "deadlock": open_count > 0 and actionable == 0,
    }


def decide(d, changed, elapsed, timeout, has_ready_hook):
    """据 digest 决定返回原因与退出码。顺序即优先级——把特殊情况收敛成有序判定。"""
    if d["all_done"]:
        return ("ALL_DONE", 30)
    if d["failures"]:
        return ("NEEDS_DECISION", 20)
    if d["deadlock"]:
        return ("NEEDS_DECISION", 20)
    if d["overall"]["ready"] > 0 and not has_ready_hook:
        return ("DISPATCH", 25)          # 有空闲可领取的活,叫 agent 去派,别空等
    if changed:
        return ("CHANGED", 0)
    if elapsed >= timeout:
        return ("TIMEOUT", 10)           # 只有"全在跑、无变化"才会走到这
    return (None, None)

# ----------------------------- 状态持久化 / 渲染 -----------------------------

def load_state(path):
    try:
        with open(path) as f:
            return {int(k): v for k, v in json.load(f).items()}
    except Exception:
        return {}


def save_state(path, snap):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(snap, f)


def render(d, reason):
    o = d["overall"]
    L = [f"== orchestrate: {reason} ==",
         f"总进度 {o['done']}/{o['total']} done ({o['percent']}%) | "
         f"in_progress {o['in_progress']} · ready {o['ready']} · blocked {o['blocked']} · failed {o['failed']}",
         "分 track:"]
    for k, c in d["by_track"].items():
        L.append(f"  {k:8} {c['done']}/{c['total']} ✓  ip{c['in_progress']} rd{c['ready']} bl{c['blocked']} fa{c['failed']}")
    if d["transitions"]:
        L.append("自上次以来变化:")
        L += [f"  #{t['number']} {t['key']}: {t['from']} → {t['to']}" for t in d["transitions"]]
    if d["frontier"]["ready"]:
        L.append("现在可领取(ready):")
        L += [f"  #{r['number']} {r['key']} {r['title']}" for r in d["frontier"]["ready"]]
    if d["frontier"]["in_progress"]:
        L.append("进行中(in_progress):")
        L += [f"  #{r['number']} {r['key']}" for r in d["frontier"]["in_progress"]]
    if d["failures"]:
        L.append("⚠️ 失败/待决策:")
        L += [f"  #{r['number']} {r['key']} {r['title']}" for r in d["failures"]]
    if d["critical_path"]:
        L.append("关键路径(最长未完成链): " + " → ".join(d["critical_path"]))
    if d["deadlock"]:
        L.append("⛔ 死锁:有 open issue 但无可领取、无进行中——需补依赖/补 issue/解阻塞")
    if d["all_done"]:
        L.append("🎉 全部完成")
    return "\n".join(L)


def emit(d, reason, as_json):
    if as_json:
        print(json.dumps({"reason": reason, **d}, ensure_ascii=False))
    else:
        print(render(d, reason))

# ----------------------------- 钩子(可选,机械派发) -----------------------------

def fire(cmd, it):
    env = dict(os.environ, ISSUE_NUMBER=str(it["number"]), ISSUE_KEY=it["key"],
               ISSUE_TITLE=it["title"])
    subprocess.run(cmd, shell=True, env=env)

# ----------------------------- CLI -----------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="多 Agent 并行开发中轴命令")
    ap.add_argument("mode", choices=["status", "tick"])
    ap.add_argument("-R", "--repo", default=os.environ.get("ORCH_REPO", "xiaohei-info/aiteam"))
    ap.add_argument("--scope-label", action="append", default=None, help="纳入统计的 label(默认 wave1,wave2)")
    ap.add_argument("--failed-label", action="append", default=None, help="标记失败的 label(默认 failed)")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--interval", type=int, default=20)
    ap.add_argument("--state", default=os.path.join(os.path.dirname(__file__), ".tick-state.json"))
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON digest")
    ap.add_argument("--on-ready", default=None, help="对每个 ready issue 执行的派发命令(置则不再返回 DISPATCH)")
    ap.add_argument("--on-failed", default=None, help="对每个 failed issue 执行的命令")
    a = ap.parse_args(argv)
    scope = a.scope_label or ["wave1", "wave2"]
    failed = a.failed_label or ["failed"]

    prev = load_state(a.state)

    if a.mode == "status":
        issues = normalize(gh_fetch(a.repo), scope, failed)
        d = digest(issues, prev)
        emit(d, "STATUS", a.json)
        save_state(a.state, snapshot(issues))
        return 0

    # tick: 阻塞推进
    start, fired, t0 = None, set(), time.time()
    while True:
        issues = normalize(gh_fetch(a.repo), scope, failed)
        cur = snapshot(issues)
        if start is None:
            start = cur
        d = digest(issues, prev)
        # 机械钩子(幂等:每个 issue 本次调用只触发一次)
        for it in issues.values():
            st = classify(it)
            if st == "ready" and a.on_ready and it["number"] not in fired:
                fire(a.on_ready, it); fired.add(it["number"])
            if st == "failed" and a.on_failed and it["number"] not in fired:
                fire(a.on_failed, it); fired.add(it["number"])
        reason, code = decide(d, cur != start, time.time() - t0, a.timeout, bool(a.on_ready))
        if reason:
            emit(d, reason, a.json)
            save_state(a.state, cur)
            return code
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
