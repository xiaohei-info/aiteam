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

import json

from pydantic import BaseModel, ConfigDict, Field
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import EmployeeExecutionSnapshot

from ..local_db import LocalDb


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


# ---- SQLite 实现（agent 本地库；与内存实现行为等价，重启不丢）----

def _iso(dt: datetime) -> str:
    return dt.isoformat()


class SqliteProjectionRepository(ProjectionRepository):
    """SQLite 投影仓储（本地库持久化，#159）。"""

    def __init__(self, db: LocalDb) -> None:
        self._db = db

    @staticmethod
    def _row_to_projection(row) -> LoadedExpertProjection:
        """由 SQLite 行构造 LoadedExpertProjection。

        新加列（persona/model_policy/runtime_policy/tools/skills/knowledge_refs/
        connector_refs/memory_policy）在旧库/无 Manager 同步行可能缺失 → 用 Pydantic 默认值；
        对 JSON 文本列做安全解析（解析失败时回退默认）。
        """
        from shared.contracts.grants import LoadedExpertProjection
        from shared.contracts.snapshot import ModelPolicy, RuntimePolicy

        data = dict(row)
        data["revoked"] = bool(data["revoked"])

        def _json(value, default):
            if value is None:
                return default
            if isinstance(value, (dict, list)):
                return value
            try:
                return json.loads(value)
            except Exception:
                return default

        model_policy = _json(data.get("model_policy"), {})
        runtime_policy = _json(data.get("runtime_policy"), {})
        return LoadedExpertProjection(
            employee_id=str(data["employee_id"]),
            tenant_id=str(data.get("tenant_id", "")),
            version=str(data.get("version", "")),
            display_name=str(data.get("display_name", "")),
            runtime_binding=data.get("runtime_binding"),
            persona=data.get("persona"),
            model_policy=ModelPolicy(**model_policy) if isinstance(model_policy, dict) else ModelPolicy(),
            runtime_policy=RuntimePolicy(**runtime_policy) if isinstance(runtime_policy, dict) else RuntimePolicy(),
            tools=_json(data.get("tools"), []),
            skills=_json(data.get("skills"), []),
            knowledge_refs=_json(data.get("knowledge_refs"), []),
            connector_refs=_json(data.get("connector_refs"), []),
            memory_policy=_json(data.get("memory_policy"), None),
            synced_at=data.get("synced_at"),
            revoked=bool(data["revoked"]),
        )

    def upsert(self, projection: LoadedExpertProjection) -> LoadedExpertProjection:
        existing_row = self._db.query_one(
            "SELECT * FROM loaded_expert_projections WHERE employee_id = ?",
            (projection.employee_id,),
        )
        if existing_row is not None:
            # 更新既有投影（含模板配置字段）
            self._db.execute(
                "UPDATE loaded_expert_projections SET tenant_id = ?, version = ?, display_name = ?, "
                "runtime_binding = ?, persona = ?, model_policy = ?, runtime_policy = ?, "
                "tools = ?, skills = ?, knowledge_refs = ?, connector_refs = ?, "
                "memory_policy = ?, synced_at = ?, revoked = ? WHERE employee_id = ?",
                (projection.tenant_id, projection.version, projection.display_name,
                 projection.runtime_binding, projection.persona,
                 json.dumps(projection.model_policy.model_dump()),
                 json.dumps(projection.runtime_policy.model_dump()),
                 json.dumps(projection.tools), json.dumps(projection.skills),
                 json.dumps(projection.knowledge_refs), json.dumps(projection.connector_refs),
                 json.dumps(projection.memory_policy) if projection.memory_policy else None,
                 _iso(projection.synced_at) if projection.synced_at else None,
                 int(projection.revoked), projection.employee_id),
            )
        else:
            # 新建投影（含模板配置字段）
            self._db.execute(
                "INSERT INTO loaded_expert_projections "
                "(employee_id, tenant_id, version, display_name, runtime_binding, persona, "
                "model_policy, runtime_policy, tools, skills, knowledge_refs, connector_refs, "
                "memory_policy, synced_at, revoked) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (projection.employee_id, projection.tenant_id, projection.version,
                 projection.display_name, projection.runtime_binding, projection.persona,
                 json.dumps(projection.model_policy.model_dump()),
                 json.dumps(projection.runtime_policy.model_dump()),
                 json.dumps(projection.tools), json.dumps(projection.skills),
                 json.dumps(projection.knowledge_refs), json.dumps(projection.connector_refs),
                 json.dumps(projection.memory_policy) if projection.memory_policy else None,
                 _iso(projection.synced_at) if projection.synced_at else None,
                 int(projection.revoked)),
            )
        return projection

    def revoke(self, employee_id: str) -> LoadedExpertProjection | None:
        existing_row = self._db.query_one(
            "SELECT * FROM loaded_expert_projections WHERE employee_id = ?", (employee_id,)
        )
        if existing_row is None:
            return None
        self._db.execute(
            "UPDATE loaded_expert_projections SET revoked = 1, synced_at = ? WHERE employee_id = ?",
            (_iso(_now()), employee_id),
        )
        row = self._db.query_one(
            "SELECT * FROM loaded_expert_projections WHERE employee_id = ?", (employee_id,)
        )
        return self._row_to_projection(row)

    def get(self, employee_id: str) -> LoadedExpertProjection | None:
        row = self._db.query_one(
            "SELECT * FROM loaded_expert_projections WHERE employee_id = ?", (employee_id,)
        )
        return self._row_to_projection(row) if row else None

    def available(self) -> list[LoadedExpertProjection]:
        rows = self._db.query(
            "SELECT * FROM loaded_expert_projections WHERE revoked = 0 ORDER BY employee_id"
        )
        return [self._row_to_projection(r) for r in rows]

    def list_all(self) -> list[LoadedExpertProjection]:
        rows = self._db.query(
            "SELECT * FROM loaded_expert_projections ORDER BY employee_id"
        )
        return [self._row_to_projection(r) for r in rows]


