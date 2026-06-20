"""Timeline store + raw event 本地归档（A1 / 07 §8，D6）。

TimelineStore：每个 conversation 一条时间线，**单调 numeric cursor**（从 1 递增）。
- append(business_event)：分配下一个 cursor，落本地、返回带 cursor 的事件。
- read_after(conversation_id, after_cursor)：增量拉取 cursor > after_cursor 的事件。
- terminal_for_run(conversation_id, run_id)：取该 run 在时间线上的**终态业务事件**
  （run_succeeded/run_cancelled/run_failed）；无则 None。

终态单一真相源（#64）：Run 持久终态由本接口反查已落 timeline 的终态事件类型派生，
不再靠 RunResult.error 字符串硬匹配——消除「Run=FAILED 而 timeline=run_cancelled」的撕裂。

cursor 口径（parity MVP run_journal）：MVP 用 per-run `seq`（event_id=run_id:seq，after_seq
增量）。v1 把游标提升到 **per-conversation**，使一个会话内多次 run 的事件能在同一条时间线上
按全局顺序增量拉取（对话页/审计回放需要会话级连续视图）。对外只暴露 numeric cursor（02
§10.3.7），不暴露内部 {ts}-{seq}。

raw event 归档（D6）：保留 raw runtime event 本地脱敏归档接口，**仅本地、受控、设保留期、
仅供调试**，绝不跨端、绝不外泄前端。本卡提供内存占位实现（真实落库 + 脱敏 + 保留期由后续接入）。
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod

from shared.contracts.events import AgentRuntimeEvent, BusinessTimelineEvent

# 产品级终态事件类型（07 §8 / event_mapper.TERMINAL_TYPES 同集合）。timeline 侧自持一份，
# 避免反向依赖 event_mapper（event_mapper 是 runtime->business 的纯映射，timeline 是存储，
# 两者关注点不同；终态类型集合属共享口径，由本模块 + event_mapper 各持一份同义定义）。
_TERMINAL_TYPES: frozenset[str] = frozenset({"run_succeeded", "run_cancelled", "run_failed"})


class TimelineStore(ABC):
    @abstractmethod
    def append(self, event: BusinessTimelineEvent) -> BusinessTimelineEvent:
        """分配单调 cursor 后落库，返回带最终 cursor 的事件。"""

    @abstractmethod
    def read_after(self, conversation_id: str, after_cursor: int = 0) -> list[BusinessTimelineEvent]:
        """增量拉取 cursor > after_cursor 的事件（升序）。"""

    @abstractmethod
    def latest_cursor(self, conversation_id: str) -> int:
        """该会话当前最大 cursor（无事件返回 0）。"""

    @abstractmethod
    def terminal_for_run(self, conversation_id: str, run_id: str) -> BusinessTimelineEvent | None:
        """取该 run 在时间线上**最后一条终态业务事件**；无终态事件返回 None。

        终态单一真相源（#64）：Run 持久终态据此反查派生（run_succeeded->COMPLETED /
        run_cancelled->CANCELLED / run_failed->FAILED），不再靠 RunResult.error 硬匹配。
        """


class InMemoryTimelineStore(TimelineStore):
    """内存时间线（本地库占位）。线程安全：cursor 分配与追加在锁内原子完成。"""

    def __init__(self) -> None:
        self._events: dict[str, list[BusinessTimelineEvent]] = {}
        self._cursor: dict[str, int] = {}
        self._lock = threading.Lock()

    def append(self, event: BusinessTimelineEvent) -> BusinessTimelineEvent:
        with self._lock:
            conv = event.conversation_id
            nxt = self._cursor.get(conv, 0) + 1
            self._cursor[conv] = nxt
            stored = event.model_copy(update={"cursor": nxt})
            self._events.setdefault(conv, []).append(stored)
            return stored

    def read_after(self, conversation_id: str, after_cursor: int = 0) -> list[BusinessTimelineEvent]:
        with self._lock:
            return [e for e in self._events.get(conversation_id, []) if e.cursor > after_cursor]

    def latest_cursor(self, conversation_id: str) -> int:
        with self._lock:
            return self._cursor.get(conversation_id, 0)

    def terminal_for_run(self, conversation_id: str, run_id: str) -> BusinessTimelineEvent | None:
        # 逆序找该 run 的最后一条终态事件（按 cursor 升序落库，逆序即最新）。
        with self._lock:
            for ev in reversed(self._events.get(conversation_id, [])):
                if ev.run_id == run_id and ev.type in _TERMINAL_TYPES:
                    return ev
        return None


class RawEventArchive(ABC):
    """raw runtime event 本地归档（D6）。仅本地脱敏受控存储，不跨端、不外泄前端。"""

    @abstractmethod
    def archive(self, event: AgentRuntimeEvent) -> None: ...


class InMemoryRawEventArchive(RawEventArchive):
    """内存归档占位（真实落库 + 脱敏 + 保留期由后续接入）。

    仅供调试/Driver 回归，永不经由任何北向端点对外暴露——本类不提供 read_*/list_* 对外读口，
    刻意只留 archive 写入，杜绝"归档被当数据源外泄"。
    """

    def __init__(self) -> None:
        self._events: list[AgentRuntimeEvent] = []
        self._lock = threading.Lock()

    def archive(self, event: AgentRuntimeEvent) -> None:
        with self._lock:
            self._events.append(event)

    def _debug_count(self) -> int:
        """仅测试/本地调试用（下划线前缀，非对外接口）。"""
        with self._lock:
            return len(self._events)
