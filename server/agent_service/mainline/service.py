"""本地主链服务编排（A1 / 05 §5.2 / 07 §8）。

职责：建会话/发消息/起 run/建 task；起 run 时经 GatewayRunner 驱动 runtime，Gateway 归一
事件回流后：
    1. 原始归一事件本地脱敏归档（RawEventArchive，D6，仅本地）
    2. 映射为 BusinessTimelineEvent 并落 TimelineStore（分配单调 cursor）
    3. 推送展示态 streaming（仅流，不落主状态）+ 业务事件给 SSE/WS 订阅者
    4. 终态事件落 Run 持久终态（completed/cancelled/failed）+ 推 resolved 展示态

铁律：
- 展示态绝不落主状态库（D6）：只 broker.publish_display，从不写 Run/Conversation 状态字段。
- 前端只见 BusinessTimelineEvent（D6）：归一在 event_mapper，broker 只推产品事件。
- 本地优先：会话/事件全落本地，绝不上传控制面。
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

from shared.contracts.enums import ConversationState, DisplayState
from shared.errors import Conflict
from shared.contracts.events import AgentRuntimeEvent
from shared.contracts.runspec import AgentRunRequest, RunSpec
from shared.contracts.gateway import RunResult

from agent_gateway.runner import GatewayRunner

from . import event_mapper
from .models import (
    Conversation,
    Message,
    MessageRole,
    Run,
    RunStatus,
    Task,
    TaskStatus,
)
from .store import (
    ConversationRepository,
    MessageRepository,
    RunRepository,
    TaskRepository,
)
from .stream import StreamBroker
from .timeline import RawEventArchive, TimelineStore

# 产品终态事件类型 -> Run 持久终态（#64 终态单一真相源：timeline 终态事件 -> Run 终态）。
# 与 event_mapper.TERMINAL_TYPES / timeline._TERMINAL_TYPES 同集合，是终态类型集合的唯一业务
# 映射点。Run 终态据此反查派生，不再靠 RunResult.error 字符串硬匹配。
_TERMINAL_RUN_STATUS: dict[str, RunStatus] = {
    "run_succeeded": RunStatus.COMPLETED,
    "run_cancelled": RunStatus.CANCELLED,
    "run_failed": RunStatus.FAILED,
}


UsageRecorder = Callable[[str, str, "RunStatus", "dict | None", "str | None"], None]
"""闭环 C 运行期→用量 outbox 钩子（A5 / 04 §6.5 / 05 §5.2 / D13/D14）。

