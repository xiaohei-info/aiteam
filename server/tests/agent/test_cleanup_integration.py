"""集成测试：清理调度器与 app 生命周期（#182）。"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from agent_service.cleanup.factory import build_cleanup_scheduler


class TestBuildCleanupScheduler:
    """测试 build_cleanup_scheduler 工厂函数。"""

    def test_disabled_returns_none(self) -> None:
        """enabled=False 应返回 None。"""
        scheduler = build_cleanup_scheduler(
            enabled=False,
            runs_root="/tmp/runs",
            retention_days=7,
            interval_hours=24,
        )
        assert scheduler is None

    def test_no_runs_root_returns_none(self) -> None:
        """runs_root 未配置应返回 None。"""
        scheduler = build_cleanup_scheduler(
            enabled=True,
            runs_root=None,
            retention_days=7,
            interval_hours=24,
        )
        assert scheduler is None

    def test_valid_config_returns_scheduler(self, tmp_path: Path) -> None:
        """有效配置应返回 CleanupScheduler 实例。"""
        scheduler = build_cleanup_scheduler(
            enabled=True,
            runs_root=str(tmp_path),
            retention_days=7,
            interval_hours=24,
        )
        assert scheduler is not None
        assert not scheduler.is_running()

    def test_scheduler_lifecycle(self, tmp_path: Path) -> None:
        """测试调度器的启动和停止。"""
        scheduler = build_cleanup_scheduler(
            enabled=True,
            runs_root=str(tmp_path),
            retention_days=7,
            interval_hours=1,
        )
        assert scheduler is not None

        scheduler.start()
        assert scheduler.is_running()

        scheduler.stop()
        assert not scheduler.is_running()

    def test_cleanup_task_execution(self, tmp_path: Path) -> None:
        """验证清理任务确实被执行。"""
        # 创建过期 run
        expired_run = tmp_path / "run_expired"
        expired_run.mkdir()
        old_time = time.time() - (10 * 86400)
        os.utime(expired_run, (old_time, old_time))

        scheduler = build_cleanup_scheduler(
            enabled=True,
            runs_root=str(tmp_path),
            retention_days=7,
            interval_hours=1,
            db_url=None,  # 无 DB，仅按 mtime 判断
        )
        assert scheduler is not None

        # 手动触发清理任务（通过访问内部 cleanup_func）
        scheduler._cleanup_func()

        # 验证过期 run 被删除
        assert not expired_run.exists()



class TestCleanupWithDatabase:
    """测试带数据库的清理场景。"""

    def test_cleanup_respects_active_runs(self, tmp_path: Path) -> None:
        """清理时应尊重数据库中的活跃 run。"""
        # 创建过期 run
        expired_run_id = "run_001"
        expired_run = tmp_path / expired_run_id
        expired_run.mkdir()
        old_time = time.time() - (10 * 86400)
        os.utime(expired_run, (old_time, old_time))

        # Mock 数据库查询返回该 run 为活跃状态
        with patch("agent_gateway.cleanup_service._get_active_runs") as mock_active:
            mock_active.return_value = {expired_run_id}

            scheduler = build_cleanup_scheduler(
                enabled=True,
                runs_root=str(tmp_path),
                retention_days=7,
                interval_hours=1,
                db_url="fake://db",
            )
            assert scheduler is not None

            # 手动触发清理
            scheduler._cleanup_func()

            # 验证活跃 run 未被删除
            assert expired_run.exists()
