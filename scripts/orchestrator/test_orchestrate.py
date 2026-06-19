#!/usr/bin/env python3
"""orchestrate.py 纯逻辑测试(离线,不连 GitHub)。直接 `python3 test_orchestrate.py`。"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
import orchestrate as O


def mk(number, *, key="X", state="OPEN", assigned=False, blocked_by=None,
       blocking=None, failed=False, wave="wave1", track="M"):
    return {"number": number, "key": key, "title": f"[{key}] t{number}", "state": state,
            "assigned": assigned, "wave": wave, "track": track,
            "blocked_by": blocked_by or [], "blocking": blocking or [], "failed": failed}


def test_classify():
    assert O.classify(mk(1, state="CLOSED")) == "done"
    assert O.classify(mk(2, failed=True)) == "failed"
    assert O.classify(mk(3, failed=True, assigned=True)) == "failed"          # failed 优先于 in_progress
    assert O.classify(mk(4, blocked_by=[(1, "OPEN")])) == "blocked"
    assert O.classify(mk(5, blocked_by=[(1, "CLOSED")])) == "ready"           # 阻塞者已关 → 解锁
    assert O.classify(mk(6, assigned=True)) == "in_progress"
    assert O.classify(mk(7)) == "ready"


def test_normalize_scope_and_parse():
    raw = [
        {"number": 31, "title": "[M0] 租户底座", "state": "OPEN", "assignees": [],
         "labels": [{"name": "wave1"}, {"name": "track:M"}, {"name": "foundation"}],
         "blockedBy": {"nodes": []}, "blocking": {"nodes": [{"number": 35}]}},
        {"number": 99, "title": "无关 issue", "state": "OPEN", "assignees": [],
         "labels": [{"name": "bug"}], "blockedBy": {"nodes": []}, "blocking": {"nodes": []}},
        {"number": 35, "title": "[M1] 授权", "state": "OPEN",
         "assignees": [{"login": "x"}],
         "labels": [{"name": "wave1"}, {"name": "track:M"}],
         "blockedBy": {"nodes": [{"number": 31, "state": "OPEN"}]}, "blocking": {"nodes": []}},
    ]
    issues = O.normalize(raw, ["wave1", "wave2"], ["failed"])
    assert set(issues) == {31, 35}                       # 99 无 scope label 被过滤
    assert issues[31]["key"] == "M0" and issues[31]["track"] == "M" and issues[31]["wave"] == "wave1"
    assert issues[35]["assigned"] is True
    assert issues[35]["blocked_by"] == [(31, "OPEN")]
    assert O.classify(issues[31]) == "ready" and O.classify(issues[35]) == "blocked"


def test_digest_counts_and_transitions():
    issues = {
        1: mk(1, key="A0", state="CLOSED", track="A"),
        2: mk(2, key="A1", assigned=True, track="A"),
        3: mk(3, key="A2", blocked_by=[(2, "OPEN")], track="A"),
        4: mk(4, key="M0", track="M"),
    }
    d = O.digest(issues, prev_snap={2: "ready"})         # #2 上次是 ready,现在 in_progress
    assert d["overall"] == {"done": 1, "in_progress": 1, "ready": 1, "blocked": 1,
                            "failed": 0, "total": 4, "percent": 25}
    assert d["by_track"]["A"]["total"] == 3 and d["by_track"]["A"]["done"] == 1
    assert d["transitions"] == [{"number": 2, "key": "A1", "from": "ready", "to": "in_progress"}]
    assert {r["number"] for r in d["frontier"]["ready"]} == {4}
    assert d["all_done"] is False and d["deadlock"] is False


def test_longest_open_chain():
    # M0 → M1 → M2(链长3),M0 → M3(链长2);最长应为 M0,M1,M2
    issues = {
        1: mk(1, key="M0", blocking=[2, 4]),
        2: mk(2, key="M1", blocked_by=[(1, "OPEN")], blocking=[3]),
        3: mk(3, key="M2", blocked_by=[(2, "OPEN")]),
        4: mk(4, key="M3", blocked_by=[(1, "OPEN")]),
    }
    assert O.longest_open_chain(issues) == ["M0", "M1", "M2"]


def _d(issues, prev=None):
    return O.digest(issues, prev or {})


def test_decide_all_done():
    d = _d({1: mk(1, state="CLOSED")})
    assert O.decide(d, False, 0, 600, False) == ("ALL_DONE", 30)


def test_decide_failure():
    d = _d({1: mk(1, failed=True), 2: mk(2, assigned=True)})
    assert O.decide(d, False, 0, 600, False) == ("NEEDS_DECISION", 20)


def test_decide_deadlock():
    # 仅剩一个 open 且被一个 open(但不在统计内)阻塞 → 无可领取无进行中
    d = _d({1: mk(1, blocked_by=[(999, "OPEN")])})
    assert d["deadlock"] is True
    assert O.decide(d, False, 0, 600, False) == ("NEEDS_DECISION", 20)


def test_decide_dispatch_vs_hook():
    d = _d({1: mk(1)})                                    # 一个 ready
    assert O.decide(d, False, 0, 600, has_ready_hook=False) == ("DISPATCH", 25)
    # 有派发钩子时不返回 DISPATCH;无变化未超时 → 继续等
    assert O.decide(d, False, 0, 600, has_ready_hook=True) == (None, None)


def test_decide_changed_and_timeout():
    d = _d({1: mk(1, assigned=True)})                     # in_progress,无 ready
    assert O.decide(d, True, 0, 600, False) == ("CHANGED", 0)
    assert O.decide(d, False, 600, 600, False) == ("TIMEOUT", 10)
    assert O.decide(d, False, 5, 600, False) == (None, None)   # 仍在等


def run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t(); print(f"  ✓ {t.__name__}")
    print(f"\n{len(tests)} passed")


if __name__ == "__main__":
    run()
