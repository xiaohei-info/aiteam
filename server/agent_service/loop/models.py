"""Loop 本地调度领域模型（A3 / 06 §7.6 / D19）。

Loop = 用户端**本地调度器**持有的周期/触发任务（runtime 无关）：
- 绑定到一个 conversation（run 的事件并入该会话 timeline）
- 持有一份中立 RunSpec 模板（派生自 employee 快照，B 类能力由 Driver 翻译）
- 持有 cron 触发配置（5 字段，runtime 无关、不依赖 hermes cron）
- 到点构造 RunSpec 经 Gateway 执行（复用 A1 MainlineService.start_run）

红线（06 §7.6 / CLAUDE/AGENTS §8）：
- **仅运行期执行**：关机即不跑，不做服务端常驻代跑。调度器状态（next_fire 等）只在进程内
  维护，loop 主状态（enabled/disabled、fire 计数、last_run_id）落本地库。
- **不依赖 hermes cron**：调度由本地调度器进程内驱动，不经 runtime cron。
- **不上传会话内容**：loop 触发的 run 与私聊 run 同构，事件/usage 全落本地（D6）。

LoopStatus 是持久化主状态（fixed enum），非展示态。last_run_id 记录最近一次触发的 run，
便于回看；不在 loop 上缓存 run 终态（终态是 Run 主记录的事实）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.runspec import RunSpec


def _now() -> datetime:
    return datetime.now(timezone.utc)


class LoopStatus(str, Enum):
    """Loop 持久化主状态（非展示态）。

    enabled：可被调度器触发（运行期到点即起 run）。
    disabled：用户暂停；调度器跳过、不触发。删除走 disabled + 清理，不做物理删。
    """

    ENABLED = "enabled"
    DISABLED = "disabled"


class Loop(BaseModel):
    """一次本地周期/触发任务（runtime 无关，06 §7.6）。

    conversation_id：触发的 run 归属该会话，事件并入同一条 timeline（复用 A1）。
    run_spec：中立 RunSpec 模板（从 employee 快照派生；每次触发构造一份）。
    cron：5 字段 cron 表达式（分 时 日 月 周）。runtime 无关、非 hermes cron。
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    conversation_id: str
    cron: str = Field(description="5 字段 cron（分 时 日 月 周），runtime 无关")
    run_spec: RunSpec = Field(default_factory=RunSpec, description="中立规格模板，派生自快照")
    title: str | None = None
    status: LoopStatus = LoopStatus.DISABLED
    fire_count: int = 0
    last_run_id: str | None = None
    last_fired_at: datetime | None = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
