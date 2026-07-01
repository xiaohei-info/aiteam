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


class RunTriggerType(str, Enum):
    """本次 run 的触发来源（#283 完整生命周期）。

    对齐 enterprise 侧 TeamRun.trigger_type，保持产品语义一致。
    """

    PRIVATE_MESSAGE = "private_message"
    GROUP_MESSAGE = "group_message"
    MANUAL_RUN = "manual_run"
    SCHEDULED_JOB = "scheduled_job"
    API_CALL = "api_call"


class RunExecutionMode(str, Enum):
    """本次 run 的执行模式（#283 完整生命周期）。

    对齐 enterprise 侧 TeamRun.execution_mode，保持产品语义一致。
    """

    SINGLE_AGENT = "single_agent"
    KANBAN_ORCHESTRATION = "kanban_orchestration"
    CRON_SINGLE_AGENT = "cron_single_agent"


class RunStatus(str, Enum):
    """Run 持久化主状态（#283 完整生命周期，本地执行口径 07 §8）。

    进行中（左→右）: queued | routing | submitting | running | waiting_human；
    终态（不可再流转）: succeeded | failed | cancelled。
    """

    QUEUED = "queued"
    ROUTING = "routing"
    SUBMITTING = "submitting"
    RUNNING = "running"
    WAITING_HUMAN = "waiting_human"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class TaskStatus(str, Enum):
    """Task 状态（私聊场景下 run 的业务封装；群聊/Loop 的复杂编排不在本卡）。"""

    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Conversation(BaseModel):
    """本地会话。主状态固定枚举；**无展示态字段**（D6）。

    协作编排口径（parity Manager侧 app/team_panel Conversation）：
    - collaboration_mode: "free" 自由讨论（@提及驱动）| "orchestrated" 规则编排（planner 按
      orchestration_brief 拆解后分配专家 + 聚合）。私聊/默认 = free。
    - orchestration_brief: 编排指令，orchestrated 模式下注入 planner 拆解提示词。
    - planner_employee_id: 指定编排者（roster 内 handle）；空则运行时自动选一非专家做 planner。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str | None = None
    state: ConversationState = ConversationState.ACTIVE
    collaboration_mode: str = Field(default="free", description="free | orchestrated")
    orchestration_brief: str = Field(default="", description="orchestrated 模式下的 planner 编排指令")
    planner_employee_id: str | None = Field(default=None, description="指定编排者 roster handle")
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
    """一次运行实例。

    status 为持久终态；trigger_type / execution_mode 记录本次 run 的触发来源与执行模式
    （#283）。展示态不在此。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    conversation_id: str
    status: RunStatus = RunStatus.QUEUED
    trigger_type: RunTriggerType = RunTriggerType.MANUAL_RUN
    execution_mode: RunExecutionMode = RunExecutionMode.SINGLE_AGENT
    session_id: str | None = None
    error: str | None = None
    usage: dict | None = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

    # ── 生命周期状态流转（#283） ──────────────────────────────────────

    _TERMINAL = frozenset({RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED})

    def start_routing(self) -> None:
        if self.status != RunStatus.QUEUED:
            raise ValueError(f"Cannot start routing from {self.status}; must be queued")
        self.status = RunStatus.ROUTING

    def submit(self) -> None:
        if self.status != RunStatus.ROUTING:
            raise ValueError(f"Cannot submit from {self.status}; must be routing")
        self.status = RunStatus.SUBMITTING

    def start_running(self) -> None:
        if self.status not in (RunStatus.SUBMITTING, RunStatus.WAITING_HUMAN):
            raise ValueError(f"Cannot start running from {self.status}; must be submitting or waiting_human")
        self.status = RunStatus.RUNNING

    def wait_for_human(self) -> None:
        if self.status != RunStatus.RUNNING:
            raise ValueError(f"Cannot wait_for_human from {self.status}; must be running")
        self.status = RunStatus.WAITING_HUMAN

    def mark_succeeded(self) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot mark succeeded from {self.status}; already terminal")
        self.status = RunStatus.SUCCEEDED

    def mark_failed(self, error: str = "") -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot mark failed from {self.status}; already terminal")
        self.status = RunStatus.FAILED
        if error:
            self.error = error

    def cancel(self) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot cancel from {self.status}; already terminal")
        self.status = RunStatus.CANCELLED

    def is_terminal(self) -> bool:
        return self.status in self._TERMINAL

    def is_runnable(self) -> bool:
        return self.status not in self._TERMINAL


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
