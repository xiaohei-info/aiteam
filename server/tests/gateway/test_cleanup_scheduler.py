"""测试 cleanup_scheduler 后台调度器（#182）。"""

from __future__ import annotations

import time
from unittest.mock import Mock

import pytest

from agent_gateway.cleanup_scheduler import CleanupScheduler


class TestCleanupScheduler:
    """测试 CleanupScheduler 生命周期和调度逻辑。"""

    def test_initial_state(self) -> None:
        """初始状态应为未运行。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(cleanup_func, interval_seconds=1)
        assert not scheduler.is_running()

    def test_start_and_stop(self) -> None:
        """启动和停止应正常工作。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(cleanup_func, interval_seconds=1)

        scheduler.start()
        assert scheduler.is_running()

        scheduler.stop()
        assert not scheduler.is_running()

    def test_double_start_ignored(self) -> None:
        """重复启动应被忽略。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(cleanup_func, interval_seconds=1)

        scheduler.start()
        first_thread = scheduler._thread

        scheduler.start()  # 第二次启动
        assert scheduler._thread is first_thread  # 应为同一线程

        scheduler.stop()

    def test_cleanup_function_called(self) -> None:
        """清理函数应被周期性调用。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(cleanup_func, interval_seconds=0.1)

        scheduler.start()
        time.sleep(0.25)  # 等待至少 2 次调用
        scheduler.stop()

        assert cleanup_func.call_count >= 2

    def test_cleanup_exception_isolated(self) -> None:
        """清理函数抛异常不应影响调度器。"""
        call_count = [0]

        def failing_cleanup() -> None:
            call_count[0] += 1
            if call_count[0] == 1:
                raise ValueError("first call fails")
            # 第二次调用成功

        scheduler = CleanupScheduler(failing_cleanup, interval_seconds=0.1)
        scheduler.start()
        time.sleep(0.25)  # 等待多次调用
        scheduler.stop()

        assert call_count[0] >= 2  # 即使第一次失败，后续仍执行

    def test_stop_before_start(self) -> None:
        """未启动时调用 stop 应安全。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(cleanup_func, interval_seconds=1)
        scheduler.stop()  # 应不崩溃
        assert not scheduler.is_running()

    def test_graceful_shutdown(self) -> None:
        """停止时应优雅退出（不等待整个 interval）。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(cleanup_func, interval_seconds=100)

        scheduler.start()
        time.sleep(0.1)  # 短暂等待确保线程启动

        start = time.time()
        scheduler.stop(timeout=2.0)
        elapsed = time.time() - start

        assert elapsed < 5.0  # 应远小于 interval_seconds
        assert not scheduler.is_running()

    def test_custom_thread_name(self) -> None:
        """应支持自定义线程名称。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(
            cleanup_func, interval_seconds=1, name="test-scheduler"
        )

        scheduler.start()
        assert scheduler._thread is not None
        assert scheduler._thread.name == "test-scheduler"
        scheduler.stop()

    def test_interval_timing(self) -> None:
        """验证执行间隔大致符合配置。"""
        call_times = []

        def record_time() -> None:
            call_times.append(time.time())

        scheduler = CleanupScheduler(record_time, interval_seconds=0.2)
        scheduler.start()
        time.sleep(0.65)  # 应触发约 3 次调用
        scheduler.stop()

        assert len(call_times) >= 3
        # 验证间隔（允许一定误差）
        for i in range(1, len(call_times)):
            interval = call_times[i] - call_times[i - 1]
            assert 0.15 < interval < 0.35  # 0.2±0.05s

    def test_daemon_thread(self) -> None:
        """调度器线程应为 daemon 线程。"""
        cleanup_func = Mock()
        scheduler = CleanupScheduler(cleanup_func, interval_seconds=1)
        scheduler.start()

        assert scheduler._thread is not None
        assert scheduler._thread.daemon

        scheduler.stop()
