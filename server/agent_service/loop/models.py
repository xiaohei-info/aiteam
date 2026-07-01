"""Loop 本地调度领域模型（A3 / 06 7.6 / D19）。

Loop 是用户端**本地调度器**持有的周期/触发任务（06 7.6，runtime 无关）。每条 loop：
- 绑定一个 ``conversation_id``（run 的事件并入该会话 timeline，复用 A1）。
- 声明重复规则：``recurrence_type``（once/daily/weekly/monthly/cron） +
  ``recurrence_config``（周/日/月等配置）+ ``cron``（cron 类型时使用）。
- 持有一份中立 ``RunSpec`` 模板 + 可选 ``input_template``（每次触发时的消息模板）。
- 持重试策略：``max_retries`` 上限 + 当前 ``retry_count``。
- 到点构造 RunSpec 经 Gateway 执行（复用 A1 MainlineService.start_run）。

红线（06 7.6 / CLAUDE/AGENTS 8）：
- **仅运行期执行**：关机即不跑，不做服务端常驻代跑。调度器状态（next_fire 等）只在进程内
  维护，loop 主状态（status、fire 计数、retry、last_run_id）落本地库。
- **不依赖 hermes cron**：调度由本地调度器进程内驱动，不经 runtime cron。
- **不上传会话内容**：loop 触发的 run 与私聊 run 同构，事件/usage 全落本地（D6）。

LoopStatus 是持久化主状态（fixed enum），非展示态。主状态机：
``active``（调度器可触发）⇄ ``paused``（用户暂停，调度器跳过）；``active`` 经
``complete()`` 进入终态 ``completed``；连续失败达 ``max_retries`` 进入 ``error``，
``clear_error()`` 回到 paused 重新校验。last_run_id / last_fired_at 记录最近一次触发的
run 与触发时刻；retry_count / max_retries 记录失败重试策略。不在 loop 上缓存 run 终态
（终态是 Run 主记录的事实）。

复用旧 app/team_panel/domain/entities.py:ScheduledJob 的口径补齐复杂定时规则 / 执行历史 / 失败重试：
``recurrence_type``（once|daily|weekly|monthly|cron）、``next_run_at``（预览，不落库）、
``max_retries``/``retry_count``、``input_template``、``status``（active|paused|completed|error）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.runspec import RunSpec


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RecurrenceType(str, Enum):
    """重复类型：决定如何解析 ``recurrence_config`` / ``cron`` 以判定到点（06 7.6）。

    once：单次触发（按计划触一次后至 completed）。
    daily / weekly / monthly：按日/周/月重复。
    cron：沿用 5 字段 cron 表达式。
    """

    ONCE = "once"
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    CRON = "cron"


class LoopStatus(str, Enum):
    """Loop 持久化主状态（非展示态，仅可经显式转换迁移）。

    active：可被调度器触发（运行期到点即起 run）。
    paused：用户暂停；调度器跳过、不触发。
    completed：终态（如 once 触发完成）；不可再触发。
    error：连续失败达到 ``max_retries``；需人工 ``clear_error()`` 回到 paused 后重新 active。
    """

    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    ERROR = "error"


# 主状态机合法转换表：源状态 -> 可达目标集合。
_TRANSITIONS: dict[LoopStatus, frozenset[LoopStatus]] = {
    LoopStatus.PAUSED:    frozenset({LoopStatus.ACTIVE}),
    LoopStatus.ACTIVE:    frozenset({LoopStatus.PAUSED, LoopStatus.COMPLETED, LoopStatus.ERROR}),
    LoopStatus.COMPLETED: frozenset({LoopStatus.ACTIVE}),
    LoopStatus.ERROR:     frozenset({LoopStatus.PAUSED}),
}


class InvalidTransition(ValueError):
    """Loop 主状态非法转换。"""


class Loop(BaseModel):
    """一次本地周期/触发任务（runtime 无关，06 7.6 / D19）。

    conversation_id：目标会话（target_conversation_id）。触发的 run 归属该会话，事件并入该 timeline。
    recurrence_type / recurrence_config / cron：重复规则（详见 RecurrenceType）。
    run_spec：中立 RunSpec 模板，每次触发构造一份（B 类能力由 Driver 翻译）。
    input_template：每次触发时的消息模板（可空 = 沿用会话历史，不复写 run_spec）。
    max_retries / retry_count：失败重试策略（retry_count >= max_retries 且 active 时自迁至 error）。
    status：持久化主状态（active ⇄ paused，complete -> completed，error -> paused）。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    conversation_id: str = Field(
        description="目标会话 id，复用 ScheduledJob 的 target_conversation_id 口径"
    )
    cron: str = Field(
        default="* * * * *",
        description="5 字段 cron（分 时 日 月 周），仅 cron 类型使用",
    )
    run_spec: RunSpec = Field(default_factory=RunSpec, description="中立规格模板")
    title: str | None = None
    recurrence_type: RecurrenceType = Field(
        default=RecurrenceType.CRON,
        description="重复类型（once/daily/weekly/monthly/cron）",
    )
    recurrence_config: dict | None = Field(
        default=None,
        description="重复配置（周几、日期、时刻等，按 recurrence_type 口径解析）",
    )
    input_template: str | None = Field(
        default=None,
        description="每次触发时的消息模板（可空 = 沿用会话历史）",
    )
    status: LoopStatus = Field(
        default=LoopStatus.PAUSED,
        description="持久化主状态（active/paused/completed/error）",
    )
    max_retries: int = Field(
        default=3,
        ge=0,
        description="连续失败上限（retry_count >= 此值且 active 时自迁至 error）",
    )
    retry_count: int = Field(
        default=0,
        ge=0,
        description="当前连续失败次数",
    )
    fire_count: int = 0
    last_run_id: str | None = None
    last_fired_at: datetime | None = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

    # ── 主状态机 ────────────────────────────────────────────────────

    def _require_transition(self, target: LoopStatus) -> None:
        allowed = _TRANSITIONS.get(self.status)
        if allowed is None or target not in allowed:
            raise InvalidTransition(
                "loop %s 不可 %s -> %s" % (self.id, self.status.value, target.value)
            )

    def activate(self) -> None:
        """paused/completed -> active（进入调度）。"""
        self._require_transition(LoopStatus.ACTIVE)
        self.status = LoopStatus.ACTIVE

    def pause(self) -> None:
        """active -> paused（暂停调度）。"""
        self._require_transition(LoopStatus.PAUSED)
        self.status = LoopStatus.PAUSED

    def complete(self) -> None:
        """active -> completed（终态，如 once 任务触发完成）。"""
        self._require_transition(LoopStatus.COMPLETED)
        self.status = LoopStatus.COMPLETED

    def mark_error(self) -> None:
        """active -> error（连续失败后的调度器停跑态）。"""
        self._require_transition(LoopStatus.ERROR)
        self.status = LoopStatus.ERROR

    def clear_error(self) -> None:
        """error -> paused（人工介入，重新校验后再 active）。"""
        self._require_transition(LoopStatus.PAUSED)
        self.status = LoopStatus.PAUSED

    def record_failure(self) -> None:
        """记一次失败：retry_count + 1；达 max_retries 且 active 时自迁至 error。"""
        self.retry_count += 1
        if self.retry_count >= self.max_retries and self.status is LoopStatus.ACTIVE:
            self.status = LoopStatus.ERROR

    def record_success(self) -> None:
        """记一次成功：重置 retry_count。"""
        self.retry_count = 0

    def is_active(self) -> bool:
        """是否可被调度器触发（status == active）。"""
        return self.status is LoopStatus.ACTIVE

    def preview_next_run(self, after: datetime | None = None) -> datetime | None:
        """预览下次触发时刻（进程内计算、不落库；D19 next_fire 仅运行期内有效）。

        仅对 ``cron`` 类型可靠计算（复用 5 字段匹配步进至下一命中）。其余 recurrence_type
        当前返回 None，待服务端 matcher 在 ``recurrence_config`` 口径接走后再对齐。
        """
        if self.recurrence_type is not RecurrenceType.CRON:
            return None
        from . import cron as cron_mod

        base = after or _now()
        try:
            parsed = cron_mod.parse_cron(self.cron)
        except cron_mod.CronError:
            return None
        candidate = base.replace(second=0, microsecond=0)
        for _ in range(60 * 24 * 366 * 2):
            candidate += timedelta(minutes=1)
            if cron_mod.match_cron(parsed, candidate):
                return candidate
        return None
