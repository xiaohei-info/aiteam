"""
Mock 引擎实现 - 用于测试（自动完成任务）
"""
import time
import random
import json
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional
from .base import CollaborationEngine
from .models import WorkspaceInfo, WorkItem, WorkItemStatus, EngineConfig, Run, RunStatus


class MockEngine(CollaborationEngine):
    """Mock 引擎 - 内存模拟，用于测试

    特性：
    - 所有数据存储在内存中，不依赖外部服务
    - 自动模拟任务执行（分配后自动完成）
    """

    def __init__(self, config: EngineConfig):
        super().__init__(config)

        # 内存存储
        self._workspaces: Dict[str, WorkspaceInfo] = {}
        self._members: Dict[str, List[str]] = {}  # workspace_id -> [member_names]
        self._work_items: Dict[str, WorkItem] = {}  # item_id -> WorkItem
        self._runs: Dict[str, Run] = {}  # run_id -> Run
        self._run_checkpoints: Dict[str, dict] = {}  # run_id -> checkpoint data
        self._next_id = 1

        # 自动完成模拟
        self._auto_complete_enabled = config.extra.get('MOCK_AUTO_COMPLETE', 'true').lower() == 'true'
        self._auto_complete_delay = int(config.extra.get('MOCK_AUTO_COMPLETE_DELAY', '2'))  # 秒
        self._assigned_items: Dict[str, float] = {}  # item_id -> assign_time

        # 本地存储目录（用于持久化）
        self._state_dir = Path(config.extra.get('MOCK_STATE_DIR', '.multica_state'))
        self._state_dir.mkdir(exist_ok=True)

        # 初始化默认工作空间
        self._init_default_workspace()

    def _init_default_workspace(self):
        """初始化默认工作空间和成员"""
        workspace_id = self.config.workspace_id or "mock-workspace"

        self._workspaces[workspace_id] = WorkspaceInfo(
            id=workspace_id,
            name="Mock Workspace",
            description="测试用工作空间",
            member_count=3
        )

        self._members[workspace_id] = ["alice", "bob", "charlie"]

    def _auto_complete_check(self, item_id: str):
        """检查是否应该自动完成任务"""
        if not self._auto_complete_enabled:
            return

        if item_id not in self._assigned_items:
            return

        item = self._work_items.get(item_id)
        if not item:
            return

        # 检查是否到了自动完成时间
        elapsed = time.time() - self._assigned_items[item_id]
        if elapsed >= self._auto_complete_delay:
            # 自动完成
            if item.status == WorkItemStatus.IN_PROGRESS:
                print(f"[Mock] 🤖 自动完成任务 {item_id}")
                item.status = WorkItemStatus.DONE
                # 模拟产物
                item.artifacts = {"pr": f"https://mock.example.com/pr/{item_id}"}
                del self._assigned_items[item_id]

            elif item.status == WorkItemStatus.IN_REVIEW:
                print(f"[Mock] 🤖 自动审核通过任务 {item_id}")
                item.review_verdict = "pass"
                item.review_comment = "Mock: LGTM"
                del self._assigned_items[item_id]

    # ==================== 环境变量管理 ====================

    @classmethod
    def get_required_env_vars(cls) -> List[Dict[str, str]]:
        """Mock 引擎不需要额外环境变量"""
        return [
            {
                'name': 'MOCK_WORKSPACE_ID',
                'description': 'Mock 工作空间 ID（任意字符串）',
                'prompt': '请输入工作空间 ID',
                'default': 'mock-workspace',
                'validator': lambda x: len(x) > 0
            },
            {
                'name': 'MOCK_AUTO_COMPLETE',
                'description': '是否自动完成任务（true/false）',
                'prompt': '是否启用自动完成？',
                'default': 'true',
                'choices': ['true', 'false']
            },
            {
                'name': 'MOCK_AUTO_COMPLETE_DELAY',
                'description': '自动完成延迟（秒）',
                'prompt': '请输入自动完成延迟（秒）',
                'default': '2',
                'validator': lambda x: x.isdigit() and int(x) > 0
            }
        ]

    @classmethod
    def get_recommended_polling_interval(cls) -> int:
        # Mock 引擎可以很频繁
        return 1  # 1 秒轮询

    # ==================== 第一组：工作空间 ====================

    def list_members(self, workspace_id: str) -> List[str]:
        """列出工作空间成员"""
        return self._members.get(workspace_id, [])

    # ==================== 第二组：工作单元 CRUD ====================

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
        """创建工作单元"""
        item_id = str(self._next_id)
        self._next_id += 1

        work_item = WorkItem(
            id=item_id,
            workspace_id=workspace_id,
            title=f"[DAG:{dag_key}] {title}",
            description=description,
            status=initial_status,
            dag_key=dag_key,
            worker=worker,
            reviewer=reviewer,
            blocked_by=blocked_by or [],
            wave=wave
        )

        self._work_items[item_id] = work_item
        print(f"[Mock] 创建任务 {item_id}: {title}")
        return work_item

    def get_work_item(self, item_id: str) -> WorkItem:
        """获取工作单元详情"""
        if item_id not in self._work_items:
            raise RuntimeError(f"工作单元不存在: {item_id}")

        # 检查自动完成
        self._auto_complete_check(item_id)

        return self._work_items[item_id]

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
        """更新工作单元的元数据"""
        item = self.get_work_item(item_id)

        if worker is not None:
            item.worker = worker
        if reviewer is not None:
            item.reviewer = reviewer
        if blocked_by is not None:
            item.blocked_by = blocked_by
        if artifacts is not None:
            item.artifacts = artifacts
            print(f"[Mock] 任务 {item_id} 产物: {artifacts}")
        if review_verdict is not None:
            item.review_verdict = review_verdict
            print(f"[Mock] 任务 {item_id} 审核结果: {review_verdict}")
        if review_comment is not None:
            item.review_comment = review_comment

        return item

    def list_work_items(
        self,
        workspace_id: str,
        status: Optional[WorkItemStatus] = None
    ) -> List[WorkItem]:
        """列出工作单元"""
        items = [
            item for item in self._work_items.values()
            if item.workspace_id == workspace_id
        ]

        # 检查所有任务的自动完成
        for item in items:
            self._auto_complete_check(item.id)

        # 过滤 status
        if status:
            items = [item for item in items if item.status == status]

        return items

    def add_comment(self, item_id: str, comment: str):
        """添加评论（Mock 只打印）"""
        print(f"[Mock] 任务 {item_id} 评论: {comment[:80]}...")

    # ==================== 第三组：状态和分配 ====================

    def update_status(self, item_id: str, status: WorkItemStatus):
        """更新工作单元状态"""
        item = self.get_work_item(item_id)
        old_status = item.status
        item.status = status
        print(f"[Mock] 任务 {item_id} 状态: {old_status.value} -> {status.value}")

    def assign_work_item(
        self,
        item_id: str,
        assignee: str,
        role: str
    ):
        """分配任务给协作者"""
        item = self.get_work_item(item_id)
        if role == "worker":
            item.worker = assignee
        elif role == "reviewer":
            item.reviewer = assignee
        print(f"[Mock] 任务 {item_id} 分配给 {assignee} (role: {role})")

        # 记录分配时间（用于自动完成）
        self._assigned_items[item_id] = time.time()

    # ==================== 第四组：查询 ====================

    def find_work_item_by_dag_key(
        self,
        workspace_id: str,
        dag_key: str
    ) -> Optional[WorkItem]:
        """按 DAG key 查找工作单元"""
        for item in self._work_items.values():
            if item.workspace_id == workspace_id and item.dag_key == dag_key:
                return item
        return None

    # ==================== Run 生命周期管理 ====================

    def create_run(
        self,
        workspace_id: str,
        manifest: Any,
        orchestrator_issue_id: Optional[str] = None
    ) -> Run:
        """创建新的编排运行"""
        # 生成 run_id
        run_id = f"dag-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{random.randint(1000, 9999):04x}"

        # 保存 manifest 到本地
        run_dir = self._state_dir / run_id
        run_dir.mkdir(exist_ok=True)

        manifest_path = run_dir / "manifest.yaml"
        with open(manifest_path, 'w') as f:
            # 假设 manifest 有 to_yaml 方法或可以直接写入
            if hasattr(manifest, 'to_yaml'):
                f.write(manifest.to_yaml())
            else:
                # 简化：保存为 JSON
                import yaml
                yaml.dump(manifest.__dict__, f)

        # 创建工作单元（幂等：按 dag_key 去重，已 DONE 的复用其产物不重派，非 DONE 的重置后重派）
        key_to_id = {}
        precompleted = []  # 复用的 DONE 节点（execute_dag 直接计入 completed，不重派）
        reused_done = 0
        reset_for_rerun = 0
        created_new = 0
        for key, node in manifest.nodes.items():
            existing = self.find_work_item_by_dag_key(workspace_id, key)
            if existing and existing.status == WorkItemStatus.DONE:
                # 已成功执行过的节点：复用其 item_id 与产物，跳过派发
                key_to_id[key] = existing.id
                precompleted.append(key)
                reused_done += 1
                print(f"[Mock] 复用已完成任务 {existing.id}（dag_key={key}），跳过派发")
                continue

            node_title = getattr(node, 'title', None) or key
            node_desc = getattr(node, 'description', None) or f"Task {key}"

            if existing:
                # 非 DONE（BLOCKED/FAILED/INFLIGHT/TODO）：复用 item_id，重置为 TODO 以便重派
                existing.status = WorkItemStatus.TODO
                existing.artifacts = None
                existing.review_verdict = None
                existing.review_comment = None
                key_to_id[key] = existing.id
                reset_for_rerun += 1
                print(f"[Mock] 重置未完成任务 {existing.id}（dag_key={key}）为 TODO 重派")
            else:
                work_item = self.create_work_item(
                    workspace_id=workspace_id,
                    title=node_title,
                    description=node_desc,
                    dag_key=key,
                    worker=node.worker,
                    reviewer=getattr(node, 'reviewer', None),
                    blocked_by=node.blocked_by,
                    wave=getattr(node, 'wave', None),
                    initial_status=WorkItemStatus.TODO
                )
                key_to_id[key] = work_item.id
                created_new += 1

        if reused_done or reset_for_rerun:
            print(f"[Mock] 幂等去重: 复用 DONE {reused_done} / 重置重派 {reset_for_rerun} / 新建 {created_new}")

        # 创建 Run 对象
        now = datetime.now()
        run = Run(
            id=run_id,
            workspace_id=workspace_id,
            status=RunStatus.RUNNING,
            manifest_name=manifest.meta.get("name", "unnamed"),
            created_at=now,
            updated_at=now,
            total_tasks=len(manifest.nodes),
            completed_tasks=len(precompleted),
            failed_tasks=0,
            orchestrator_issue_id=orchestrator_issue_id
        )

        # 保存 Run
        self._runs[run_id] = run

        # 保存初始检查点（含已复用的 DONE 节点，作为 execute_dag 的 completed 种子）
        self._save_checkpoint(run_id, key_to_id, precompleted, [])

        # 保存 Run 元数据到本地
        run_meta_path = run_dir / "run.json"
        with open(run_meta_path, 'w') as f:
            json.dump(run.to_dict(), f, indent=2)

        print(f"[Mock] 创建 run {run_id}（{run.total_tasks} 个任务）")
        return run

    def get_run(self, run_id: str) -> Optional[Run]:
        """获取编排运行的当前状态"""
        # 先从内存查找
        if run_id in self._runs:
            run = self._runs[run_id]
        else:
            # 从本地加载
            run_dir = self._state_dir / run_id
            run_meta_path = run_dir / "run.json"

            if not run_meta_path.exists():
                return None

            with open(run_meta_path) as f:
                run_data = json.load(f)

            run = Run.from_dict(run_data)
            self._runs[run_id] = run

        # 重新计算进度（查询关联的工作单元）
        checkpoint = self._load_checkpoint(run_id)
        if checkpoint:
            completed_keys = checkpoint.get("completed", [])
            failed_keys = checkpoint.get("failed", [])

            # 直接使用检查点中的信息
            run.completed_tasks = len(completed_keys)
            run.failed_tasks = len(failed_keys)
            run.updated_at = datetime.now()

            # 更新状态
            if run.completed_tasks + run.failed_tasks >= run.total_tasks:
                if run.failed_tasks == 0:
                    run.status = RunStatus.COMPLETED
                else:
                    run.status = RunStatus.FAILED
            elif run.completed_tasks > 0 or run.failed_tasks > 0:
                run.status = RunStatus.RUNNING

        return run

    def list_runs(
        self,
        workspace_id: Optional[str] = None,
        status: Optional[RunStatus] = None
    ) -> List[Run]:
        """列出编排运行历史"""
        runs = []

        # 从本地目录扫描
        if self._state_dir.exists():
            for run_dir in self._state_dir.iterdir():
                if run_dir.is_dir() and run_dir.name.startswith("dag-"):
                    run_meta_path = run_dir / "run.json"
                    if run_meta_path.exists():
                        try:
                            with open(run_meta_path) as f:
                                run_data = json.load(f)
                            run = Run.from_dict(run_data)

                            # 过滤
                            if workspace_id and run.workspace_id != workspace_id:
                                continue

                            # 重新计算实时进度（通过 get_run）
                            run = self.get_run(run.id) or run

                            # 再次过滤状态（因为状态可能更新了）
                            if status and run.status != status:
                                continue

                            runs.append(run)
                        except Exception as e:
                            print(f"[Mock] 警告：加载 run {run_dir.name} 失败: {e}")

        # 按创建时间倒序
        runs.sort(key=lambda r: r.created_at, reverse=True)
        return runs

    def delete_run(self, run_id: str):
        """删除编排运行记录"""
        # 从内存删除
        self._runs.pop(run_id, None)
        self._run_checkpoints.pop(run_id, None)

        # 从本地删除
        run_dir = self._state_dir / run_id
        if run_dir.exists():
            import shutil
            shutil.rmtree(run_dir)
            print(f"[Mock] 删除 run {run_id}")

    # ==================== 内部辅助方法 ====================

    def _save_checkpoint(self, run_id: str, key_to_id: Dict[str, str], completed: List[str], failed: List[str]):
        """保存检查点"""
        checkpoint = {
            "key_to_id": key_to_id,
            "completed": completed,
            "failed": failed,
            "timestamp": datetime.now().isoformat()
        }

        # 内存
        self._run_checkpoints[run_id] = checkpoint

        # 本地文件
        run_dir = self._state_dir / run_id
        checkpoint_path = run_dir / "checkpoint.json"
        with open(checkpoint_path, 'w') as f:
            json.dump(checkpoint, f, indent=2)

    def _load_checkpoint(self, run_id: str) -> Optional[Dict[str, Any]]:
        """加载检查点"""
        # 先从内存查找
        if run_id in self._run_checkpoints:
            return self._run_checkpoints[run_id]

        # 从本地加载
        run_dir = self._state_dir / run_id
        checkpoint_path = run_dir / "checkpoint.json"

        if checkpoint_path.exists():
            with open(checkpoint_path) as f:
                checkpoint = json.load(f)
            self._run_checkpoints[run_id] = checkpoint
            return checkpoint

        return None

    def _log_event(self, run_id: str, event_type: str, data: Dict[str, Any]):
        """记录事件"""
        event = {
            "type": event_type,
            "timestamp": datetime.now().isoformat(),
            **data
        }

        # 追加到本地事件日志
        run_dir = self._state_dir / run_id
        events_path = run_dir / "events.jsonl"
        with open(events_path, 'a') as f:
            f.write(json.dumps(event) + '\n')
