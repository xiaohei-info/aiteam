"""Runtime run 工作目录清理服务（#182）。

按保留期策略清理过期的 run 工作目录，确保：
1. 不清理正在运行的 run（queued/running/routing/submitting 状态）
2. 按 mtime 判断是否过期
3. 路径安全校验防止越权删除
4. 错误隔离不影响主服务
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# 不允许清理的 run 状态（正在执行或队列中）
_ACTIVE_STATUSES = frozenset(["queued", "running", "routing", "submitting"])


@dataclass
class CleanupResult:
    """清理结果统计。"""

    scanned_count: int = 0
    deleted_count: int = 0
    skipped_count: int = 0
    freed_bytes: int = 0
    errors: list[str] = field(default_factory=list)

    def add_error(self, error: str) -> None:
        """记录错误信息。"""
        self.errors.append(error)


def cleanup_expired_runs(
    runs_root: str,
    retention_days: int,
    *,
    db_url: str | None = None,
) -> CleanupResult:
    """清理过期的 run 工作目录。

    Args:
        runs_root: run 工作目录根路径
        retention_days: 保留期天数
        db_url: 数据库连接串（用于检查 run 状态）；None 时只按 mtime 判断

    Returns:
        清理结果统计
    """
    result = CleanupResult()
    root_path = Path(runs_root).expanduser().resolve()

    if not root_path.is_dir():
        logger.warning("[cleanup] runs_root 不存在或非目录: %s", root_path)
        return result

    cutoff_time = time.time() - (retention_days * 86400)
    logger.info(
        "[cleanup] 开始清理，保留期=%d天，cutoff=%s",
        retention_days,
        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(cutoff_time)),
    )

    # 获取活跃 run 集合（正在运行或队列中的）
    active_runs = _get_active_runs(db_url) if db_url else set()
    if active_runs:
        logger.info("[cleanup] 活跃 run 数量: %d", len(active_runs))

    # 扫描 runs_root 下的所有子目录
    try:
        entries = list(root_path.iterdir())
    except OSError as exc:
        result.add_error(f"扫描目录失败: {exc}")
        logger.exception("[cleanup] 扫描 runs_root 失败")
        return result

    for entry in entries:
        if not entry.is_dir():
            continue

        result.scanned_count += 1
        run_id = entry.name

        # 安全检查：防止越权删除（必须在 runs_root 下）
        try:
            entry.relative_to(root_path)
        except ValueError:
            result.add_error(f"路径越权: {entry}")
            logger.warning("[cleanup] 跳过越权路径: %s", entry)
            continue

        # 检查是否为活跃 run
        if run_id in active_runs:
            result.skipped_count += 1
            logger.debug("[cleanup] 跳过活跃 run: %s", run_id)
            continue

        # 检查是否过期
        try:
            mtime = entry.stat().st_mtime
            if mtime >= cutoff_time:
                result.skipped_count += 1
                logger.debug("[cleanup] 跳过未过期 run: %s (mtime=%s)", run_id, time.ctime(mtime))
                continue
        except OSError as exc:
            result.add_error(f"stat 失败 {run_id}: {exc}")
            logger.warning("[cleanup] stat 失败，跳过: %s", run_id)
            continue

        # 计算目录大小
        dir_size = _get_dir_size(entry)

        # 删除过期目录
        try:
            shutil.rmtree(entry)
            result.deleted_count += 1
            result.freed_bytes += dir_size
            logger.info(
                "[cleanup] 已删除过期 run: %s (age=%d days, size=%d bytes)",
                run_id,
                int((time.time() - mtime) / 86400),
                dir_size,
            )
        except OSError as exc:
            result.add_error(f"删除失败 {run_id}: {exc}")
            logger.warning("[cleanup] 删除目录失败: %s", run_id, exc_info=True)

    logger.info(
        "[cleanup] 清理完成: scanned=%d, deleted=%d, skipped=%d, freed=%d bytes, errors=%d",
        result.scanned_count,
        result.deleted_count,
        result.skipped_count,
        result.freed_bytes,
        len(result.errors),
    )
    return result


def _get_active_runs(db_url: str) -> set[str]:
    """获取活跃 run 的 ID 集合（正在运行或队列中）。

    Args:
        db_url: 数据库连接串

    Returns:
        活跃 run ID 集合
    """
    try:
        import psycopg2

        conn = psycopg2.connect(db_url)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id FROM team_runs
                    WHERE status = ANY(%s)
                    """,
                    (list(_ACTIVE_STATUSES),),
                )
                return {row[0] for row in cur.fetchall()}
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — 查询失败时保守跳过清理
        logger.exception("[cleanup] 查询活跃 run 失败，保守跳过清理")
        return set()


def _get_dir_size(path: Path) -> int:
    """递归计算目录大小（字节）。

    Args:
        path: 目录路径

    Returns:
        目录总大小（字节）
    """
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass  # 忽略单个文件的 stat 失败
    except OSError:
        pass  # 忽略遍历失败
    return total