class SqliteSnapshotRepository(SnapshotRepository):
    """SQLite 快照仓储（本地库持久化，#159）。"""

    def __init__(self, db: LocalDb) -> None:
        self._db = db

    @staticmethod
    def _row_to_snapshot(row) -> EmployeeExecutionSnapshot:
        data = dict(row)
        # frozen_at 是数据库字段，不是 EmployeeExecutionSnapshot 模型的一部分
        data.pop("frozen_at", None)
        data["model_policy"] = json.loads(data["model_policy"])
        data["runtime_policy"] = json.loads(data["runtime_policy"])
        data["tools"] = json.loads(data["tools"])
        data["skills"] = json.loads(data["skills"])
        data["knowledge_refs"] = json.loads(data["knowledge_refs"])
        data["connector_refs"] = json.loads(data["connector_refs"])
        data["memory_policy"] = json.loads(data["memory_policy"]) if data["memory_policy"] else None
        return EmployeeExecutionSnapshot(**data)

    def freeze(self, snapshot: EmployeeExecutionSnapshot) -> EmployeeExecutionSnapshot:
        existing_row = self._db.query_one(
            "SELECT * FROM employee_execution_snapshots WHERE employee_id = ? AND snapshot_version = ?",
            (snapshot.employee_id, snapshot.snapshot_version),
        )
        if existing_row is not None:
            # 冻结语义：已取得即不可变，幂等返回既有，不覆盖。
            return self._row_to_snapshot(existing_row)
        # 新建快照（frozen_at 由本地生成，不是快照对象的一部分）
        self._db.execute(
            "INSERT INTO employee_execution_snapshots "
            "(employee_id, version, snapshot_version, display_name, persona, model_policy, runtime_policy, "
            "tools, skills, knowledge_refs, connector_refs, memory_policy, frozen_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (snapshot.employee_id, snapshot.version, snapshot.snapshot_version, snapshot.display_name,
             snapshot.persona,
             json.dumps(snapshot.model_policy.model_dump()),
             json.dumps(snapshot.runtime_policy.model_dump()),
             json.dumps(snapshot.tools), json.dumps(snapshot.skills),
             json.dumps(snapshot.knowledge_refs), json.dumps(snapshot.connector_refs),
             json.dumps(snapshot.memory_policy) if snapshot.memory_policy else None,
             _iso(_now())),  # frozen_at 由本地生成
        )
        return snapshot

    def get(
        self, employee_id: str, snapshot_version: str
    ) -> EmployeeExecutionSnapshot | None:
        row = self._db.query_one(
            "SELECT * FROM employee_execution_snapshots WHERE employee_id = ? AND snapshot_version = ?",
            (employee_id, snapshot_version),
        )
        return self._row_to_snapshot(row) if row else None

    def latest(self, employee_id: str) -> EmployeeExecutionSnapshot | None:
        row = self._db.query_one(
            "SELECT * FROM employee_execution_snapshots WHERE employee_id = ? "
            "ORDER BY frozen_at DESC LIMIT 1",
            (employee_id,),
        )
        return self._row_to_snapshot(row) if row else None

    def list_all(self) -> list[EmployeeExecutionSnapshot]:
        rows = self._db.query(
            "SELECT * FROM employee_execution_snapshots ORDER BY employee_id, snapshot_version"
        )
        return [self._row_to_snapshot(r) for r in rows]


