"""授权配置 sync + 快照冻结编排（A4，04 §6.2/§6.3，D5/D12/D14）。

薄编排层串起数据流：

  sync（F10/D12）：
    本地投影版本 → AuthorizedConfigPullRequest(known_versions)
    → client.pull_authorized_config → 增量 experts 落投影 + revoked_ids 失效移除
    + solutions 落方案实例投影（供"从解决方案创建群聊"入口使用）

  freeze_snapshot（F11/D5）：
    employee_id(+version) → SnapshotPullRequest → client.pull_snapshot
    → 本地冻结 EmployeeExecutionSnapshot（一旦取得即持久、不随 Manager 离线失效）

  本地读（对话/装载路径）：只读本地投影 available() 与已冻结快照，不每次跨端取配置。

离线降级（D14）：pull 失败（Manager 不可达/超时）→ **不抛出**到本地就绪/读路径，
返回结果中标记 ok=False，已有投影与已冻结快照不受影响、继续可用。
"""

from __future__ import annotations

from datetime import datetime, timezone

from shared.contracts.crosstier import (
    AuthorizedConfigPullRequest,
    SnapshotPullRequest,
)
from shared.contracts.grants import LoadedExpertProjection
from shared.contracts.snapshot import EmployeeExecutionSnapshot

from .client import ManagerGrantsClient
from .store import ProjectionRepository, SnapshotRepository, SolutionProjectionRepository


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SyncResult:
    """一次 sync 的结果摘要（观测/降级判定用）。

    ok=False 表示 Manager 不可达——本地保持既有投影继续工作（D14），不视为本端 not-ready。
    """

    def __init__(
        self,
        *,
        ok: bool,
        upserted: int = 0,
        revoked: int = 0,
        error: str | None = None,
    ) -> None:
        self.ok = ok
        self.upserted = upserted
        self.revoked = revoked
        self.error = error

    def __repr__(self) -> str:  # pragma: no cover - 诊断用
        return (
            f"SyncResult(ok={self.ok}, upserted={self.upserted}, "
            f"revoked={self.revoked}, error={self.error!r})"
        )


def _to_projection(tenant_id: str, raw: dict) -> LoadedExpertProjection:
    """把 Manager 投影源 dict 映射为本地只读投影。

    Manager 端 Projection 源即 EmployeeConfigOut.model_dump(mode="json")，已含 skills/
    knowledge_refs/connector_refs/memory_policy/model_policy/runtime_policy 等中立配置。
    本函数把这些字段透传到本地投影，确保 Agent 端专家继承模板的全部能力配置（AITEAM-288）。

    只读白名单字段构造，缺失字段用契约默认；employee_id/version 必备（投影主键 + 增量键）。
    """
    from shared.contracts.snapshot import ModelPolicy, RuntimePolicy

    model_policy_raw = raw.get("model_policy") or {}
    runtime_policy_raw = raw.get("runtime_policy") or {}
    return LoadedExpertProjection(
        employee_id=str(raw["employee_id"]),
        tenant_id=tenant_id,
        version=str(raw.get("version", "")),
        display_name=str(raw.get("display_name", "")),
        runtime_binding=raw.get("runtime_binding"),
        persona=raw.get("persona"),
        model_policy=ModelPolicy(**model_policy_raw) if isinstance(model_policy_raw, dict) else ModelPolicy(),
        runtime_policy=RuntimePolicy(**runtime_policy_raw) if isinstance(runtime_policy_raw, dict) else RuntimePolicy(),
        tools=_as_str_list(raw.get("tools")),
        skills=_as_str_list(raw.get("skills")),
        knowledge_refs=_as_str_list(raw.get("knowledge_refs")),
        connector_refs=_as_str_list(raw.get("connector_refs")),
        memory_policy=raw.get("memory_policy"),
        synced_at=_now(),
        revoked=False,
    )


def _as_str_list(value) -> list[str]:
    """安全地把未知 JSON 值转成 str 列表（None / 非 list 一律返回空列表）。"""
    if not isinstance(value, list):
        return []
    return [str(v) for v in value if v is not None and str(v) != ""]


