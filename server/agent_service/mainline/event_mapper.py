"""事件归一映射：AgentRuntimeEvent -> BusinessTimelineEvent（A1 / 07 §8）。

映射链路（07 §8）：
    runtime raw -> Driver.parse -> AgentRuntimeEvent -> [本模块] -> BusinessTimelineEvent
                -> SSE / WebSocket / history

铁律：前端**只**消费 BusinessTimelineEvent，绝不见 runtime-native 事件名（D6）。本模块是
runtime 事件类型到产品事件类型的**唯一翻译点**（在 Agent Service 侧；Driver 是 runtime->归一
的翻译点）。映射用纯 dict 查表，不堆 if 分支（好品味：消除特殊情况）。

cursor 不在本模块产生——由 TimelineStore 在追加时分配单调 numeric cursor（见 timeline.py），
避免"映射器需要知道全局序号"的耦合。这里返回 cursor=占位 0，落库时由 store 重写。
"""

from __future__ import annotations

from shared.contracts.events import AgentRuntimeEvent, BusinessTimelineEvent

# runtime 归一事件类型 -> 产品级时间线事件类型（07 §8）。
# 终态三类（run_succeeded/run_cancelled/run_failed）由 TERMINAL_TYPES 标识，供服务层据此
# 落 Run 终态（completed/cancelled/failed）并结束 SSE 流——parity MVP done/cancel/error 终态。
_RUNTIME_TO_BUSINESS: dict[str, str] = {
    "status": "status",
    "text_delta": "message_delta",
    "reasoning_delta": "reasoning_delta",
    "tool_call_started": "tool_call_started",
    "tool_call_completed": "tool_call_completed",
    "command_started": "command_started",
    "command_output": "command_output",
    "file_operation": "file_operation",
    "usage": "usage",
    "artifact": "artifact",
    "error": "run_failed",
    "completed": "run_succeeded",
    "cancelled": "run_cancelled",
}

# 产品级终态事件类型（标志一次 run 结束）。
TERMINAL_TYPES: frozenset[str] = frozenset({"run_succeeded", "run_cancelled", "run_failed"})


def business_type_for(runtime_type: str) -> str:
    """runtime 归一类型 -> 产品类型；未知类型即契约漂移，显式报错（不静默直通原生名）。"""
    try:
        return _RUNTIME_TO_BUSINESS[runtime_type]
    except KeyError as exc:  # pragma: no cover - 守卫契约漂移
        raise ValueError(f"未知 runtime 事件类型 {runtime_type!r}，不允许外泄前端") from exc


def map_runtime_event(event: AgentRuntimeEvent, *, conversation_id: str) -> BusinessTimelineEvent:
    """把一条 Gateway 归一事件映射为对外业务时间线事件。

    cursor 此处置 0，真正的单调游标由 TimelineStore.append 分配（见 timeline.py）。
    payload 直接透传（已是 Driver 归一后的脱敏载荷，不含 runtime 原生结构）。
    """
    return BusinessTimelineEvent(
        cursor=0,
        run_id=event.run_id,
        conversation_id=conversation_id,
        type=business_type_for(event.type),
        payload=dict(event.payload),
        created_at=event.timestamp,
    )


def is_terminal(business_type: str) -> bool:
    return business_type in TERMINAL_TYPES
