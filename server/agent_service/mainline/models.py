"""本地主链领域模型（A1 / 07 §8）。

会话主状态用固定枚举 `ConversationState`（draft|active|paused|muted|archived）。
展示态 `DisplayState`（streaming/waiting_reply/...）**绝不作为持久化字段**（D6）——
它只在运行态/流里出现（见 stream.py），主状态模型里不存在它。

Run 终态用本地执行口径（completed|cancelled|failed），与展示态正交：终态是"这次 run
结束了吗、结果如何"的持久事实，展示态是"对话页此刻怎么渲染"的瞬时镜像。
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.enums import ConversationState


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MessageRole(str, Enum):
    """消息发出方。用户/员工（专家）/系统提示。"""

    USER = "user"
    EMPLOYEE = "employee"
    SYSTEM = "system"


class RunStatus(str, Enum):
    """Run 持久化终态（本地执行口径，07 §8）。

    非展示态：这些是"这次执行的事实结果"。running 为进行中，其余为终态。
    与 MVP 终态口径对齐：completed / interrupted-by-user / errored -> 收敛为
    completed / cancelled / failed（v1 产品级三态，去掉 MVP 的 crash 细分）。
    """

    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class TaskStatus(str, Enum):
    """Task 状态（私聊场景下 run 的业务封装；群聊/Loop 的复杂编排不在本卡）。"""

    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Conversation(BaseModel):
    """本地会话。主状态固定枚举；**无展示态字段**（D6）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str | None = None
    state: ConversationState = ConversationState.ACTIVE
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Message(BaseModel):
    """会话内一条消息（本地落库，绝不上传）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    conversation_id: str
    role: MessageRole
    content: str
    created_at: datetime = Field(default_factory=_now)


class Run(BaseModel):
    """一次运行实例。status 为持久终态；展示态不在此。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    conversation_id: str
    status: RunStatus = RunStatus.RUNNING
    session_id: str | None = None
    error: str | None = None
    usage: dict | None = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class Task(BaseModel):
    """Run 的业务封装（绑定一次 run 的产物/状态）。"""

    model_config = ConfigDict(extra="forbid")

    id: str
    conversation_id: str
    run_id: str | None = None
    title: str
    status: TaskStatus = TaskStatus.PENDING
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
