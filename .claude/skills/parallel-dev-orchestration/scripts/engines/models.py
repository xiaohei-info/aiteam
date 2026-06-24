"""
通用数据模型 - 引擎无关，纯业务语义
"""
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum
from datetime import datetime


class WorkItemStatus(Enum):
    """工作单元状态（业务语义）"""
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    IN_REVIEW = "in_review"
    DONE = "done"
    FAILED = "failed"          # 任务逻辑失败（隔离下游，计入 failed）
    BLOCKED = "blocked"
    NEEDS_REASSIGN = "needs_reassign"  # worker 不可恢复故障，待 leader 改派（不隔离下游、不计 failed）


@dataclass
class WorkspaceInfo:
    """工作空间信息"""
    id: str
    name: str
    description: Optional[str] = None
    member_count: int = 0


@dataclass
class WorkItem:
    """工作单元 - 纯业务数据，不包含技术细节（body/labels/state）"""
    id: str
    workspace_id: str
    title: str
    description: str
    status: WorkItemStatus

    # 核心元数据
    dag_key: str
    worker: Optional[str] = None
    reviewer: Optional[str] = None
    blocked_by: List[str] = field(default_factory=list)
    wave: Optional[int] = None

    # 执行产物（由 worker 写入）
    artifacts: Optional[Dict[str, str]] = None
    # 例如: {"pr": "https://github.com/owner/repo/pull/123", "commit": "abc123"}

    # 审核信息（由 reviewer 写入）
    review_verdict: Optional[str] = None
    # 可能的值: "pass" | "pass-with-nits" | "blocked" | "needs-changes"
    review_comment: Optional[str] = None

    # worker run 失败的 runtime 原因文本（用于判定可恢复 vs 不可恢复）
    failure_reason: Optional[str] = None

    def is_completed(self) -> bool:
        """是否已完成"""
        return self.status == WorkItemStatus.DONE

    def is_in_progress(self) -> bool:
        """是否进行中"""
        return self.status == WorkItemStatus.IN_PROGRESS

    def is_failed(self) -> bool:
        """是否失败"""
        return self.status == WorkItemStatus.FAILED

    def is_blocked(self) -> bool:
        """是否被阻塞"""
        return self.status == WorkItemStatus.BLOCKED


class RunStatus(Enum):
    """Run 状态（业务语义）"""
    RUNNING = "running"
    COMPLETED = "completed"
    PAUSED = "paused"
    FAILED = "failed"


@dataclass
class Run:
    """编排运行 - 业务对象"""
    id: str
    workspace_id: str
    status: RunStatus
    manifest_name: str
    created_at: datetime
    updated_at: datetime

    # 进度信息
    total_tasks: int
    completed_tasks: int
    failed_tasks: int

    # 元数据
    orchestrator_issue_id: Optional[str] = None

    @property
    def progress_percent(self) -> float:
        """进度百分比"""
        if self.total_tasks == 0:
            return 0.0
        return (self.completed_tasks / self.total_tasks) * 100

    @property
    def in_progress_tasks(self) -> int:
        """进行中的任务数"""
        return self.total_tasks - self.completed_tasks - self.failed_tasks

    def to_dict(self) -> dict:
        """转换为字典（用于序列化）"""
        return {
            "id": self.id,
            "workspace_id": self.workspace_id,
            "status": self.status.value,
            "manifest_name": self.manifest_name,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "total_tasks": self.total_tasks,
            "completed_tasks": self.completed_tasks,
            "failed_tasks": self.failed_tasks,
            "orchestrator_issue_id": self.orchestrator_issue_id
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'Run':
        """从字典创建（用于反序列化）"""
        return cls(
            id=data["id"],
            workspace_id=data["workspace_id"],
            status=RunStatus(data["status"]),
            manifest_name=data["manifest_name"],
            created_at=datetime.fromisoformat(data["created_at"]),
            updated_at=datetime.fromisoformat(data["updated_at"]),
            total_tasks=data["total_tasks"],
            completed_tasks=data["completed_tasks"],
            failed_tasks=data["failed_tasks"],
            orchestrator_issue_id=data.get("orchestrator_issue_id")
        )


@dataclass
class EngineConfig:
    """引擎配置

    workspace_id 与 squad_id 的区别（以 multica 为例）：
    - workspace_id：顶层工作空间，定位"在哪个空间建 issue / 找成员"，来自 env/配置（与 multica CLI 的全局 --workspace-id / MULTICA_WORKSPACE_ID 对齐）
    - squad_id：工作空间内的小队，派发与成员池都限定在该小队，来自 manifest 的 squad 字段

    github / mock 无小队概念时，squad_id 可与 workspace_id 同值或留空。
    """
    engine_type: str  # 'multica' | 'github' | 'mock'
    workspace_id: str  # multica: workspace_id（env）, github: owner/repo
    squad_id: Optional[str] = None  # multica: 小队 id（manifest.squad）；其它引擎可空

    # 轮询配置
    polling_interval: int = 30  # 默认 30 秒
    polling_interval_min: int = 10
    polling_interval_max: int = 300

    # 同一节点连续失败达此次数即判 worker 不可用、挂起待改派
    max_consecutive_failures: int = 3

    # 引擎特定配置（可选）
    extra: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_env(cls, env_dict: Dict[str, str]) -> 'EngineConfig':
        """从环境变量字典创建配置"""
        engine_type = env_dict.get('ENGINE_TYPE', 'multica')

        if engine_type == 'multica':
            workspace_id = env_dict.get('MULTICA_WORKSPACE_ID', '')
        elif engine_type == 'github':
            workspace_id = env_dict.get('GITHUB_REPO', '')
        elif engine_type == 'mock':
            workspace_id = env_dict.get('MOCK_WORKSPACE_ID', 'mock-workspace')
        else:
            workspace_id = ''

        # 读取轮询配置
        polling_interval = int(env_dict.get('POLLING_INTERVAL', '30'))
        polling_interval_min = int(env_dict.get('POLLING_INTERVAL_MIN', '10'))
        polling_interval_max = int(env_dict.get('POLLING_INTERVAL_MAX', '300'))

        return cls(
            engine_type=engine_type,
            workspace_id=workspace_id,
            squad_id=env_dict.get('MULTICA_SQUAD_ID') or None,
            polling_interval=polling_interval,
            polling_interval_min=polling_interval_min,
            polling_interval_max=polling_interval_max,
            max_consecutive_failures=int(env_dict.get('MAX_CONSECUTIVE_FAILURES', '3')),
            extra=env_dict
        )
