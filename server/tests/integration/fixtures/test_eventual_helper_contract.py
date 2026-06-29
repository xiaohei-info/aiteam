"""P1-F4 契约：最终一致性等待窗口 helper（纯逻辑，无 PG，默认门即跑）。

锁住 closeout DAG P1-F4 blocking：统一四档窗口；私自定义窗口拒绝；超时不得标 pass。
"""

from __future__ import annotations

import pytest

from tests.integration.fixtures.eventual import (
    ALLOWED_WINDOWS,
    ConditionTimeout,
    WaitWindow,
    wait_for_condition,
)


class FakeClock:
    """假时钟：sleep 推进时间，wait_for_condition 不真实阻塞。"""

    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, dt: float) -> None:
        self.t += dt


def test_windows_are_exactly_the_four_canonical_values():
    assert ALLOWED_WINDOWS == {30, 60, 120, 300}
    assert [int(w) for w in WaitWindow] == [30, 60, 120, 300]


def test_returns_truthy_predicate_value_immediately():
    clock = FakeClock()
    calls = {"n": 0}

    def predicate():
        calls["n"] += 1
        return {"row": 1}

    result = wait_for_condition(
        predicate, WaitWindow.BOOTSTRAP, now=clock.now, sleep=clock.sleep
    )
    assert result == {"row": 1}
    assert calls["n"] == 1  # 首次即真，不进 sleep
    assert clock.t == 0


def test_succeeds_after_some_polls():
    clock = FakeClock()
    calls = {"n": 0}

    def predicate():
        calls["n"] += 1
        return calls["n"] >= 4  # 第 4 次才真

    result = wait_for_condition(
        predicate, WaitWindow.BOOTSTRAP, interval=2.0, now=clock.now, sleep=clock.sleep
    )
    assert result is True
    assert calls["n"] == 4
    assert clock.t == pytest.approx(6.0)  # 3 次 sleep * 2s


def test_timeout_raises_and_never_marks_pass():
    clock = FakeClock()

    def never():
        return False

    with pytest.raises(ConditionTimeout) as exc:
        wait_for_condition(
            never, WaitWindow.BOOTSTRAP, interval=5.0, reason="bootstrap 未完成",
            now=clock.now, sleep=clock.sleep,
        )
    assert exc.value.window == 30
    assert exc.value.waited >= 30
    assert "bootstrap 未完成" in str(exc.value)


def test_sleep_never_overshoots_window_boundary():
    clock = FakeClock()
    sleeps: list[float] = []

    def rec_sleep(dt):
        sleeps.append(dt)
        clock.sleep(dt)

    with pytest.raises(ConditionTimeout):
        wait_for_condition(
            lambda: False, WaitWindow.BOOTSTRAP, interval=7.0,
            now=clock.now, sleep=rec_sleep,
        )
    # 总 sleep 不超过窗口；最后一次被裁剪到边界。
    assert sum(sleeps) <= 30 + 1e-9
    assert max(sleeps) <= 7.0


@pytest.mark.parametrize("bad", [1, 45, 90, 0, 301])
def test_non_canonical_window_rejected(bad):
    with pytest.raises(ValueError, match="统一等待窗口"):
        wait_for_condition(lambda: True, bad)


def test_nonpositive_interval_rejected():
    with pytest.raises(ValueError, match="interval"):
        wait_for_condition(lambda: True, WaitWindow.BOOTSTRAP, interval=0)


def test_accepts_plain_int_window():
    assert wait_for_condition(lambda: "ok", 300) == "ok"
