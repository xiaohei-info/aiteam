"""
统一存储接口模块
"""
from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Any
from pathlib import Path
import json
import subprocess


class StorageBackend(ABC):
    """统一存储接口抽象"""

    @abstractmethod
    def save_manifest(self, manifest_content: str, run_id: str) -> str:
        """保存 manifest，返回存储标识"""
        pass

    @abstractmethod
    def load_manifest(self, run_id: str) -> Optional[str]:
        """加载 manifest"""
        pass

    @abstractmethod
    def save_state(self, state: dict, run_id: str):
        """保存引擎状态快照"""
        pass

    @abstractmethod
    def load_state(self, run_id: str) -> Optional[dict]:
        """加载引擎状态快照"""
        pass

    @abstractmethod
    def append_event(self, event: dict, run_id: str):
        """追加事件日志"""
        pass

    @abstractmethod
    def get_events(self, run_id: str) -> List[dict]:
        """获取事件日志"""
        pass

    @abstractmethod
    def list_runs(self) -> List[str]:
        """列出所有 run ID"""
        pass


class MulticaIssueStorage(StorageBackend):
    """基于 multica issue 的存储实现

    - manifest: issue 附件
    - state: issue metadata (engine_state_<run_id>)
    - events: issue comments
    """

    def __init__(self, orchestrator_issue_id: str):
        self.orchestrator_issue_id = orchestrator_issue_id

    def _run_multica(self, args: List[str], capture=True) -> Any:
        """调用 multica CLI"""
        cmd = ["multica"] + args
        result = subprocess.run(cmd, capture_output=capture, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"multica 调用失败: {' '.join(cmd)}\n{result.stderr}")
        if capture and result.stdout.strip():
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError:
                return result.stdout.strip()
        return None

    def save_manifest(self, manifest_content: str, run_id: str) -> str:
        """保存 manifest 为 issue 附件"""
        # 先写到临时文件
        temp_path = f"/tmp/manifest_{run_id}.yaml"
        with open(temp_path, 'w') as f:
            f.write(manifest_content)

        # 上传为附件
        try:
            self._run_multica([
                "issue", "attach",
                self.orchestrator_issue_id,
                "--file", temp_path,
                "--name", f"manifest_{run_id}.yaml"
            ], capture=False)
        finally:
            # 清理临时文件
            Path(temp_path).unlink(missing_ok=True)

        return f"attachment:manifest_{run_id}.yaml"

    def load_manifest(self, run_id: str) -> Optional[str]:
        """从 issue 附件加载 manifest"""
        # 获取附件列表
        issue = self._run_multica([
            "issue", "get",
            self.orchestrator_issue_id,
            "--output", "json"
        ])

        # 查找对应附件
        attachments = issue.get("attachments", [])
        for attachment in attachments:
            if attachment.get("name") == f"manifest_{run_id}.yaml":
                # 下载附件
                content = self._run_multica([
                    "issue", "attachment", "get",
                    self.orchestrator_issue_id,
                    attachment["id"]
                ])
                return content

        return None

    def save_state(self, state: dict, run_id: str):
        """保存引擎状态到 issue metadata"""
        state_json = json.dumps(state)
        self._run_multica([
            "issue", "metadata", "set",
            self.orchestrator_issue_id,
            "--key", f"engine_state_{run_id}",
            "--value", state_json
        ], capture=False)

    def load_state(self, run_id: str) -> Optional[dict]:
        """从 issue metadata 加载引擎状态"""
        issue = self._run_multica([
            "issue", "get",
            self.orchestrator_issue_id,
            "--output", "json"
        ])

        metadata = issue.get("metadata", {})
        state_json = metadata.get(f"engine_state_{run_id}")

        if state_json:
            return json.loads(state_json) if isinstance(state_json, str) else state_json

        return None

    def append_event(self, event: dict, run_id: str):
        """追加事件为 issue comment"""
        event_text = self._format_event(event)
        self._run_multica([
            "issue", "comment",
            self.orchestrator_issue_id,
            event_text
        ], capture=False)

    def get_events(self, run_id: str) -> List[dict]:
        """获取事件日志（从 comments 解析）"""
        # 简化实现：返回空列表
        # 完整实现需要解析 comments 并过滤出事件
        return []

    def list_runs(self) -> List[str]:
        """列出所有 run ID（从 metadata 中提取）"""
        issue = self._run_multica([
            "issue", "get",
            self.orchestrator_issue_id,
            "--output", "json"
        ])

        metadata = issue.get("metadata", {})
        runs = []

        for key in metadata.keys():
            if key.startswith("engine_state_"):
                run_id = key.replace("engine_state_", "")
                runs.append(run_id)

        return runs

    def _format_event(self, event: dict) -> str:
        """格式化事件为可读文本"""
        event_type = event.get("type", "unknown")
        timestamp = event.get("timestamp", "")

        if event_type == "node_started":
            return f"🔄 [{timestamp}] Node {event['node_key']} started (worker: {event.get('worker', 'unknown')})"
        elif event_type == "node_completed":
            return f"✅ [{timestamp}] Node {event['node_key']} completed ({event.get('duration', '?')})"
        elif event_type == "node_failed":
            return f"❌ [{timestamp}] Node {event['node_key']} failed: {event.get('reason', 'unknown')}"
        elif event_type == "wave_completed":
            return f"🎯 [{timestamp}] Wave {event.get('wave', '?')} completed"
        elif event_type == "engine_started":
            return f"🚀 [{timestamp}] Engine started (run: {event.get('run_id', 'unknown')})"
        elif event_type == "engine_completed":
            return f"🏁 [{timestamp}] Engine completed: {event.get('summary', '')}"
        else:
            return f"📝 [{timestamp}] {event_type}: {json.dumps(event)}"


