"""本地 usage/审计原始事件模型（A5，仅本地，绝不出网）。

这些是用户端本地累积的**原始**事件——可能携带会话上下文等敏感物。它们**只进聚合器**，
聚合器只读取计量/审计字段产出脱敏摘要；原始事件本身永不构成上报 payload（D13）。

raw usage 的 `usage` 字段沿用 Gateway/Driver 提取的自由 dict（input_tokens/output_tokens/
total_tokens/cost 等，各 runtime 不一），聚合器按已知键归一为 token_total/cost_total。
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RawUsageEvent(BaseModel):
    """一次 run 的本地原始计量事件（本地累积，不出网）。

    extra="allow"：原始事件可能夹带 runtime 透传的额外字段（含会话上下文）；这是**本地**
    模型，刻意宽松。聚合器只取白名单计量字段，绝不把额外字段带进摘要——脱敏的护栏在聚合器，
    不在这里。
    """

    model_config = ConfigDict(extra="allow")

    run_id: str
    employee_id: str | None = None
    usage: dict = Field(default_factory=dict, description="Driver 提取的自由计量 dict")
    error: bool = False
    duration_seconds: int = 0
    occurred_at: datetime = Field(default_factory=_now)


class RawAuditEvent(BaseModel):
    """本地关键审计原始事件（招募装载/登录/授权变更/越权尝试）。

    只承载审计骨架字段；resource/actor 为标识符，不含会话内容。同样 extra="allow" 容忍
    本地透传，聚合器只取审计白名单字段。
    """

    model_config = ConfigDict(extra="allow")

    actor: str
    action: str = Field(description="expert_load | login | grant_change | unauthorized_attempt ...")
    resource_type: str | None = None
    resource_id: str | None = None
    occurred_at: datetime = Field(default_factory=_now)


# ---- 计量字段白名单（脱敏护栏的单一真相）----

# token 计量已知键：不同 runtime 命名不一，全部归一进 token_total。
_TOKEN_KEYS = (
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
)

# cost 计量已知键。
_COST_KEYS = ("cost", "cost_total", "total_cost")


def extract_token_total(usage: dict) -> int:
    """从自由 usage dict 归一出 token 总数。

    优先用 total_tokens；缺失时回退 input+output（或 prompt+completion）求和。只读数值，
    任何非数值/文本键一律忽略——这是脱敏的关键：不存在"把会话文本算进 token"的路径。
    """
    if (total := _coerce_int(usage.get("total_tokens"))) is not None:
        return total
    parts = [
        _coerce_int(usage.get("input_tokens")) or _coerce_int(usage.get("prompt_tokens")),
        _coerce_int(usage.get("output_tokens")) or _coerce_int(usage.get("completion_tokens")),
    ]
    return sum(p for p in parts if p is not None)


def extract_cost_total(usage: dict) -> Decimal:
    """从自由 usage dict 归一出成本（Decimal，禁 float 累加误差，02 §10.3.5）。"""
    for key in _COST_KEYS:
        if (value := _coerce_decimal(usage.get(key))) is not None:
            return value
    return Decimal("0")


def _coerce_int(value: object) -> int | None:
    if isinstance(value, bool):  # bool 是 int 子类，显式排除
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _coerce_decimal(value: object) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, Decimal)):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value)
        except Exception:  # noqa: BLE001
            return None
    return None
