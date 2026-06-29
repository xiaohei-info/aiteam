"""P1-F4 最终一致性等待窗口 helper（最终执行 DAG §5.1 P1-F4）。

统一三端 Service Integration 的"最终一致"等待口径：窗口只有 30/60/120/300s 四档
（对齐 closeout DAG §2 各闭环等待窗口与合同 §3.1-§3.3）：

- 30s ：tenant/owner bootstrap、grants/authorized config、snapshot version。
- 60s ：solution/recruit/catalog visibility、企业开通链。
- 120s：outbox -> Manager usage/audit、quota/governance。
- 300s：Manager rollup -> Operator board。

铁律（DAG P1-F4 blocking）：
- 各端不得私自定义冲突窗口——非四档窗口直接 ValueError。
- 窗口耗尽仍未满足条件，**一律抛 ConditionTimeout，绝不静默标 pass**。

纯逻辑、无 DB：now/sleep 可注入，测试用假时钟瞬时验证，不真实阻塞。
"""

from __future__ import annotations

import time
from enum import IntEnum
from typing import Callable, TypeVar

T = TypeVar("T")


class WaitWindow(IntEnum):
    """统一最终一致性等待窗口（秒）。唯一允许的四档。

    新增/调整窗口必须改本枚举并在 closeout DAG 写明理由，禁止业务侧硬编码裸秒数。
    """

    BOOTSTRAP = 30
    VISIBILITY = 60
    USAGE_AUDIT = 120
    OPERATOR_ROLLUP = 300


ALLOWED_WINDOWS = frozenset(int(w) for w in WaitWindow)


class ConditionTimeout(TimeoutError):
    """等待窗口耗尽仍未满足条件。

    携带 window/waited/reason 供失败诊断（P1-F7），但本身就是失败信号——
    调用方不得 catch 后标 pass。
    """

    def __init__(self, window: int, waited: float, reason: str | None = None):
        self.window = window
        self.waited = waited
        self.reason = reason
        msg = f"condition not met within {window}s window (waited {waited:.1f}s)"
        if reason:
            msg = f"{msg}: {reason}"
        super().__init__(msg)


def wait_for_condition(
    predicate: Callable[[], T | None],
    window: WaitWindow | int,
    *,
    interval: float = 1.0,
    reason: str | None = None,
    now: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """轮询 predicate 直到返回真值，或窗口耗尽后抛 ConditionTimeout。

    - window 必须是 ALLOWED_WINDOWS 四档之一；否则 ValueError（禁止私自定义窗口）。
    - predicate 返回真值（非 None / 非 False / 非空）即成功，原样返回该值——
      调用方可借此拿到断言所需数据（如查询到的行）。
    - 窗口耗尽仍未满足 -> ConditionTimeout（**不返回、不标 pass**）。
    - now/sleep 可注入（测试用假时钟）；interval 必须 > 0；
      每次 sleep 不越过窗口边界，避免超时判定漂移。
    """
    win = int(window)
    if win not in ALLOWED_WINDOWS:
        raise ValueError(
            f"window {win}s 不在统一等待窗口 {sorted(ALLOWED_WINDOWS)} 内；"
            "禁止私自定义冲突窗口（closeout DAG P1-F4）"
        )
    if interval <= 0:
        raise ValueError("interval must be > 0")

    start = now()
    while True:
        result = predicate()
        if result:
            return result
        waited = now() - start
        if waited >= win:
            raise ConditionTimeout(win, waited, reason)
        sleep(min(interval, win - waited))