class SolutionProjection(BaseModel):
    """本端持有的方案实例投影（只读，供"从解决方案创建群聊"入口使用）。

    来源：Manager authorized config pull（F10）收到的 solutions[]。solution_id 即 Manager
    侧方案实例 id；三阶段 prompts 是 Operator solution_template 的快照，落会话后不再改；
    expert_employee_ids 是方案对应的专家群（用于建群时过滤 roster）。
    """

    model_config = ConfigDict(extra="forbid")

    solution_instance_id: str = Field(description="方案实例 id（Manager 侧 solution_instance 主键）")
    template_solution_id: str = Field("", description="Operator 目录模板 solution_id（追溯用，不当 instance id）")
    display_name: str = Field(description="方案显示名")
    version: str = Field("", description="方案版本")
    expert_employee_ids: list[str] = Field(default_factory=list, description="方案对应的专家 employee_id 列表")
    planner_prompt: str = Field("", description="planner 阶段编排规则")
    subtask_prompt: str = Field("", description="子任务拆解规则")
    aggregate_prompt: str = Field("", description="多专家聚合规则")

    def to_dict(self) -> dict:
        """映射为前端契约字段（solution_id → solution_instance_id）。"""
        d = self.model_dump(mode="json")
        d.pop("template_solution_id", None)
        return d


_SolutionProjectionInput = dict | SolutionProjection


def _as_solution_projection(raw: _SolutionProjectionInput) -> SolutionProjection:
    if isinstance(raw, SolutionProjection):
        return raw
    eids = raw.get("expert_employee_ids")
    if not isinstance(eids, list):
        eids = []
    return SolutionProjection(
        solution_instance_id=str(raw.get("id", raw.get("solution_instance_id", ""))),
        template_solution_id=str(raw.get("solution_id", raw.get("template_solution_id", ""))),
        display_name=str(raw.get("display_name", raw.get("name", ""))),
        version=str(raw.get("version", "")),
        expert_employee_ids=[str(x) for x in eids],
        planner_prompt=str(raw.get("planner_prompt", "")),
        subtask_prompt=str(raw.get("subtask_prompt", "")),
        aggregate_prompt=str(raw.get("aggregate_prompt", "")),
    )


