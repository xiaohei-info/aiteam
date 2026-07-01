"""端内流式 broker（A1 / 05 §5.2）。

Gateway 归一事件 -> 映射为 BusinessTimelineEvent -> 落 timeline -> 经本 broker 推给
SSE/WebSocket 订阅者。**只承载已归一的产品事件**，绝不下发 runtime 原生事件（D6）。

展示态（streaming/waiting_reply/...）只在流里以独立 `display` 事件镜像，**不落任何持久化主
状态**（D6）——它是对话页瞬时渲染提示，断流即失效，不是事实状态。

实现：每个 conversation 一组订阅队列（asyncio.Queue）。发布即扇出到所有在线订阅者；
新订阅者只收订阅之后的事件（历史增量走 timeline.read_after，由路由层在订阅前补发）。
不维护跨文件全局态（杜绝旧 app/ 的 STREAMS/CANCEL_FLAGS 散落写法，CLAUDE/AGENTS §8）。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass

from shared.contracts.enums import DisplayState
from shared.contracts.events import BusinessTimelineEvent


@dataclass(frozen=True)
class StreamFrame:
    """一条推送帧。kind=timeline 携带业务事件；kind=display 携带瞬时展示态镜像。"""

    kind: str  # "timeline" | "display"
    timeline: BusinessTimelineEvent | None = None
    display: DisplayState | None = None
    run_id: str | None = None


class StreamBroker:
    """会话级内存 pub/sub。线程内 asyncio 扇出，进程内单实例（用户端单进程本地）。"""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[StreamFrame]]] = {}
        self._lock: asyncio.Lock | None = None

    def _get_lock(self) -> asyncio.Lock:
        # Lazy: asyncio.Lock() in 3.9 raises if constructed before a loop exists on the
        # main thread; all call sites run inside coroutines where a loop is guaranteed.
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def publish_timeline(self, event: BusinessTimelineEvent) -> None:
        await self._fanout(event.conversation_id, StreamFrame(kind="timeline", timeline=event))

    async def publish_display(self, conversation_id: str, state: DisplayState,
                              *, run_id: str | None = None) -> None:
        """推送展示态镜像（仅流，不落库，D6）。"""
        await self._fanout(conversation_id, StreamFrame(kind="display", display=state, run_id=run_id))

    async def _fanout(self, conversation_id: str, frame: StreamFrame) -> None:
        async with self._get_lock():
            queues = list(self._subscribers.get(conversation_id, ()))
        for q in queues:
            q.put_nowait(frame)

    async def subscribe(self, conversation_id: str) -> "Subscription":
        q: asyncio.Queue[StreamFrame] = asyncio.Queue()
        async with self._get_lock():
            self._subscribers.setdefault(conversation_id, set()).add(q)
        return Subscription(self, conversation_id, q)

    async def _unsubscribe(self, conversation_id: str, q: asyncio.Queue[StreamFrame]) -> None:
        async with self._get_lock():
            subs = self._subscribers.get(conversation_id)
            if subs:
                subs.discard(q)
                if not subs:
                    self._subscribers.pop(conversation_id, None)


class Subscription:
    """单订阅者句柄。async context manager，退出即注销，避免泄漏队列。"""

    def __init__(self, broker: StreamBroker, conversation_id: str, queue: asyncio.Queue[StreamFrame]):
        self._broker = broker
        self._conversation_id = conversation_id
        self._queue = queue

    async def __aenter__(self) -> "Subscription":
        return self

    async def __aexit__(self, *exc) -> None:
        await self._broker._unsubscribe(self._conversation_id, self._queue)

    async def next_frame(self) -> StreamFrame:
        return await self._queue.get()

    async def frames(self) -> AsyncIterator[StreamFrame]:
        while True:
            yield await self._queue.get()

    def get_nowait(self) -> StreamFrame:
        return self._queue.get_nowait()

    def empty(self) -> bool:
        return self._queue.empty()
