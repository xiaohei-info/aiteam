"""群聊：单机多专家 @提及编排 + 多 run 并入同一时间线（06 §7.6 / D19）。

群聊只是**单用户本机多专家协作**（00 §19 已排除跨机器会话同步）。本模块在 A1 的
MainlineService 之上做一层薄编排，**不重写 run/timeline/SSE/WS 主链**：

    post_and_dispatch(conv, user_text)
        1. 落用户消息（USER 角色，本地库）
        2. 解析 @提及 -> 本轮要起 run 的专家集合（roster 内已知专家）
        3. 每个专家**各自以其快照构造独立 RunSpec、各起一个 run**（并发）
        4. 多 run 的归一事件并入**同一会话时间线**——这一步完全复用 A1：
           MainlineService.start_run -> event_mapper -> TimelineStore.append
           （per-conversation 单调 cursor，BusinessTimelineEvent 带 run_id 可区分来源）

防回环（红线，CLAUDE/AGENTS §8）：
- **只有 USER 角色消息**进入 @提及编排；专家产出的文本（含其中的 @）绝不作为新一轮
  编排触发源——这是阻断"专家互 @ 死循环"的根本闸（编排入口处收口，不靠下游补丁）。
- dispatch_for_expert（供编排策略按专家发起时）额外用 exclude_handle 排除发起方自身。

本模块不引入新 runtime 耦合：只决定"何时、以哪个专家快照"发起 run，runtime 差异仍只活
在 Driver（06 §7.5）。会话/执行内容全本地，绝不上传控制面（CLAUDE/AGENTS §3.3）。
"""

from __future__ import annotations

import asyncio

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.runspec import RunSpec

from . import mentions
from .models import MessageRole, Run
from .service import MainlineService


class GroupExpert(BaseModel):
    """群聊里的一个专家（员工实例的本地最小投影）。

    handle 是 @提及里用的标识；system_prompt/model 派生该专家的中立 RunSpec
    （B 类能力由 Driver 翻译，不直写 profile，06 §7.5 / D16）。真实快照字段更全，本卡
    取编排所需最小集。
    """

    model_config = ConfigDict(extra="forbid")

    handle: str
    system_prompt: str | None = None
    model: str | None = None

    def to_run_spec(self) -> RunSpec:
        return RunSpec(system_prompt=self.system_prompt, model=self.model)


class DispatchResult(BaseModel):
    """一轮群聊编排的结果：本轮触发了哪些专家、各自的 run 终态。"""

    model_config = ConfigDict(extra="forbid")

    triggered_handles: list[str] = Field(default_factory=list)
    runs: list[Run] = Field(default_factory=list)


class GroupChatService:
    """群聊编排器。包装 MainlineService，持本会话专家 roster，按 @提及起多 run。"""

    def __init__(self, mainline: MainlineService, *, experts: list[GroupExpert]) -> None:
        self._mainline = mainline
        self._roster: dict[str, GroupExpert] = {e.handle: e for e in experts}

    @property
    def mainline(self) -> MainlineService:
        """底层主链（供路由层复用 A1 的 timeline/SSE/WS 与读接口）。"""
        return self._mainline

    async def post_and_dispatch(self, conversation_id: str, user_text: str) -> DispatchResult:
        """用户发言入口：落消息 -> 解析 @提及 -> 被 @ 的每个专家各起一个 run（并发）。

        只有 USER 消息进入编排（防 @ 回环的根本闸）。无 @ 或全是未知 handle -> 不起任何 run。
        """
        self._mainline.add_message(conversation_id, role=MessageRole.USER, content=user_text)
        experts = mentions.resolve_mentions(user_text, self._roster)
        runs = await self._start_runs(conversation_id, experts)
        return DispatchResult(triggered_handles=[e.handle for e in experts], runs=runs)

    async def dispatch_for_expert(
        self, conversation_id: str, text: str, *, origin_handle: str
    ) -> list[Run]:
        """编排策略按某专家发起下一跳时用（排除发起方自身，防自激回环）。

        注意：这是供**编排器**显式调用的内部协作钩子，不是把专家产出当 USER 消息回灌——
        @ 回环的根本阻断仍是 post_and_dispatch 只认 USER 消息。此处的 exclude_handle 是
        第二道闸：即便上层策略决定让某专家发起，也禁止它 @ 触发自己。
        """
        experts = mentions.resolve_mentions(text, self._roster, exclude_handle=origin_handle)
        return await self._start_runs(conversation_id, experts)

    async def _start_runs(self, conversation_id: str, experts: list[GroupExpert]) -> list[Run]:
        """被 @ 的每个专家各起一个 run，并发执行，事件并入同一 conversation 时间线。

        复用 A1 MainlineService.start_run：每个 run 独立 run_id，归一事件经同一 TimelineStore
        追加（per-conversation 单调 cursor），天然并入同一条时间线、按 run_id 可区分来源。
        """
        if not experts:
            return []
        return list(await asyncio.gather(*(
            self._mainline.start_run(conversation_id, run_spec=e.to_run_spec())
            for e in experts
        )))
