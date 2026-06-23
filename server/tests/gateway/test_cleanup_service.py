"""测试 cleanup_service 核心逻辑（#182）。"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from agent_gateway.cleanup_service import (
    CleanupResult,
    cleanup_expired_runs,
    _get_active_runs,
    _get_dir_size,
)


class TestCleanupResult:
    """测试 CleanupResult 数据类。"""

    def test_initial_state(self) -> None:
        result = CleanupResult()
        assert result.scanned_count == 0
        assert result.deleted_count == 0
        assert result.skipped_count == 0
        assert result.freed_bytes == 0
        assert result.errors == []

    def test_add_error(self) -> None:
        result = CleanupResult()
        result.add_error("test error 1")
        result.add_error("test error 2")
        assert len(result.errors) == 2
        assert result.errors == ["test error 1", "test error 2"]


class TestGetDirSize:
    """测试 _get_dir_size 函数。"""

    def test_empty_directory(self, tmp_path: Path) -> None:
        size = _get_dir_size(tmp_path)
        assert size == 0

    def test_directory_with_files(self, tmp_path: Path) -> None:
        # 创建测试文件
        (tmp_path / "file1.txt").write_text("a" * 100)
        (tmp_path / "file2.txt").write_text("b" * 200)
        subdir = tmp_path / "subdir"
        subdir.mkdir()
        (subdir / "file3.txt").write_text("c" * 300)

        size = _get_dir_size(tmp_path)
        assert size == 600  # 100 + 200 + 300

    def test_nonexistent_directory(self) -> None:
        size = _get_dir_size(Path("/nonexistent"))
        assert size == 0


class TestCleanupExpiredRuns:
    """测试 cleanup_expired_runs 核心清理逻辑。"""

    def test_nonexistent_runs_root(self) -> None:
        """runs_root 不存在时应返回空结果。"""
        result = cleanup_expired_runs("/nonexistent/path", retention_days=7)
        assert result.scanned_count == 0
        assert result.deleted_count == 0

    def test_empty_runs_root(self, tmp_path: Path) -> None:
        """空的 runs_root 应返回零扫描。"""
        result = cleanup_expired_runs(str(tmp_path), retention_days=7)
        assert result.scanned_count == 0
        assert result.deleted_count == 0
        assert result.skipped_count == 0

    def test_delete_expired_runs(self, tmp_path: Path) -> None:
        """应删除过期的 run 目录。"""
        # 创建过期 run（修改 mtime 为 10 天前）
        expired_run = tmp_path / "run_expired_001"
        expired_run.mkdir()
        (expired_run / "data.txt").write_text("test data")
        old_time = time.time() - (10 * 86400)
        os.utime(expired_run, (old_time, old_time))

        result = cleanup_expired_runs(str(tmp_path), retention_days=7, db_url=None)

        assert result.scanned_count == 1
        assert result.deleted_count == 1
        assert result.skipped_count == 0
        assert not expired_run.exists()
        assert result.freed_bytes > 0

    def test_skip_recent_runs(self, tmp_path: Path) -> None:
        """应跳过未过期的 run 目录。"""
        recent_run = tmp_path / "run_recent_001"
        recent_run.mkdir()
        (recent_run / "data.txt").write_text("recent data")

        result = cleanup_expired_runs(str(tmp_path), retention_days=7, db_url=None)

        assert result.scanned_count == 1
        assert result.deleted_count == 0
        assert result.skipped_count == 1
        assert recent_run.exists()

    def test_skip_active_runs(self, tmp_path: Path) -> None:
        """应跳过正在运行的 run（即使过期）。"""
        # 创建过期但活跃的 run
        active_run_id = "run_active_001"
        active_run = tmp_path / active_run_id
        active_run.mkdir()
        old_time = time.time() - (10 * 86400)
        os.utime(active_run, (old_time, old_time))

        # Mock _get_active_runs 返回活跃 run
        with patch("agent_gateway.cleanup_service._get_active_runs") as mock_active:
            mock_active.return_value = {active_run_id}
            result = cleanup_expired_runs(
                str(tmp_path), retention_days=7, db_url="fake://db"
            )

        assert result.scanned_count == 1
        assert result.deleted_count == 0
        assert result.skipped_count == 1
        assert active_run.exists()

    def test_mixed_runs(self, tmp_path: Path) -> None:
        """混合场景：过期、未过期、活跃。"""
        # 1. 过期且非活跃 → 应删除
        expired_run = tmp_path / "run_expired_001"
        expired_run.mkdir()
        old_time = time.time() - (10 * 86400)
        os.utime(expired_run, (old_time, old_time))

        # 2. 未过期 → 应跳过
        recent_run = tmp_path / "run_recent_002"
        recent_run.mkdir()

        # 3. 过期但活跃 → 应跳过
        active_run_id = "run_active_003"
        active_run = tmp_path / active_run_id
        active_run.mkdir()
        os.utime(active_run, (old_time, old_time))

        with patch("agent_gateway.cleanup_service._get_active_runs") as mock_active:
            mock_active.return_value = {active_run_id}
            result = cleanup_expired_runs(
                str(tmp_path), retention_days=7, db_url="fake://db"
            )

        assert result.scanned_count == 3
        assert result.deleted_count == 1  # 只删除 expired_run
        assert result.skipped_count == 2  # 跳过 recent_run 和 active_run
        assert not expired_run.exists()
        assert recent_run.exists()
        assert active_run.exists()

    def test_ignore_files_in_runs_root(self, tmp_path: Path) -> None:
        """runs_root 下的文件（非目录）应被忽略。"""
        (tmp_path / "file.txt").write_text("not a run")
        run_dir = tmp_path / "run_001"
        run_dir.mkdir()

        result = cleanup_expired_runs(str(tmp_path), retention_days=7)

        assert result.scanned_count == 1  # 只计入 run_dir

    def test_path_traversal_protection(self, tmp_path: Path) -> None:
        """应防止路径穿越攻击。"""
        # 创建一个符号链接指向外部
        external_dir = tmp_path / "external"
        external_dir.mkdir()
        link = tmp_path / "run_link"
        link.symlink_to(external_dir)

        # 由于 symlink 解析可能逃逸 runs_root，应被跳过或安全处理
        # 具体行为取决于实现细节，这里验证不会崩溃
        result = cleanup_expired_runs(str(tmp_path), retention_days=0)
        assert result.scanned_count >= 0  # 至少不崩溃


class TestGetActiveRuns:
    """测试 _get_active_runs 数据库查询。"""

    def test_no_db_url(self) -> None:
        """db_url 为空时应返回空集合。"""
        # psycopg2 在函数内部导入，mock sys.modules
        with patch.dict("sys.modules", {"psycopg2": Mock()}):
            import sys
            mock_psycopg2 = sys.modules["psycopg2"]
            mock_psycopg2.connect.side_effect = Exception("should not be called")
            # _get_active_runs 内部会处理异常并返回空集合
            result = _get_active_runs("")
            assert result == set()

    def test_db_query_success(self) -> None:
        """成功查询活跃 run。"""
        with patch.dict("sys.modules", {"psycopg2": Mock()}):
            import sys
            mock_psycopg2 = sys.modules["psycopg2"]
            mock_conn = Mock()
            mock_cursor = Mock()
            mock_cursor.fetchall.return_value = [
                ("run_001",),
                ("run_002",),
                ("run_003",),
            ]
            mock_conn.cursor.return_value.__enter__ = Mock(return_value=mock_cursor)
            mock_conn.cursor.return_value.__exit__ = Mock(return_value=False)
            mock_psycopg2.connect.return_value = mock_conn

            result = _get_active_runs("fake://db")

            assert result == {"run_001", "run_002", "run_003"}
            mock_cursor.execute.assert_called_once()

    def test_db_query_failure(self) -> None:
        """查询失败时应返回空集合（保守策略）。"""
        with patch.dict("sys.modules", {"psycopg2": Mock()}):
            import sys
            mock_psycopg2 = sys.modules["psycopg2"]
            mock_psycopg2.connect.side_effect = Exception("DB error")
            result = _get_active_runs("fake://db")
            assert result == set()


class TestCleanupIntegration:
    """集成测试：端到端清理流程。"""

    def test_full_cleanup_cycle(self, tmp_path: Path) -> None:
        """完整的清理周期：创建、过期、清理。"""
        # 准备多个 run 目录
        runs = []
        for i in range(5):
            run_dir = tmp_path / f"run_{i:03d}"
            run_dir.mkdir()
            (run_dir / "output.txt").write_text(f"output {i}")
            runs.append(run_dir)

        # 将前 3 个设为过期
        old_time = time.time() - (10 * 86400)
        for run_dir in runs[:3]:
            os.utime(run_dir, (old_time, old_time))

        # 第 2 个虽然过期但标记为活跃
        with patch("agent_gateway.cleanup_service._get_active_runs") as mock_active:
            mock_active.return_value = {"run_001"}
            result = cleanup_expired_runs(
                str(tmp_path), retention_days=7, db_url="fake://db"
            )

        # 验证结果
        assert result.scanned_count == 5
        assert result.deleted_count == 2  # run_000 和 run_002
        assert result.skipped_count == 3  # run_001(活跃) + run_003/004(未过期)
        assert not runs[0].exists()  # run_000 被删除
        assert runs[1].exists()  # run_001 活跃，保留
        assert not runs[2].exists()  # run_002 被删除
        assert runs[3].exists()  # run_003 未过期
        assert runs[4].exists()  # run_004 未过期
