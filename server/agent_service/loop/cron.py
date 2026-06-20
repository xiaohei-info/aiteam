"""cron 表达式匹配器（A3 / 06 §7.6，runtime 无关、非 hermes cron）。

仅 5 字段标准 cron（分 时 日 月 周），用最小必要实现——不引第三方依赖（requirements 不含
croniter/apscheduler，自造底层被 CLAUDE/AGENTS §3.1 禁止，但 cron 解析属"窄领域纯函数"，
自包含单文件实现优于引入新依赖；边界用清晰数据结构消除分支）。

支持：
- 数字（含 0）：单值
- `*`：该字段任意值
- `*/N`：步长（从字段最小值起，N 整除）
- `A-B`：闭区间
- `A-B/N`：区间内步长
- `A,B,C`：列表（每项可再是上述任一）

不支持：命名月份/星期、`L`/`W`/`#` 等扩展语法、秒级、年字段（这些是 Quartz/Quartz-like 扩展，
非标准 5 字段 cron，本卡不需要）。

字段范围（POSIX）：
    minute  0-59
    hour    0-23
    day     1-31
    month   1-12
    weekday 0-6（0=Sunday）

到点判定（match）：给定时间是否落在五字段的交集。不做"下一次触发"预测——调度器用 tick
扫每一分钟判定，避免边界预测的复杂度（详见 scheduler.py）。
"""

from __future__ import annotations

from dataclasses import dataclass

_WEEKDAY_FIELD_INDEX = 4  # weekday 是第 5 个字段（0-based index 4）


@dataclass(frozen=True)
class _FieldRange:
    min: int
    max: int


_FIELD_RANGES = (
    _FieldRange(0, 59),   # minute
    _FieldRange(0, 23),   # hour
    _FieldRange(1, 31),   # day-of-month
    _FieldRange(1, 12),   # month
    _FieldRange(0, 6),    # weekday (0=Sunday)
)


class CronError(ValueError):
    """cron 表达式非法。"""


def parse_cron(expr: str) -> tuple[frozenset[int], frozenset[int], frozenset[int],
                                   frozenset[int], frozenset[int]]:
    """解析 5 字段 cron -> 五个 frozenset[int]（各自命中集合）。

    抛 CronError：字段数 != 5、越界、非法语法。
    """
    parts = expr.split()
    if len(parts) != 5:
        raise CronError(f"cron 须 5 字段，得到 {len(parts)}: {expr!r}")
    fields: list[frozenset[int]] = []
    for raw, rng in zip(parts, _FIELD_RANGES):
        fields.append(_parse_field(raw, rng))
    return tuple(fields)  # type: ignore[return-value]


def match_cron(parsed, dt) -> bool:
    """给定 datetime 是否命中已解析的 cron（按其本地/naive 字段判定，不做时区换算）。

    weekday：Python datetime.weekday() 返回 0=Monday..6=Sunday；cron 用 0=Sunday。
    转换：cron_w = (dt.weekday() + 1) % 7。
    """
    minute, hour, day, month, weekday = parsed
    cron_wday = (dt.weekday() + 1) % 7
    return (
        dt.minute in minute
        and dt.hour in hour
        and dt.day in day
        and dt.month in month
        and cron_wday in weekday
    )


def _parse_field(raw: str, rng: _FieldRange) -> frozenset[int]:
    """解析单字段为命中集合。逗号分隔的列表，每项可含步长/区间。"""
    out: set[int] = set()
    for item in raw.split(","):
        out |= _parse_item(item.strip(), rng)
    if not out:
        raise CronError(f"字段为空: {raw!r}")
    return frozenset(out)


def _parse_item(item: str, rng: _FieldRange) -> set[int]:
    if item == "*":
        return set(range(rng.min, rng.max + 1))
    if "/" in item:
        base, step_s = item.split("/", 1)
        try:
            step = int(step_s)
        except ValueError as exc:
            raise CronError(f"非法步长: {item!r}") from exc
        if step <= 0:
            raise CronError(f"步长须 >0: {item!r}")
        lo, hi = _parse_range(base, rng)
        return set(range(lo, hi + 1, step))
    lo, hi = _parse_range(item, rng)
    return set(range(lo, hi + 1))


def _parse_range(base: str, rng: _FieldRange) -> tuple[int, int]:
    """把 `A` / `A-B` / `*` 解析为 (lo, hi) 闭区间。"""
    if base == "*" or base == "":
        return rng.min, rng.max
    if "-" in base:
        a, b = base.split("-", 1)
        lo, hi = _to_int(a, rng), _to_int(b, rng)
    else:
        lo = hi = _to_int(base, rng)
    if lo > hi or lo < rng.min or hi > rng.max:
        raise CronError(f"区间越界: {base!r} (字段范围 {rng.min}-{rng.max})")
    return lo, hi


def _to_int(token: str, rng: _FieldRange) -> int:
    if token == "*" or token == "":
        return rng.min
    try:
        v = int(token)
    except ValueError as exc:
        raise CronError(f"非法数值: {token!r}") from exc
    if v < rng.min or v > rng.max:
        raise CronError(f"数值越界: {v} (字段范围 {rng.min}-{rng.max})")
    return v
