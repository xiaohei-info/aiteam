"""清理调度器工厂（#182）。

构造 run 工作目录清理调度器，按配置决定是否启用、保留期、执行间隔。
"""

from __future__ import annotations

import logging

from agent_gateway.cleanup_scheduler import CleanupScheduler
from agent_gateway.cleanup_service import cleanup_expired_runs

logger = logging.getLogger(__name__)


def build_cleanup_scheduler(
    *,
    enabled: bool,
    runs_root: str | None,
    retention_days: int,
    interval_hours: int,
    db_url: str | None = None,
) -> CleanupScheduler | None:
    """构造清理调度器。

    Args:
        enabled: 是否启用清理
        runs_root: run 工作目录根路径
        retention_days: 保留期天数
        interval_hours: 执行间隔（小时）
        db_url: 数据库连接串（用于检查活跃 run）

    Returns:
        CleanupScheduler 实例（enabled=True 且 runs_root 已配置）；否则 None
    """
    if not enabled:
        logger.info("[cleanup] 清理调度器未启用（AGENT_RUNS_CLEANUP_ENABLED=false）")
        return None

    if not runs_root:
        logger.info("[cleanup] 清理调度器未启用（AGENT_RUNS_ROOT 未配置）")
        return None

    def cleanup_task() -> None:
        """清理任务：调用 cleanup_expired_runs。"""
        logger.info(
            "[cleanup] 开始清理任务（retention_days=%d, runs_root=%s）",
            retention_days,
            runs_root,
        )
        result = cleanup_expired_runs(runs_root, retention_days, db_url=db_url)
        logger.info(
            "[cleanup] 清理任务完成：scanned=%d, deleted=%d, skipped=%d, freed=%d bytes, errors=%d",
            result.scanned_count,
            result.deleted_count,
            result.skipped_count,
            result.freed_bytes,
            len(result.errors),
        )
        if result.errors:
            for error in result.errors[:5]:  # 只记录前 5 个错误
                logger.warning("[cleanup] 清理错误: %s", error)

    interval_seconds = interval_hours * 3600
    scheduler = CleanupScheduler(
        cleanup_task,
        interval_seconds=interval_seconds,
        name="run-cleanup-scheduler",
    )
    logger.info(
        "[cleanup] 清理调度器已构造（interval=%dh, retention=%dd）",
        interval_hours,
        retention_days,
    )
    return scheduler
