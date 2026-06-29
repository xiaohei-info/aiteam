"""事件双层模型（06 §7.1 / 07 §8，D6）。

1. AgentRuntimeEvent：Gateway 内部归一事件，面向 runtime，**不直接暴露前端**。
2. BusinessTimelineEvent：Agent Service 对前端暴露，沿用 `event: timeline` 协议 + numeric cursor。

映射链路：runtime raw -> Driver.parse -> AgentRuntimeEvent -> Agent event mapper
-> BusinessTimelineEvent -> SSE/WebSocket/history。

铁律：前端不消费 runtime-native event；raw event 仅用户端本地脱敏归档（D6）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# AgentRuntimeEvent 的事件类型最小集合（06 §7.1）。Driver 必须把原始事件归一到该集合，
# 新增类型属修改共享口径，需评审。
RuntimeEventType = Literal[
    "status",
    "text_delta",
    "reasoning_delta",
    "tool_call_started",
    "tool_call_completed",
    "command_started",
    "command_output",
    "file_operation",
    "usage",
    "artifact",
    "error",
    "completed",
    "cancelled",
]


class AgentRuntimeEvent(BaseModel):
    """Gateway 内部统一运行事件（06 §7.1）。不暴露 runtime 原生事件名。"""

    model_config = ConfigDict(extra="forbid")

    event_id: str
    run_id: str
    seq: int = Field(description="单 run 内单调递增序号")
    type: RuntimeEventType
    source: str = Field(description="产生该事件的 runtime/driver 标识")
    timestamp: datetime
    payload: dict = Field(default_factory=dict, description="事件载荷（内容因 event_type 而异）")


class TimelineCursor(BaseModel):
    """对外 numeric cursor（07 §8 / 02 §10.3.7）。禁对外暴露内部 {timestamp}-{sequence}。"""

    model_config = ConfigDict(extra="forbid")

    value: int = Field(description="单调递增的数值游标")


class BusinessTimelineEvent(BaseModel):
    """业务时间线事件（RunTimelineEvent，07 §8）。

    面向对话页/任务树/工具调用/审计回放；沿用现有 `event: timeline` 协议语义，
    具体字段/payload 在各端 OpenAPI 重新定稿（本类型为最小稳定骨架）。
    """

    model_config = ConfigDict(extra="forbid")

    cursor: int = Field(description="numeric cursor，用于分页与增量拉取")
    run_id: str
    conversation_id: str
    type: str = Field(description="产品级事件类型（由 runtime 事件映射而来）")
    payload: dict = Field(default_factory=dict, description="已脱敏的产品展示载荷")
    created_at: datetime