在 run 终态落库后**尽力**回调一次，签名为 (tenant_id, run_id, run_status, usage, error)：
- 只把 runtime 提取的 usage dict（token/成本计量）交给 outbox 服务脱敏聚合；绝不传会话内容。
- 失败一律吞掉、绝不抛出：outbox 不可用 / 上报对端不可达只影响用量回流，不阻断本地 run（D14）。
调用方（agent app 装配）注入 `UsageService` 的薄适配器；默认 None = 不回流（dev/测试默认）。
"""


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# 会话消息角色 -> 中立 runtime 角色（输入上下文用）。EMPLOYEE（专家回复）即 assistant 轮。
_RUNTIME_ROLE: dict[MessageRole, str] = {
    MessageRole.USER: "user",
    MessageRole.EMPLOYEE: "assistant",
    MessageRole.SYSTEM: "system",
}


# Conversation 主状态机合法转换表（对齐 app/team_panel/domain/entities.py:Conversation）。
# 前端只暴露合法转换对应的动作按钮；后端兜底校验，非法转换抛 Conflict(409)。
_CONVERSATION_TRANSITIONS: dict[ConversationState, frozenset[ConversationState]] = {
    ConversationState.DRAFT:   frozenset({ConversationState.ACTIVE, ConversationState.ARCHIVED}),
    ConversationState.ACTIVE:  frozenset({ConversationState.PAUSED, ConversationState.MUTED, ConversationState.ARCHIVED}),
    ConversationState.PAUSED:  frozenset({ConversationState.ACTIVE, ConversationState.ARCHIVED}),
    ConversationState.MUTED:   frozenset({ConversationState.ACTIVE, ConversationState.ARCHIVED}),
    ConversationState.ARCHIVED: frozenset(),
}


class MainlineService:
    """用户端本地主链编排器。单租户本地，无 tenant 路由（用户端单用户本地库）。"""

    def __init__(
        self,
        *,
        conversations: ConversationRepository,
        messages: MessageRepository,
        runs: RunRepository,
        tasks: TaskRepository,
        timeline: TimelineStore,
        broker: StreamBroker,
        runner: GatewayRunner,
        raw_archive: RawEventArchive,
        tenant_id: str = "local",
        usage_recorder: UsageRecorder | None = None,
    ) -> None:
        self._conversations = conversations
        self._messages = messages
        self._runs = runs
        self._tasks = tasks
        self._timeline = timeline
        self._broker = broker
        self._runner = runner
        self._raw_archive = raw_archive
        self._tenant_id = tenant_id
        self._usage_recorder = usage_recorder

    @property
    def broker(self) -> StreamBroker:
        """端内流式 broker（供路由层 SSE/WS 订阅）。"""
        return self._broker

    # ---- conversation ----

    def create_conversation(self, *, title: str | None = None) -> Conversation:
        conv = Conversation(id=_new_id("conv"), title=title, state=ConversationState.ACTIVE)
        return self._conversations.create(conv)

    def get_conversation(self, conversation_id: str) -> Conversation:
        return self._conversations.get(conversation_id)

    def list_conversations(self) -> list[Conversation]:
        return self._conversations.list()

    def set_conversation_state(self, conversation_id: str, state: ConversationState) -> Conversation:
        conversation = self._conversations.get(conversation_id)
        allowed = _CONVERSATION_TRANSITIONS.get(conversation.state, frozenset())
        if state not in allowed:
            raise Conflict(
                f"Cannot transition conversation from {conversation.state.value} to {state.value}; "
                f"allowed: {[s.value for s in allowed] or "none"}"
            )
        return self._conversations.set_state(conversation_id, state)

    # ---- message ----

    def add_message(self, conversation_id: str, *, role: MessageRole, content: str) -> Message:
        self._conversations.get(conversation_id)  # 存在性校验 -> NotFound
        msg = Message(id=_new_id("msg"), conversation_id=conversation_id, role=role, content=content)
        return self._messages.add(msg)

    def list_messages(self, conversation_id: str) -> list[Message]:
        self._conversations.get(conversation_id)
        return self._messages.list(conversation_id)

    # ---- timeline ----

    def read_timeline(self, conversation_id: str, after_cursor: int = 0):
        self._conversations.get(conversation_id)
        return self._timeline.read_after(conversation_id, after_cursor)

    # ---- task ----

    def create_task(self, conversation_id: str, *, title: str, run_id: str | None = None) -> Task:
        self._conversations.get(conversation_id)
        task = Task(id=_new_id("task"), conversation_id=conversation_id, run_id=run_id, title=title)
        return self._tasks.create(task)

    def list_tasks(self, conversation_id: str) -> list[Task]:
        self._conversations.get(conversation_id)
        return self._tasks.list(conversation_id)

    def set_task_status(self, task_id: str, status: TaskStatus) -> Task:
        return self._tasks.set_status(task_id, status)

    # ---- run（核心：编排 Gateway + 事件归一 + timeline + 推流）----

    async def start_run(
        self,
        conversation_id: str,
        *,
        run_spec: RunSpec | None = None,
        task_id: str | None = None,
        tenant_id: str | None = None,
    ) -> Run:
        """起一次 run：驱动 runtime，事件归一落 timeline + 推流，终态落 Run。

        返回 run 的**最终持久态**（终态已落库）。展示态全程只经 broker，不落库（D6）。
        """
        self._conversations.get(conversation_id)
        effective_tenant_id = tenant_id or self._tenant_id
        run = self._runs.create(Run(id=_new_id("run"), conversation_id=conversation_id))
        if task_id is not None:
            self._tasks.set_status(task_id, TaskStatus.RUNNING)

        await self._broker.publish_display(conversation_id, DisplayState.STREAMING, run_id=run.id)

        request = AgentRunRequest(
            run_id=run.id,
            tenant_id=effective_tenant_id,
            conversation_id=conversation_id,
            task_id=task_id,
            run_spec=run_spec or RunSpec(),
            input_messages=self._conversation_input_messages(conversation_id),
        )

        async def on_event(rt: AgentRuntimeEvent) -> None:
            await self._handle_runtime_event(conversation_id, rt)

        result = await self._runner.run(request, on_event)
        final_run = self._finalize_run(run.id, conversation_id, result)
        if task_id is not None:
            self._tasks.set_status(task_id, _task_status_for(final_run.status))
        # 闭环 C：run 终态落库后尽力把用量回流进 outbox（D14：失败不阻断本地 run）。
        self._record_run_usage(final_run, tenant_id=effective_tenant_id)
        await self._broker.publish_display(conversation_id, DisplayState.RESOLVED, run_id=run.id)
        return final_run

    def _conversation_input_messages(self, conversation_id: str) -> list[dict]:
        """把会话历史消息组装为中立 input_messages（喂给 runtime 的 prompt 上下文）。

        角色归一到 {user, assistant, system}：USER→user、EMPLOYEE→assistant、SYSTEM→system。
        runtime/Driver 据此取 prompt（多数取最后一条 user；支持多轮的 runtime 用完整序列）。
        """
        return [
            {"role": _RUNTIME_ROLE[m.role], "content": m.content}
            for m in self._messages.list(conversation_id)
        ]

    async def cancel_run(self, run_id: str) -> None:
        """取消运行中的 run（透传 Gateway）。终态由事件流/收尾落库。"""
        self._runs.get(run_id)  # 存在性校验
        await self._runner.cancel(run_id)

    async def _handle_runtime_event(self, conversation_id: str, rt: AgentRuntimeEvent) -> None:
        # 1) 原始归一事件本地脱敏归档（D6，仅本地，不外泄）。
        self._raw_archive.archive(rt)
        # 2) 归一 -> 业务事件 -> 落 timeline（分配 cursor）。
        business = event_mapper.map_runtime_event(rt, conversation_id=conversation_id)
        stored = self._timeline.append(business)
        # 3) 推业务事件给订阅者（只推产品事件，绝不推 runtime 原生事件）。
        await self._broker.publish_timeline(stored)

    def set_usage_recorder(self, recorder: "UsageRecorder | None") -> None:
        """运行期注入/替换用量回流钩子（供 app 装配在 mainline 与 usage_service 都就绪后接线）。

        传 None 即关闭回流。注入的 recorder 仍受 _record_run_usage 的异常吞没保护（D14）。
        """
        self._usage_recorder = recorder

    def _record_run_usage(self, run: Run, *, tenant_id: str | None = None) -> None:
        """闭环 C 运行期→用量 outbox 钩子：把本次 run 的 usage 回流进 outbox（尽力，不阻断）。

        只回传 runtime 提取的 usage dict（token/成本计量）与终态/error 诊断串；**绝不**回传
        会话内容/prompt/completion（D13：脱敏在下游聚合器，本钩子只交计量）。未注入 recorder
        或 recorder 抛异常时静默吞掉——用量回流是尽力而为的治理副链，不阻断本地主链（D14）。
        """
        if self._usage_recorder is None:
            return
        try:
            self._usage_recorder(tenant_id or self._tenant_id, run.id, run.status, run.usage, run.error)
        except Exception:  # noqa: BLE001 — D14：outbox 副链失败不阻断本地 run
            pass

    def _finalize_run(self, run_id: str, conversation_id: str, result: RunResult) -> Run:
        """据 timeline 终态事件收敛 Run 持久终态（#64 单一真相源）。

        Run 终态由**已落 timeline 的终态业务事件**反查派生（run_succeeded->COMPLETED /
        run_cancelled->CANCELLED / run_failed->FAILED），与 timeline 终态同一来源——消除旧的
        `result.error == 'cancelled'` 字符串硬匹配双源（runtime 回非标准 error 串会导致
        Run=FAILED 而 timeline=run_cancelled 的撕裂）。

        兜底：timeline 无终态事件时（契约异常：正常 runtime 必发 completed/cancelled/error），
        按 RunResult.success 收尾（success->COMPLETED / 否则 FAILED），避免卡死。RunResult 的
        session_id/error/usage 始终作为元数据落库（error 是诊断串，不参与终态判定）。
        """
        terminal = self._timeline.terminal_for_run(conversation_id, run_id)
        if terminal is not None:
            status = _TERMINAL_RUN_STATUS[terminal.type]
        else:
            status = RunStatus.COMPLETED if result.success else RunStatus.FAILED
        return self._runs.finalize(
            run_id, status,
            session_id=result.session_id, error=result.error, usage=result.usage,
        )

    def get_run(self, run_id: str) -> Run:
        return self._runs.get(run_id)

    def list_runs(self, conversation_id: str) -> list[Run]:
        self._conversations.get(conversation_id)
        return self._runs.list(conversation_id)
    # ---- run retry (P1 gap) ----

    async def retry_run(
        self,
        run_id: str,
        *,
        run_spec: RunSpec | None = None,
        tenant_id: str | None = None,
    ) -> Run:
        """Retry a run: create a new run in the same conversation.

        New run inherits conversation context (message history) and can override RunSpec.
        Original run is unaffected; new run is created independently.
        """
        existing = self._runs.get(run_id)
        return await self.start_run(
            conversation_id=existing.conversation_id,
            run_spec=run_spec,
            task_id=None,
            tenant_id=tenant_id,
        )




def _task_status_for(run_status: RunStatus) -> TaskStatus:
    return {
        RunStatus.COMPLETED: TaskStatus.DONE,
        RunStatus.CANCELLED: TaskStatus.CANCELLED,
        RunStatus.FAILED: TaskStatus.FAILED,
        RunStatus.RUNNING: TaskStatus.RUNNING,
    }[run_status]
