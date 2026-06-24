"""
CollaborationEngine 抽象接口 - 纯业务语义
"""
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
from .models import WorkspaceInfo, WorkItem, WorkItemStatus, EngineConfig


class CollaborationEngine(ABC):
    """协作引擎抽象接口

    设计原则：
    1. 接口定义业务语义，不暴露技术细节（labels/body/state）
    2. 实现方式由各引擎内部决定
    3. 引擎只管状态和元数据，不管执行（执行由外部 worker 负责）
    """

    def __init__(self, config: EngineConfig):
        self.config = config

    # ==================== 环境变量管理 ====================

    @classmethod
    @abstractmethod
    def get_required_env_vars(cls) -> List[Dict[str, str]]:
        """声明引擎需要的环境变量

        返回格式：
        [
            {
                'name': 'MULTICA_WORKSPACE_ID',
                'description': '工作空间 ID',
                'prompt': '请输入 multica workspace ID:',
                'validator': lambda x: len(x) > 0
            }
        ]
        """
        pass

    @classmethod
    def get_common_env_vars(cls) -> List[Dict[str, str]]:
        """通用环境变量（所有引擎共享）"""
        return [
            {
                'name': 'ENGINE_TYPE',
                'description': '引擎类型',
                'prompt': '选择引擎类型',
                'choices': ['multica', 'github', 'mock']
            },
            {
                'name': 'POLLING_INTERVAL',
                'description': '轮询间隔（秒）',
                'prompt': '请输入轮询间隔（秒，默认 30）',
                'default': '30',
                'validator': lambda x: x.isdigit() and 10 <= int(x) <= 300
            }
        ]

    @classmethod
    def get_recommended_polling_interval(cls) -> int:
        """返回推荐的轮询间隔（秒）

        各引擎可以根据平台特性覆盖
        """
        return 30  # 默认 30 秒

    @classmethod
    def get_rate_limit_info(cls) -> Dict[str, int]:
        """返回平台的 API 限额信息"""
        return {
            "requests_per_hour": 5000,
            "requests_per_minute": 100
        }

    # ==================== 第一组：工作空间（1 个）====================

    @abstractmethod
    def list_members(self, workspace_id: str) -> List[str]:
        """列出工作空间中可分配任务的成员

        业务语义：查询可用的 worker/reviewer

        multica: multica agent list
        github: repo collaborators

        返回：['alice', 'bob', 'charlie']
        """
        pass

    # ==================== 第二组：工作单元 CRUD（5 个）====================

    @abstractmethod
    def create_work_item(
        self,
        workspace_id: str,
        title: str,
        description: str,
        dag_key: str,
        worker: str,
        reviewer: Optional[str] = None,
        blocked_by: Optional[List[str]] = None,
        wave: Optional[int] = None,
        initial_status: WorkItemStatus = WorkItemStatus.TODO
    ) -> WorkItem:
        """创建工作单元

        业务语义：创建一个任务，指定元数据和初始状态

        multica: issue create + metadata set
        github: issue create，body 包含 YAML frontmatter + 添加 status label

        参数：
            workspace_id: 工作空间 ID
            title: 任务标题
            description: 任务描述
            dag_key: DAG 节点标识（用于查找和去重）
            worker: 执行者（必填）
            reviewer: 审核者（可选）
            blocked_by: 依赖的 DAG key 列表
            wave: 所属 wave
            initial_status: 初始状态（默认 TODO）

        返回：创建的 WorkItem
        """
        pass

    @abstractmethod
    def get_work_item(self, item_id: str) -> WorkItem:
        """获取工作单元详情

        业务语义：查询任务的当前状态和元数据

        multica: issue get，从 metadata 解析
        github: issue get，从 body YAML 解析

        返回的 WorkItem 包含所有业务字段（status/worker/artifacts/review_verdict 等）
        """
        pass

    @abstractmethod
    def update_work_item_metadata(
        self,
        item_id: str,
        worker: Optional[str] = None,
        reviewer: Optional[str] = None,
        blocked_by: Optional[List[str]] = None,
        artifacts: Optional[Dict[str, str]] = None,
        review_verdict: Optional[str] = None,
        review_comment: Optional[str] = None
    ) -> WorkItem:
        """更新工作单元的元数据

        业务语义：修改任务的分配、依赖关系、产物、审核结果

        multica: issue metadata set
        github: 更新 issue body 的 YAML frontmatter

        参数为 None 表示不更新该字段
        """
        pass

    @abstractmethod
    def list_work_items(
        self,
        workspace_id: str,
        status: Optional[WorkItemStatus] = None
    ) -> List[WorkItem]:
        """列出工作单元

        业务语义：查询任务列表，可按状态过滤

        multica: issue list --status
        github: issue list，按 status:xxx label 过滤
        """
        pass

    @abstractmethod
    def add_comment(self, item_id: str, comment: str):
        """添加评论

        业务语义：发送进度报告或通知

        multica: issue comment
        github: issue comment
        """
        pass

    # ==================== 第三组：状态和分配（2 个）====================

    @abstractmethod
    def update_status(self, item_id: str, status: WorkItemStatus):
        """更新工作单元状态

        业务语义：标记任务进入新阶段（开始/完成/失败）

        multica: issue update --status in_progress
        github: 更新 labels（添加 status:in-progress，移除旧的）
        """
        pass

    @abstractmethod
    def assign_work_item(
        self,
        item_id: str,
        assignee: str,
        role: str  # "worker" | "reviewer"
    ):
        """将任务（重新）分配给指定协作者

        业务语义：指定谁来执行/审核这个任务

        multica: issue assign --to agent_id + 更新 metadata
        github: gh issue edit --add-assignee + 更新 body YAML + 添加 role label

        用途：
        - 重新分配失败的任务
        - 动态负载均衡
        - worker 完成后分配给 reviewer
        """
        pass

    # ==================== 第四组：查询（1 个）====================

    @abstractmethod
    def find_work_item_by_dag_key(
        self,
        workspace_id: str,
        dag_key: str
    ) -> Optional[WorkItem]:
        """按 DAG key 查找工作单元

        业务语义：查找对应 manifest 节点的任务（避免重复创建）

        multica: issue list + 过滤 metadata.dag_key
        github: 搜索 title 中的 [DAG:xxx] 或 body YAML
        """
        pass

    # ==================== 便捷方法（基类实现）====================

    def check_member_exists(self, workspace_id: str, member_name: str) -> bool:
        """检查成员是否存在（基类实现）"""
        members = self.list_members(workspace_id)
        return member_name in members

    def mark_in_progress(self, item_id: str):
        """标记为进行中（便捷方法）"""
        self.update_status(item_id, WorkItemStatus.IN_PROGRESS)

    def mark_done(self, item_id: str):
        """标记为完成（便捷方法）"""
        self.update_status(item_id, WorkItemStatus.DONE)

    def mark_failed(self, item_id: str):
        """标记为失败（便捷方法）"""
        self.update_status(item_id, WorkItemStatus.FAILED)

    def mark_blocked(self, item_id: str):
        """标记为阻塞（便捷方法）"""
        self.update_status(item_id, WorkItemStatus.BLOCKED)

    def mark_in_review(self, item_id: str):
        """标记为审核中（便捷方法）"""
        self.update_status(item_id, WorkItemStatus.IN_REVIEW)