class SolutionProjectionRepository(ABC):
    """方案实例本地只读投影仓储（写端 Agent，来源 Manager F10）。"""

    @abstractmethod
    def upsert(self, projection: _SolutionProjectionInput) -> SolutionProjection: ...

    @abstractmethod
    def remove(self, solution_id: str) -> SolutionProjection | None: ...

    @abstractmethod
    def get(self, solution_id: str) -> SolutionProjection | None: ...

    @abstractmethod
    def available(self) -> list[SolutionProjection]:
        """可用方案列表（按 solution_id 排序）。"""

    @abstractmethod
    def list_all(self) -> list[SolutionProjection]: ...


class InMemorySolutionProjectionRepository(SolutionProjectionRepository):
    def __init__(self) -> None:
        self._items: dict[str, SolutionProjection] = {}

    def upsert(self, projection: _SolutionProjectionInput) -> SolutionProjection:
        p = _as_solution_projection(projection)
        self._items[p.solution_instance_id] = p
        return p

    def remove(self, solution_id: str) -> SolutionProjection | None:
        return self._items.pop(solution_id, None)

    def get(self, solution_id: str) -> SolutionProjection | None:
        return self._items.get(solution_id)

    def available(self) -> list[SolutionProjection]:
        return sorted(self._items.values(), key=lambda p: p.solution_instance_id)

    def list_all(self) -> list[SolutionProjection]:
        return sorted(self._items.values(), key=lambda p: p.solution_instance_id)


class SqliteSolutionProjectionRepository(SolutionProjectionRepository):
    def __init__(self, db: "LocalDb") -> None:
        self._db = db

    def _row_to_projection(self, row) -> SolutionProjection:
        d = dict(row)
        eids_raw = d.get("expert_employee_ids") or "[]"
        try:
            eids = json.loads(eids_raw) if isinstance(eids_raw, str) else list(eids_raw)
        except (ValueError, TypeError):
            eids = []
        if not isinstance(eids, list):
            eids = []
        return SolutionProjection(
            solution_instance_id=d["solution_id"],
            display_name=d.get("display_name", ""),
            version=d.get("version", ""),
            expert_employee_ids=[str(x) for x in eids],
            planner_prompt=d.get("planner_prompt", ""),
            subtask_prompt=d.get("subtask_prompt", ""),
            aggregate_prompt=d.get("aggregate_prompt", ""),
        )

    def upsert(self, projection: _SolutionProjectionInput) -> SolutionProjection:
        p = _as_solution_projection(projection)
        self._db.execute(
            "INSERT INTO solution_projections "
            "(solution_id, display_name, version, expert_employee_ids, "
            "planner_prompt, subtask_prompt, aggregate_prompt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(solution_id) DO UPDATE SET display_name=excluded.display_name, "
            "version=excluded.version, expert_employee_ids=excluded.expert_employee_ids, "
            "planner_prompt=excluded.planner_prompt, "
            "subtask_prompt=excluded.subtask_prompt, aggregate_prompt=excluded.aggregate_prompt",
            (p.solution_instance_id, p.display_name, p.version, json.dumps(p.expert_employee_ids),
             p.planner_prompt, p.subtask_prompt, p.aggregate_prompt),
        )
        return p

    def remove(self, solution_id: str) -> SolutionProjection | None:
        existing = self.get(solution_id)
        if existing is None:
            return None
        self._db.execute("DELETE FROM solution_projections WHERE solution_id = ?", (solution_id,))
        return existing

    def get(self, solution_id: str) -> SolutionProjection | None:
        row = self._db.query_one(
            "SELECT * FROM solution_projections WHERE solution_id = ?", (solution_id,)
        )
        return self._row_to_projection(row) if row else None

    def available(self) -> list[SolutionProjection]:
        rows = self._db.query("SELECT * FROM solution_projections ORDER BY solution_id")
        return [self._row_to_projection(r) for r in rows]

    def list_all(self) -> list[SolutionProjection]:
        rows = self._db.query("SELECT * FROM solution_projections ORDER BY solution_id")
        return [self._row_to_projection(r) for r in rows]
