"""行业文档生成：资料原件的本机目录存储（Operator 主机；多实例部署需共享盘）。

库里只记元数据、相对路径与 sha256；文件名一律由服务端生成的 UUID 构成，上传的文件名从不进入路径。
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
from pathlib import Path

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_UUID_RE = re.compile(_UUID)
_KEY_RE = re.compile(rf"{_UUID}/{_UUID}")


class SourceStorageError(Exception):
    """资料原件不可用（缺失、损坏或键非法）。消息不含路径以外的任何内容。"""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class SourceFileStore:
    def __init__(self, root: str | Path):
        self._root = Path(root)

    @property
    def root(self) -> Path:
        return self._root

    def put(self, draft_id: str, source_id: str, data: bytes) -> str:
        """写入并返回相对键。先写临时文件再原子改名，读者不会看到半个文件。"""
        key = f"{draft_id}/{source_id}"
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        handle, temp_name = tempfile.mkstemp(dir=target.parent, prefix=".upload-")
        try:
            with os.fdopen(handle, "wb") as stream:  # mkstemp 创建的文件权限即 0600
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, target)
        except BaseException:
            Path(temp_name).unlink(missing_ok=True)
            raise
        return key

    def read(self, key: str, expected_sha256: str) -> bytes:
        try:
            data = self._path(key).read_bytes()
        except OSError as exc:
            raise SourceStorageError("source file is missing from storage") from exc
        if sha256_hex(data) != expected_sha256:
            raise SourceStorageError("source file does not match its recorded checksum")
        return data

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def delete_draft(self, draft_id: str) -> None:
        if not _UUID_RE.fullmatch(draft_id):
            raise SourceStorageError("invalid draft id")
        try:
            shutil.rmtree(self._root / draft_id)
        except FileNotFoundError:
            return
        except OSError as exc:
            raise SourceStorageError("source files could not be removed from storage") from exc

    def _path(self, key: str) -> Path:
        if not _KEY_RE.fullmatch(key):
            raise SourceStorageError("invalid storage key")
        return self._root / key
