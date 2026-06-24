# failure.py — worker 失败可恢复性判定（纯函数，无引擎依赖）

# 不可恢复故障的关键词：worker 自身挂了，换个 worker 才能继续，重试同一个无意义
UNRECOVERABLE_KEYWORDS = [
    # 额度 / 余额 / 计费
    "quota", "balance", "insufficient", "credit", "billing", "payment",
    "配额", "额度", "余额", "欠费",
    # 限流（短期不可恢复，且常与额度耗尽同源）
    "rate limit", "rate_limit", "too many requests", "429",
    # 进程 / 运行时崩溃
    "crash", "崩溃", "out of memory", "oom", "killed", "segfault",
    # 鉴权失效（凭据废了，重试无意义）
    "unauthorized", "forbidden", "invalid api key", "authentication failed",
    "401", "403",
]


def is_unrecoverable(failure_reason: str | None) -> bool:
    """判断失败原因是否属于 worker 不可恢复故障。

    命中即认为"换 worker 才有用"——引擎据此挂起节点、隔离该 worker、等 leader 改派。
    取不到原因（None/空）时返回 False，交由连续失败计数兜底。
    """
    if not failure_reason:
        return False
    text = failure_reason.lower()
    return any(kw in text for kw in UNRECOVERABLE_KEYWORDS)
