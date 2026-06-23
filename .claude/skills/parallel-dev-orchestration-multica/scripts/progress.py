"""
进度报告系统
"""
import time
from typing import Optional, Dict, Set
from utils import format_duration, format_timestamp, estimate_remaining_time
from state import EngineState


class ProgressReporter:
    """进度报告器 - 负责生成进度条和自动 comment"""

    def __init__(self, state: EngineState, storage, manifest):
        self.state = state
        self.storage = storage
        self.manifest = manifest
        self.node_start_times: Dict[str, float] = {}

    def update_progress(self, event_type: str, **kwargs):
        """
        统一进度更新接口

        event_type:
            - 'engine_started': 引擎启动
            - 'node_started': 节点开始
            - 'node_completed': 节点完成
            - 'node_failed': 节点失败
            - 'wave_completed': Wave 完成
            - 'engine_completed': 引擎完成
        """
        # 构造事件
        event = {
            "type": event_type,
            "timestamp": format_timestamp(time.time()),
            "run_id": self.state.run_id,
            **kwargs
        }

        # 追加事件日志
        self.storage.append_event(event, self.state.run_id)

        # 根据事件类型更新状态和生成报告
        if event_type == "engine_started":
            self._report_engine_started()

        elif event_type == "node_started":
            node_key = kwargs["node_key"]
            self.node_start_times[node_key] = time.time()
            self.state.mark_started(node_key)
            self._report_node_started(node_key, kwargs.get("worker"))

        elif event_type == "node_completed":
            node_key = kwargs["node_key"]
            duration = time.time() - self.node_start_times.get(node_key, time.time())
            self.state.mark_completed(node_key)
            self._report_node_completed(node_key, duration, kwargs.get("artifacts"))

        elif event_type == "node_failed":
            node_key = kwargs["node_key"]
            duration = time.time() - self.node_start_times.get(node_key, time.time())
            self.state.mark_failed(node_key)
            self._report_node_failed(node_key, duration, kwargs.get("reason"))

        elif event_type == "wave_completed":
            self._report_wave_completed(kwargs.get("wave", 0))

        elif event_type == "engine_completed":
            self._report_engine_completed(kwargs.get("summary", {}))

        # 保存状态快照
        self.storage.save_state(self.state.to_dict(), self.state.run_id)

    def _report_engine_started(self):
        """引擎启动报告"""
        total = self.state.get_total_nodes()
        message = f"""
🚀 **引擎启动** (run: `{self.state.run_id}`)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{self.render_progress_bar()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 总节点数: {total}
⏱️  开始时间: {format_timestamp(self.state.start_time)}
"""
        self._comment(message.strip())

    def _report_node_started(self, node_key: str, worker: Optional[str]):
        """节点开始报告"""
        node = self.manifest.nodes.get(node_key)
        message = f"""
🔄 **节点开始**: `{node_key}`
├─ Worker: {worker or 'unknown'}
├─ 开始时间: {format_timestamp(time.time())}
└─ 描述: {getattr(node, 'description', 'N/A') if node else 'N/A'}

{self.render_progress_bar()}
"""
        self._comment(message.strip())

    def _report_node_completed(self, node_key: str, duration: float, artifacts: Optional[str]):
        """节点完成报告"""
        message = f"""
✅ **节点完成**: `{node_key}`
├─ 耗时: {format_duration(duration)}
├─ 完成时间: {format_timestamp(time.time())}
└─ 产物: {artifacts or 'N/A'}

{self.render_progress_bar()}
"""
        self._comment(message.strip())

    def _report_node_failed(self, node_key: str, duration: float, reason: Optional[str]):
        """节点失败报告"""
        # 生成失败建议
        suggestions = self._generate_failure_suggestions(node_key, reason)

        message = f"""
❌ **节点失败**: `{node_key}`
├─ 耗时: {format_duration(duration)}
├─ 失败时间: {format_timestamp(time.time())}
└─ 原因: {reason or '未知'}

{suggestions}

{self.render_progress_bar()}
"""
        self._comment(message.strip())

    def _report_wave_completed(self, wave: int):
        """Wave 完成报告"""
        message = f"""
🎯 **Wave {wave} 完成**

{self.render_progress_bar()}
"""
        self._comment(message.strip())

    def _report_engine_completed(self, summary: dict):
        """引擎完成报告"""
        elapsed = self.state.get_elapsed_time()
        stats = self.state.get_progress_stats()

        message = f"""
🏁 **引擎完成** (run: `{self.state.run_id}`)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{self.render_progress_bar()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 最终统计:
├─ 总耗时: {format_duration(elapsed)}
├─ 完成: {stats['completed']} 个节点
├─ 失败: {stats['failed']} 个节点
└─ 成功率: {stats['completed'] / stats['total'] * 100:.1f}%

{self._render_final_summary(summary)}
"""
        self._comment(message.strip())

    def render_progress_bar(self) -> str:
        """渲染进度条"""
        stats = self.state.get_progress_stats()
        total = stats["total"]
        completed = stats["completed"]
        failed = stats["failed"]
        in_progress = stats["in_progress"]
        todo = stats["todo"]
        progress_pct = stats["progress_pct"]

        # 计算预计剩余时间
        elapsed = self.state.get_elapsed_time()
        eta = estimate_remaining_time(completed, total, elapsed) if completed > 0 else "未知"

        # 生成进度条（20 个字符宽度）
        bar_width = 20
        filled = int(bar_width * progress_pct / 100)
        bar = "█" * filled + "░" * (bar_width - filled)

        return f"""📊 整体进度 [{bar}] {completed}/{total} ({progress_pct:.1f}%)
⏱️  已用时间: {format_duration(elapsed)} | 预计剩余: {eta}
✅ 完成: {completed} | 🔄 进行中: {in_progress} | ⏸️  待开始: {todo} | ❌ 失败: {failed}"""

    def render_detailed_status(self) -> str:
        """渲染详细状态（包含每个节点）"""
        lines = ["", "📋 详细状态:"]

        # 按状态分组
        for key in sorted(self.state.completed):
            node = self.manifest.nodes.get(key)
            lines.append(f"  ✅ {key} [done]")

        for key in sorted(self.state.in_progress):
            node = self.manifest.nodes.get(key)
            worker = getattr(node, 'worker', 'unknown') if node else 'unknown'
            elapsed = time.time() - self.node_start_times.get(key, time.time())
            lines.append(f"  🔄 {key} [in_progress] worker: {worker} ({format_duration(elapsed)})")

        for key in sorted(self.state.failed):
            node = self.manifest.nodes.get(key)
            lines.append(f"  ❌ {key} [failed]")

        # 待开始的节点
        all_keys = set(self.state.key_to_id.keys())
        todo_keys = all_keys - self.state.completed - self.state.failed - self.state.in_progress
        for key in sorted(todo_keys):
            node = self.manifest.nodes.get(key)
            blocked_by = getattr(node, 'blocked_by', []) if node else []
            if blocked_by:
                lines.append(f"  ⏸️  {key} [todo] blocked_by: {', '.join(blocked_by)}")
            else:
                lines.append(f"  ⏸️  {key} [todo]")

        return "\n".join(lines)

    def _generate_failure_suggestions(self, node_key: str, reason: Optional[str]) -> str:
        """生成失败建议（基于确定性规则）"""
        suggestions = []

        if reason:
            reason_lower = reason.lower()

            # 超时
            if "timeout" in reason_lower or "超时" in reason_lower:
                suggestions.append("- 任务可能过大，考虑拆分为多个子任务")
                suggestions.append("- 检查 worker 资源是否充足")

            # 依赖缺失
            if "dependency" in reason_lower or "依赖" in reason_lower or "blocked" in reason_lower:
                suggestions.append("- 检查 blocked_by 是否正确配置")
                suggestions.append("- 确认依赖节点是否已完成")

            # 测试失败
            if "test" in reason_lower or "测试" in reason_lower:
                suggestions.append("- 查看 metadata.verification 中的测试输出")
                suggestions.append("- Worker 可能需要更多设计文档上下文")

            # PR 问题
            if "pr" in reason_lower or "pull request" in reason_lower:
                suggestions.append("- 检查 PR 是否创建成功")
                suggestions.append("- 检查 metadata.artifacts 是否正确写入")

        if not suggestions:
            suggestions.append("- 查看 issue 的 comment 了解详细错误信息")
            suggestions.append("- 考虑调整 manifest 或更换 worker")

        return "💡 **建议**:\n" + "\n".join(suggestions)

    def _render_final_summary(self, summary: dict) -> str:
        """渲染最终摘要"""
        lines = []

        if self.state.completed:
            lines.append(f"✅ **成功节点**: {', '.join(sorted(self.state.completed))}")

        if self.state.failed:
            lines.append(f"❌ **失败节点**: {', '.join(sorted(self.state.failed))}")
            lines.append("")
            lines.append("🚧 **下游影响**: 失败节点的下游已被阻塞")

        return "\n".join(lines) if lines else "所有节点均已完成"

    def _comment(self, message: str):
        """发送 comment（如果有 orchestrator issue）"""
        if self.state.orchestrator_issue_id:
            # 通过 storage 发送 comment
            # storage.append_event 已经会调用 comment，这里不需要重复
            pass
        else:
            # 如果没有 orchestrator issue，打印到控制台
            print("\n" + "="*60)
            print(message)
            print("="*60 + "\n")
