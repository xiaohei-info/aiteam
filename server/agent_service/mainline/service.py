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

from shared.contracts.enums import ConversationState, DisplayState
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

# 产品终态事件类型 -> Run 持久终态。
_TERMINAL_RUN_STATUS: dict[str, RunStatus] = {
    "run_succeeded": RunStatus.COMPLETED,
    "run_cancelled": RunStatus.CANCELLED,
    "run_failed": RunStatus.FAILED,
}


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


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
    ) -> Run:
        """起一次 run：驱动 runtime，事件归一落 timeline + 推流，终态落 Run。

        返回 run 的**最终持久态**（终态已落库）。展示态全程只经 broker，不落库（D6）。
        """
        self._conversations.get(conversation_id)
        run = self._runs.create(Run(id=_new_id("run"), conversation_id=conversation_id))
        if task_id is not None:
            self._tasks.set_status(task_id, TaskStatus.RUNNING)

        await self._broker.publish_display(conversation_id, DisplayState.STREAMING, run_id=run.id)

        request = AgentRunRequest(
            run_id=run.id,
            tenant_id=self._tenant_id,
            conversation_id=conversation_id,
            task_id=task_id,
            run_spec=run_spec or RunSpec(),
        )

        async def on_event(rt: AgentRuntimeEvent) -> None:
            await self._handle_runtime_event(conversation_id, rt)

        result = await self._runner.run(request, on_event)
        final_run = self._finalize_run(run.id, result)
        if task_id is not None:
            self._tasks.set_status(task_id, _task_status_for(final_run.status))
        await self._broker.publish_display(conversation_id, DisplayState.RESOLVED, run_id=run.id)
        return final_run

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

    def _finalize_run(self, run_id: str, result: RunResult) -> Run:
        """据 Executor 终态收尾 Run 持久态。

        Executor 的 RunResult 是权威终态来源（本地 Runtime 执行口径，07 §8）；事件流里的
        run_succeeded/failed/cancelled 已落 timeline，这里把 Run 主记录收敛到对应终态。
        """
        if result.success:
            status = RunStatus.COMPLETED
        elif result.error == "cancelled":
            status = RunStatus.CANCELLED
        else:
            status = RunStatus.FAILED
        return self._runs.finalize(
            run_id, status,
            session_id=result.session_id, error=result.error, usage=result.usage,
        )

    def get_run(self, run_id: str) -> Run:
        return self._runs.get(run_id)

    def list_runs(self, conversation_id: str) -> list[Run]:
        self._conversations.get(conversation_id)
        return self._runs.list(conversation_id)


def _task_status_for(run_status: RunStatus) -> TaskStatus:
    return {
        RunStatus.COMPLETED: TaskStatus.DONE,
        RunStatus.CANCELLED: TaskStatus.CANCELLED,
        RunStatus.FAILED: TaskStatus.FAILED,
        RunStatus.RUNNING: TaskStatus.RUNNING,
    }[run_status]
