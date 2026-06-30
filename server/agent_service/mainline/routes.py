"""本地主链北向路由（A1 / 02 §10.1 前缀 /api/agent；07 §8）。

REST：conversations / messages / runs / tasks / timeline（游标增量）。
流式：SSE（GET /timeline/stream）+ WebSocket（/ws/timeline）。两者只下发已归一的
BusinessTimelineEvent + 瞬时 display 镜像，绝不下发 runtime 原生事件（D6）。

所有响应走统一 Envelope/ListEnvelope（02 §10.3.4）；错误走 problem+json（由 app_factory
安装的 handler 统一生成）。展示态不落库——只在 SSE/WS 流里以 `display` 事件出现（D6）。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Callable

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.auth import TokenClaims
from shared.contracts.enums import ConversationState
from shared.contracts.envelope import Envelope, ListEnvelope, Page
from shared.contracts.events import BusinessTimelineEvent
from shared.contracts.runspec import RunSpec

from .group import DispatchResult, GroupChatService, GroupExpert
from .models import Conversation, Message, MessageRole, Run, Task
from .service import MainlineService
from .stream import StreamBroker, StreamFrame


class CreateConversationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, description="会话标题（可选，未给则自动生成）")


class SetConversationStateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: ConversationState = Field(description="会话主状态：active=正常 / archived=归档 / deleted=软删")


class CreateMessageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: MessageRole = Field(default=MessageRole.USER, description="消息角色：user=用户, assistant=AI, system=系统")
    content: str = Field(min_length=1, description="消息文本内容")


class StartRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: str | None = Field(default=None, description="关联任务 id（可选）；指定后 run 归入该 task")
    # 中立 RunSpec：指定模型 / 切换思考深度 / persona / mcp 等经此下达；未给则用默认（runtime 自解析）。
    run_spec: RunSpec | None = Field(default=None, description="中立运行规格：模型/思考深度/persona/MCP 等；未给则 runtime 自选默认")


class CreateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, description="任务标题")
    run_id: str | None = Field(default=None, description="初始关联的 run id（可选）")


class GroupDispatchRequest(BaseModel):
    """群聊一轮编排请求（06 §7.6 / D19）：用户发言 + 本会话专家 roster。

    experts 为本会话已装载专家的最小投影（handle/persona/model）；真实来源是 pull 装载的
    employee 快照（留详设），本卡按请求携带即可端到端验证 @提及编排与多 run 并入。
    """

    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, description="用户发言文本（@提及触发多专家并行响应）")
    experts: list[GroupExpert] = Field(default_factory=list, description="本会话已装载专家 roster（handle/persona/model 最小投影）")


def frame_to_dict(frame: StreamFrame) -> dict:
    """把流帧序列化为对外 JSON（只含产品事件 / 瞬时展示态，无 runtime 原生结构）。"""
    if frame.kind == "timeline" and frame.timeline is not None:
        return {"kind": "timeline", "event": frame.timeline.model_dump(mode="json")}
    return {"kind": "display", "display": frame.display.value if frame.display else None,
            "run_id": frame.run_id}


async def sse_event_stream(service: MainlineService, conversation_id: str, after: int):
    """SSE 事件生成器（07 §8）：先补发历史增量（cursor>after），再转直播。

    抽成模块级可单测生成器：StreamingResponse 仅薄包装它。无新事件时阻塞在 sub.frames()
    （长连接语义），由客户端断开/取消驱动结束（context manager 退出即注销订阅）。
    """
    broker: StreamBroker = service.broker
    async with await broker.subscribe(conversation_id) as sub:
        for ev in service.read_timeline(conversation_id, after):
            yield _sse(frame_to_dict(StreamFrame(kind="timeline", timeline=ev)))
        async for frame in sub.frames():
            yield _sse(frame_to_dict(frame))


def build_mainline_router(
    service: MainlineService,
    *,
    identity_provider: Callable[[], TokenClaims | None] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent-mainline"])

    # ---- conversation ----

    @router.post("/conversations", summary="建会话", description="创建新会话。可指定标题，留空自动生成。会话是对话/run/task 的容器。", operation_id="agent_create_conversation")
    async def create_conversation(req: CreateConversationRequest) -> Envelope[Conversation]:
        return Envelope[Conversation](data=service.create_conversation(title=req.title))

    @router.get("/conversations", summary="列会话", description="列出本端所有会话，按创建时间倒序排列。", operation_id="agent_list_conversations")
    async def list_conversations() -> ListEnvelope[Conversation]:
        return ListEnvelope[Conversation](data=service.list_conversations())

    @router.get("/conversations/{conversation_id}", summary="取会话", description="取单个会话详情，包括标题、状态、创建时间等。", operation_id="agent_get_conversation")
    async def get_conversation(conversation_id: str) -> Envelope[Conversation]:
        return Envelope[Conversation](data=service.get_conversation(conversation_id))

    @router.put("/conversations/{conversation_id}/state", summary="改会话主状态", description="修改会话主状态：active=正常、archived=归档、deleted=软删。", operation_id="agent_set_conversation_state")
    async def set_state(conversation_id: str, req: SetConversationStateRequest) -> Envelope[Conversation]:
        return Envelope[Conversation](data=service.set_conversation_state(conversation_id, req.state))

    # ---- message ----

    @router.post("/conversations/{conversation_id}/messages", summary="发消息", description="向会话追加一条消息。角色支持 user/assistant/system。", operation_id="agent_add_message")
    async def add_message(conversation_id: str, req: CreateMessageRequest) -> Envelope[Message]:
        msg = service.add_message(conversation_id, role=req.role, content=req.content)
        return Envelope[Message](data=msg)

    @router.get("/conversations/{conversation_id}/messages", summary="列消息", description="按时间顺序列出会话内所有消息。", operation_id="agent_list_messages")
    async def list_messages(conversation_id: str) -> ListEnvelope[Message]:
        return ListEnvelope[Message](data=service.list_messages(conversation_id))

    # ---- run ----

    @router.post("/conversations/{conversation_id}/runs", summary="起 run（驱动 runtime）", description="启动一次运行，驱动 runtime 执行。可指定 task_id 归入和 RunSpec 覆盖默认配置。", operation_id="agent_start_run")
    async def start_run(conversation_id: str, req: StartRunRequest) -> Envelope[Run]:
        claims = identity_provider() if identity_provider is not None else None
        run = await service.start_run(
            conversation_id,
            task_id=req.task_id,
            run_spec=req.run_spec,
            tenant_id=claims.tenant_id if claims is not None else None,
        )
        return Envelope[Run](data=run)

    @router.get("/conversations/{conversation_id}/runs", summary="列 run", description="按创建时间倒序列出会话内所有 run。", operation_id="agent_list_runs")
    async def list_runs(conversation_id: str) -> ListEnvelope[Run]:
        return ListEnvelope[Run](data=service.list_runs(conversation_id))

    @router.get("/runs/{run_id}", summary="取 run", description="查单个 run 详情：状态、耗时、关联消息等。", operation_id="agent_get_run")
    async def get_run(run_id: str) -> Envelope[Run]:
        return Envelope[Run](data=service.get_run(run_id))

    @router.post("/runs/{run_id}/cancel", summary="取消 run", description="取消正在执行的 run。不可恢复。已完成的 run 返回 200 但无实际效果。", operation_id="agent_cancel_run")
    async def cancel_run(run_id: str) -> Envelope[dict]:
        await service.cancel_run(run_id)
        return Envelope[dict](data={"cancelled": True})

    @router.post("/runs/{run_id}/retry", summary="Retry run", description="Retry a completed/failed/cancelled run in the same conversation. Creates a new run with the same message context.", operation_id="agent_retry_run")
    async def retry_run(run_id: str, req: StartRunRequest | None = None) -> Envelope[Run]:
        run = await service.retry_run(
            run_id,
            run_spec=req.run_spec if req else None,
        )
        return Envelope[Run](data=run)


    # ---- 群聊（单机多专家 @提及编排，多 run 并入同一 timeline）----

    @router.post("/conversations/{conversation_id}/group-dispatch", summary="群聊一轮编排（@提及触发多专家、多 run 并入同一时间线）", description="@提及生效多专家并行编排。每位专家独立 run，并入同一时间线。", operation_id="agent_group_dispatch")
    async def group_dispatch(conversation_id: str, req: GroupDispatchRequest) -> Envelope[DispatchResult]:
        service.get_conversation(conversation_id)  # 存在性校验 -> 404
        group = GroupChatService(service, experts=req.experts)
        result = await group.post_and_dispatch(conversation_id, req.text)
        return Envelope[DispatchResult](data=result)

    # ---- task ----

    @router.post("/conversations/{conversation_id}/tasks", summary="建 task", description="创建任务。可指定标题和初始关联 run。", operation_id="agent_create_task")
    async def create_task(conversation_id: str, req: CreateTaskRequest) -> Envelope[Task]:
        task = service.create_task(conversation_id, title=req.title, run_id=req.run_id)
        return Envelope[Task](data=task)

    @router.get("/conversations/{conversation_id}/tasks", summary="列 task", description="列出会话内所有 task。", operation_id="agent_list_tasks")
    async def list_tasks(conversation_id: str) -> ListEnvelope[Task]:
        return ListEnvelope[Task](data=service.list_tasks(conversation_id))

    # ---- timeline（游标增量拉取）----

    @router.get("/conversations/{conversation_id}/timeline", summary="时间线增量拉取", description="游标增量拉取时间线事件。after=0 返回全部；后续传最新 cursor 仅取增量。", operation_id="agent_read_timeline")
    async def read_timeline(
        conversation_id: str,
        after: int = Query(default=0, ge=0, description="numeric cursor；返回 cursor > after 的事件"),
    ) -> ListEnvelope[BusinessTimelineEvent]:
        events = service.read_timeline(conversation_id, after)
        next_cursor = str(events[-1].cursor) if events else None
        return ListEnvelope[BusinessTimelineEvent](
            data=events, page=Page(next_cursor=next_cursor, has_more=False)
        )

    # ---- SSE 流式（增量补发 + 实时推送）----

    @router.get("/conversations/{conversation_id}/timeline/stream", summary="时间线 SSE 流", description="SSE 流式时间线：先补发历史增量（cursor>after），再实时推送后续事件。", operation_id="agent_stream_timeline")
    async def stream_timeline(conversation_id: str, after: int = Query(default=0, ge=0)):
        service.get_conversation(conversation_id)  # 存在性校验 -> 404
        return StreamingResponse(
            sse_event_stream(service, conversation_id, after),
            media_type="text/event-stream",
        )

    # ---- WebSocket 流式 ----

    @router.websocket("/ws/conversations/{conversation_id}/timeline")
    async def ws_timeline(websocket: WebSocket, conversation_id: str):
        await websocket.accept()
        async with await service.broker.subscribe(conversation_id) as sub:

            async def _wait_disconnect():
                try:
                    while True:
                        await websocket.receive()
                except (WebSocketDisconnect, RuntimeError):
                    return

            disconnect_task = asyncio.create_task(_wait_disconnect())
            try:
                while True:
                    frame_task = asyncio.create_task(sub.next_frame())
                    done, _ = await asyncio.wait(
                        {disconnect_task, frame_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if disconnect_task in done:
                        frame_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await frame_task
                        return
                    frame = frame_task.result()
                    try:
                        await websocket.send_json(frame_to_dict(frame))
                    except (WebSocketDisconnect, RuntimeError):
                        return
            finally:
                disconnect_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await disconnect_task

    return router


def _sse(data: dict) -> str:
    return f"event: timeline\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