class LocalFileStorage(StorageBackend):
    """基于本地文件的存储实现（开发/测试用）"""

    def __init__(self, base_dir: str = ".multica_state"):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(exist_ok=True)

    def save_manifest(self, manifest_content: str, run_id: str) -> str:
        """保存 manifest 到本地文件"""
        run_dir = self.base_dir / run_id
        run_dir.mkdir(exist_ok=True)

        manifest_path = run_dir / "manifest.yaml"
        manifest_path.write_text(manifest_content)

        return str(manifest_path)

    def load_manifest(self, run_id: str) -> Optional[str]:
        """从本地文件加载 manifest"""
        manifest_path = self.base_dir / run_id / "manifest.yaml"
        if manifest_path.exists():
            return manifest_path.read_text()
        return None

    def save_state(self, state: dict, run_id: str):
        """保存引擎状态到本地文件"""
        run_dir = self.base_dir / run_id
        run_dir.mkdir(exist_ok=True)

        state_path = run_dir / "state.json"
        state_path.write_text(json.dumps(state, indent=2))

    def load_state(self, run_id: str) -> Optional[dict]:
        """从本地文件加载引擎状态"""
        state_path = self.base_dir / run_id / "state.json"
        if state_path.exists():
            return json.loads(state_path.read_text())
        return None

    def append_event(self, event: dict, run_id: str):
        """追加事件到本地事件日志"""
        run_dir = self.base_dir / run_id
        run_dir.mkdir(exist_ok=True)

        events_path = run_dir / "events.jsonl"
        with events_path.open('a') as f:
            f.write(json.dumps(event) + '\n')

    def get_events(self, run_id: str) -> List[dict]:
        """从本地文件获取事件日志"""
        events_path = self.base_dir / run_id / "events.jsonl"
        if not events_path.exists():
            return []

        events = []
        with events_path.open('r') as f:
            for line in f:
                if line.strip():
                    events.append(json.loads(line))

        return events

    def list_runs(self) -> List[str]:
        """列出所有 run ID（从目录名获取）"""
        if not self.base_dir.exists():
            return []

        runs = []
        for item in self.base_dir.iterdir():
            if item.is_dir() and item.name.startswith("dag-"):
                runs.append(item.name)

        return sorted(runs, reverse=True)  # 最新的在前
