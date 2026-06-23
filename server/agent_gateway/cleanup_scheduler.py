"""Runtime run 工作目录清理调度器（#182）。

后台线程定期执行清理任务，确保：
1. 异常隔离不影响主服务
2. 优雅启停（支持 startup/shutdown 生命周期）
3. 可配置的执行间隔
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

logger = logging.getLogger(__name__)


class CleanupScheduler:
    """后台清理调度器。"""

    def __init__(
        self,
        cleanup_func: Callable[[], None],
        interval_seconds: int,
        *,
        name: str = "cleanup-scheduler",
    ) -> None:
        """初始化调度器。

        Args:
            cleanup_func: 清理函数（无参数）
            interval_seconds: 执行间隔（秒）
            name: 线程名称
        """
        self._cleanup_func = cleanup_func
        self._interval_seconds = interval_seconds
        self._name = name
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._running = False

    def start(self) -> None:
        """启动调度器。"""
        if self._running:
            logger.warning("[%s] 已在运行，跳过启动", self._name)
            return

        self._stop_event.clear()
        self._running = True
        self._thread = threading.Thread(
            target=self._run_loop,
            name=self._name,
            daemon=True,
        )
        self._thread.start()
        logger.info("[%s] 已启动，间隔=%d秒", self._name, self._interval_seconds)

    def stop(self, timeout: float = 5.0) -> None:
        """停止调度器。

        Args:
            timeout: 等待线程退出的超时时间（秒）
        """
        if not self._running:
            return

        logger.info("[%s] 正在停止...", self._name)
        self._stop_event.set()
        self._running = False

        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=timeout)
            if self._thread.is_alive():
                logger.warning("[%s] 线程未在超时时间内退出", self._name)
            else:
                logger.info("[%s] 已停止", self._name)

    def is_running(self) -> bool:
        """检查调度器是否正在运行。"""
        return self._running

    def _run_loop(self) -> None:
        """调度器主循环。"""
        logger.info("[%s] 后台循环已启动", self._name)

        while not self._stop_event.is_set():
            try:
                self._cleanup_func()
            except Exception:  # noqa: BLE001 — 清理失败不影响主服务
                logger.exception("[%s] 清理任务执行失败", self._name)

            # 等待下一次执行（可被 stop 中断）
            self._stop_event.wait(timeout=self._interval_seconds)

        logger.info("[%s] 后台循环已退出", self._name)
