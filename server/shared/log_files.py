"""Private, bounded, per-process logs. No shared-file multiprocess rotation."""
from __future__ import annotations

from contextlib import suppress
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import time
import uuid


class PrivateRotatingHandler(RotatingFileHandler):
    def _open(self):
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.baseFilename, flags, 0o600)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "a", encoding="utf-8")

    def doRollover(self):
        super().doRollover()
        prune_logs(Path(self.baseFilename).parent)

    def handleError(self, record):
        # logging's default handler prints the raw record/args on disk failures.
        # Never do that: preserve business execution and count the dropped record.
        self.dropped_records = getattr(self, "dropped_records", 0) + 1

    def flush(self):
        with suppress(ValueError, OSError):
            super().flush()

    def close(self):
        with suppress(ValueError, OSError):
            super().close()


def prune_logs(directory: Path) -> None:
    files = [p for p in directory.glob("service-*.jsonl*") if not p.is_symlink() and p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    total = 0
    for path in files:
        stat = path.stat()
        total += stat.st_size
        if total > 32 * 1024 * 1024 or stat.st_mtime < time.time() - 7 * 86400:
            path.unlink(missing_ok=True)


def install_file_handler(directory: str | None, formatter: logging.Formatter) -> None:
    root = logging.getLogger()
    # Reconfiguration/test app creation cannot leave duplicate writers.
    for handler in tuple(root.handlers):
        if isinstance(handler, PrivateRotatingHandler):
            root.removeHandler(handler)
            handler.close()
    if not directory:
        return  # stdout/journald is the default control-plane sink.
    try:
        path = Path(directory)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.is_symlink():
            raise OSError("Unsafe log directory")
        path.chmod(0o700)
        prune_logs(path)
        name = f"service-{os.getpid()}-{uuid.uuid4().hex}.jsonl"
        handler = PrivateRotatingHandler(path / name, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(formatter)
        root.addHandler(handler)
    except OSError:
        logging.getLogger(__name__).warning("logging.file_unavailable")
