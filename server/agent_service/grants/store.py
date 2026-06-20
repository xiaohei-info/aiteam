"""本地投影 + 冻结快照仓储（A4，04 §6.2/§6.3，D5/D12/D14）。

两份本地读模型（写端均为 Agent 本地；配置主数据单写者仍是 Manager）：

1. ProjectionRepository —— loaded_expert_projection（04 §6.2）
   - 主键：employee_id（用户端单租户本地库；条目仍带 tenant_id 供鉴权/上报）。
   - sync 增量：upsert 已授权专家投影；授权撤销的（revoked_ids）置 revoked=True 并从
     available()（可用列表）移除——保留条目便于审计/再授权，但对话路径只看 available()。

2. SnapshotRepository —— 冻结执行快照（04 §6.3，D5）
   - 主键：(employee_id, snapshot_version)。
   - **冻结语义**：一旦取得即本地持久、不被覆盖、不随 Manager 离线失效；同 key 重复 freeze
     幂等返回既有快照（run 全程引用同一快照，避免上下文漂移）。

agent 本地库口径（与 usage/loop/mainline 一致）：接口 + 内存实现，真实持久化后续替换不改形状。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone

from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import EmployeeExecutionSnapshot


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ProjectionRepository(ABC):
    """已授权专家本地只读投影仓储（写端 Agent，04 §6.2）。"""

    @abstractmethod
    def upsert(self, projection: LoadedExpertProjection) -> LoadedExpertProjection:
        """按 employee_id 落投影（sync 增量写入）。"""

    @abstractmethod
    def revoke(self, employee_id: str) -> LoadedExpertProjection | None:
        """授权撤销：置 revoked=True 并从 available() 移除；条目不存在返回 None。"""

    @abstractmethod
    def get(self, employee_id: str) -> LoadedExpertProjection | None: ...

    @abstractmethod
    def available(self) -> list[LoadedExpertProjection]:
        """对话路径可用列表（已授权且未撤销）。"""

    @abstractmethod
    def list_all(self) -> list[LoadedExpertProjection]: ...


class InMemoryProjectionRepository(ProjectionRepository):
    """内存投影（本地库占位；接口稳定，真实持久化后续替换）。"""

    def __init__(self) -> None:
        self._items: dict[str, LoadedExpertProjection] = {}

    def upsert(self, projection: LoadedExpertProjection) -> LoadedExpertProjection:
        self._items[projection.employee_id] = projection
        return projection

    def revoke(self, employee_id: str) -> LoadedExpertProjection | None:
        existing = self._items.get(employee_id)
        if existing is None:
            return None
        updated = existing.model_copy(update={"revoked": True, "synced_at": _now()})
        self._items[employee_id] = updated
        return updated

    def get(self, employee_id: str) -> LoadedExpertProjection | None:
        return self._items.get(employee_id)

    def available(self) -> list[LoadedExpertProjection]:
        return sorted(
            (p for p in self._items.values() if not p.revoked),
            key=lambda p: p.employee_id,
        )

    def list_all(self) -> list[LoadedExpertProjection]:
        return sorted(self._items.values(), key=lambda p: p.employee_id)


class SnapshotRepository(ABC):
    """冻结执行快照仓储（写端 Agent，04 §6.3，D5）。"""

    @abstractmethod
    def freeze(self, snapshot: EmployeeExecutionSnapshot) -> EmployeeExecutionSnapshot:
        """冻结快照。同 (employee_id, snapshot_version) 幂等返回既有（不覆盖）。"""

    @abstractmethod
    def get(
        self, employee_id: str, snapshot_version: str
    ) -> EmployeeExecutionSnapshot | None: ...

    @abstractmethod
    def latest(self, employee_id: str) -> EmployeeExecutionSnapshot | None:
        """该 employee 最近冻结的快照（Manager 离线时回退装载用）。"""

    @abstractmethod
    def list_all(self) -> list[EmployeeExecutionSnapshot]: ...


class InMemorySnapshotRepository(SnapshotRepository):
    """内存冻结快照（本地库占位；接口稳定，真实持久化后续替换）。"""

    def __init__(self) -> None:
        # 主键 (employee_id, snapshot_version) → 快照；插入序保留供 latest()。
        self._items: dict[tuple[str, str], EmployeeExecutionSnapshot] = {}
        self._latest_version: dict[str, str] = {}

    def freeze(self, snapshot: EmployeeExecutionSnapshot) -> EmployeeExecutionSnapshot:
        key = (snapshot.employee_id, snapshot.snapshot_version)
        existing = self._items.get(key)
        if existing is not None:
            # 冻结语义：已取得即不可变，幂等返回既有，不覆盖。
            return existing
        self._items[key] = snapshot
        self._latest_version[snapshot.employee_id] = snapshot.snapshot_version
        return snapshot

    def get(
        self, employee_id: str, snapshot_version: str
    ) -> EmployeeExecutionSnapshot | None:
        return self._items.get((employee_id, snapshot_version))

    def latest(self, employee_id: str) -> EmployeeExecutionSnapshot | None:
        version = self._latest_version.get(employee_id)
        if version is None:
            return None
        return self._items.get((employee_id, version))

    def list_all(self) -> list[EmployeeExecutionSnapshot]:
        return sorted(
            self._items.values(),
            key=lambda s: (s.employee_id, s.snapshot_version),
        )
