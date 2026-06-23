"""
引擎状态管理模块
"""
from dataclasses import dataclass, field
from typing import Dict, Set, Any, Optional
import time


@dataclass
class EngineState:
    """可序列化的引擎状态"""
    run_id: str
    manifest_ref: str  # manifest 存储引用
    workspace_id: str
    orchestrator_issue_id: Optional[str] = None  # orchestrator issue ID（用于进度报告）
    key_to_id: Dict[str, str] = field(default_factory=dict)  # node_key -> issue_id
    completed: Set[str] = field(default_factory=set)  # 已完成节点
    failed: Set[str] = field(default_factory=set)  # 已失败节点
    in_progress: Set[str] = field(default_factory=set)  # 进行中节点
    current_wave: int = 0
    start_time: float = field(default_factory=time.time)
    last_update_time: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)  # 额外元数据

    def to_dict(self) -> dict:
        """序列化为字典"""
        return {
            "run_id": self.run_id,
            "manifest_ref": self.manifest_ref,
            "workspace_id": self.workspace_id,
            "orchestrator_issue_id": self.orchestrator_issue_id,
            "key_to_id": self.key_to_id,
            "completed": list(self.completed),
            "failed": list(self.failed),
            "in_progress": list(self.in_progress),
            "current_wave": self.current_wave,
            "start_time": self.start_time,
            "last_update_time": self.last_update_time,
            "metadata": self.metadata
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'EngineState':
        """从字典反序列化"""
        return cls(
            run_id=data["run_id"],
            manifest_ref=data["manifest_ref"],
            workspace_id=data["workspace_id"],
            orchestrator_issue_id=data.get("orchestrator_issue_id"),
            key_to_id=data.get("key_to_id", {}),
            completed=set(data.get("completed", [])),
            failed=set(data.get("failed", [])),
            in_progress=set(data.get("in_progress", [])),
            current_wave=data.get("current_wave", 0),
            start_time=data.get("start_time", time.time()),
            last_update_time=data.get("last_update_time", time.time()),
            metadata=data.get("metadata", {})
        )

    def mark_started(self, key: str):
        """标记节点开始"""
        self.in_progress.add(key)
        self.last_update_time = time.time()

    def mark_completed(self, key: str):
        """标记节点完成"""
        self.in_progress.discard(key)
        self.completed.add(key)
        self.failed.discard(key)  # 如果之前失败过，现在成功了
        self.last_update_time = time.time()

    def mark_failed(self, key: str):
        """标记节点失败"""
        self.in_progress.discard(key)
        self.failed.add(key)
        self.last_update_time = time.time()

    def get_total_nodes(self) -> int:
        """获取总节点数"""
        return len(self.key_to_id)

    def get_progress_stats(self) -> dict:
        """获取进度统计"""
        total = self.get_total_nodes()
        return {
            "total": total,
            "completed": len(self.completed),
            "failed": len(self.failed),
            "in_progress": len(self.in_progress),
            "todo": total - len(self.completed) - len(self.failed) - len(self.in_progress),
            "progress_pct": (len(self.completed) / total * 100) if total > 0 else 0.0
        }

    def get_elapsed_time(self) -> float:
        """获取已用时间（秒）"""
        return time.time() - self.start_time