class GrantsService:
    """用户端授权配置投影 + 冻结快照服务。"""

    def __init__(
        self,
        *,
        client: ManagerGrantsClient,
        projections: ProjectionRepository,
        snapshots: SnapshotRepository,
        solutions: SolutionProjectionRepository | None = None,
    ) -> None:
        self._client = client
        self._projections = projections
        self._snapshots = snapshots
        self._solutions = solutions

    # ---- F10 授权配置 sync（D12：主动 pull，绝不接受推送）----

    def sync(self, tenant_id: str, member_id: str) -> SyncResult:
        """主动 pull Manager 授权配置增量并落本地投影。尽力而为，不抛出（D14）。

        失败（Manager 不可达）→ ok=False，已有投影保持不变继续可用。
        """
        request = AuthorizedConfigPullRequest(
            tenant_id=tenant_id,
            member_id=member_id,
            known_versions={
                p.employee_id: p.version for p in self._projections.list_all()
            },
        )
        try:
            response = self._client.pull_authorized_config(request)
        except Exception as exc:  # noqa: BLE001 — 离线降级：失败不影响本地既有投影（D14）
            return SyncResult(ok=False, error=str(exc))

        upserted = 0
        for raw in response.experts:
            self._projections.upsert(_to_projection(tenant_id, raw))
            upserted += 1

        revoked = 0
        for employee_id in response.revoked_ids:
            if self._projections.revoke(employee_id) is not None:
                revoked += 1

        # 方案实例投影（可选仓储；未配则跳过——pull 响应中的 solutions[] 暂不落库）。
        if self._solutions is not None:
            seen: set[str] = set()
            for raw in response.solutions:
                sid = str(raw.get("solution_id", raw.get("id", "")))
                if not sid:
                    continue
                self._solutions.upsert(raw)
                seen.add(sid)

        return SyncResult(ok=True, upserted=upserted, revoked=revoked)

    def available_experts(self) -> list[LoadedExpertProjection]:
        """对话/装载路径可用专家（已授权未撤销）。只读本地投影，不跨端。"""
        return self._projections.available()

    def list_available_solutions(self) -> list[dict]:
        """列出本端当前可用的方案实例投影（含三阶段 prompts 快照）。

        供"从解决方案创建群聊"前端入口使用。未配置方案仓储时返回空列表（降级）。
        """
        if self._solutions is None:
            return []
        return [p.to_dict() for p in self._solutions.available()]

    # ---- F11 执行快照冻结（D5：装载/提交 run 时拉取并冻结）----

    def freeze_snapshot(
        self,
        tenant_id: str,
        member_id: str,
        employee_id: str,
        employee_version: str | None = None,
    ) -> EmployeeExecutionSnapshot:
        """pull Manager 执行快照并本地冻结；返回冻结后的快照。

        在线路径：装载专家/提交 run 时调用。Manager 不可达时调用方应改用
        load_snapshot()/latest_snapshot() 回退到已冻结快照（D14）——本方法在线 pull 失败
        会向上抛出，由调用方决定回退。
        """
        request = SnapshotPullRequest(
            tenant_id=tenant_id,
            member_id=member_id,
            employee_id=employee_id,
            employee_version=employee_version,
        )
        response = self._client.pull_snapshot(request)
        return self._snapshots.freeze(response.snapshot)

    def load_snapshot(
        self, employee_id: str, snapshot_version: str
    ) -> EmployeeExecutionSnapshot | None:
        """从本地冻结库取指定快照（run 全程引用，Manager 离线仍可用）。"""
        return self._snapshots.get(employee_id, snapshot_version)

    def latest_snapshot(self, employee_id: str) -> EmployeeExecutionSnapshot | None:
        """该 employee 最近冻结的快照（Manager 离线时回退装载执行用，D14）。"""
        return self._snapshots.latest(employee_id)

    def frozen_snapshots(self) -> list[EmployeeExecutionSnapshot]:
        """列全部已冻结快照（观测用）。"""
        return self._snapshots.list_all()
