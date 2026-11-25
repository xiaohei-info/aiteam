"""人才市场模板头像的按需解析与本地缓存（企业未上传头像时继承模板）。

设计约束：
- **不写** `employee_avatar`：继承态是派生结果，企业一旦上传/复制头像，行优先，继承自动让位；
- 缓存键 = (tenant, employee, template_id, template_version)，模板换版本或换模板自动重取；
- Operator 不可达、模板没有可用头像（外链/相对路径/非栅格）→ 返回 ``None``，
  调用方按 404 处理，前端回退插画；错误只记日志，不把目录内容写进响应。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from shared.contracts.tenancy import TenantContext

from .employee_avatar_service import (
    MAX_AVATAR_BYTES,
    decode_avatar,
    normalize_employee_id,
    normalize_image,
    parse_catalog_avatar_url,
)

logger = logging.getLogger(__name__)

_CACHE_DIR = "template-avatars"


def _digest(*parts: str) -> str:
    return hashlib.sha256("\u0000".join(parts).encode("utf-8")).hexdigest()[:32]


class TemplateAvatarCache:
    """把 Operator 目录里的模板头像 data URL 解析成字节并落盘缓存。"""

    def __init__(self, catalog: Any | None, storage_root: Path):
        self._catalog = catalog
        self._root = storage_root.resolve()

    # ---- 路径 ---------------------------------------------------------------
    def _dir(self, ctx: TenantContext, employee_id: str) -> Path:
        # 用摘要而不是原始 id 拼路径：tenant/employee 都来自数据库，仍不直接进文件系统。
        return self._root / _CACHE_DIR / _digest(ctx.tenant_id) / _digest(employee_id)

    def _paths(
        self, ctx: TenantContext, employee_id: str, template_id: str, template_version: str
    ) -> tuple[Path, Path]:
        stem = _digest(template_id, template_version)
        base = self._dir(ctx, employee_id)
        return base / f"{stem}.bin", base / f"{stem}.json"

    def _managed(self, path: Path) -> bool:
        try:
            path.resolve().relative_to(self._root)
        except ValueError:
            return False
        return True

    # ---- 读写缓存 -----------------------------------------------------------
    def _read_cache(
        self, data_path: Path, meta_path: Path, template_id: str, template_version: str
    ) -> tuple[bytes, str] | None:
        if not (self._managed(data_path) and self._managed(meta_path)):
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(meta, dict):
            return None
        if meta.get("template_id") != template_id or meta.get("template_version") != template_version:
            return None
        mime_type = meta.get("mime_type")
        if not isinstance(mime_type, str) or not mime_type:
            return None
        try:
            data = data_path.read_bytes()
        except OSError:
            return None
        if not data or len(data) > MAX_AVATAR_BYTES:
            return None
        return data, mime_type

    def _write_cache(
        self,
        data_path: Path,
        meta_path: Path,
        *,
        data: bytes,
        mime_type: str,
        template_id: str,
        template_version: str,
    ) -> None:
        try:
            data_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            meta = {
                "template_id": template_id,
                "template_version": template_version,
                "mime_type": mime_type,
                "byte_size": len(data),
            }
            self._atomic_write(meta_path, json.dumps(meta, ensure_ascii=False).encode("utf-8"))
            self._atomic_write(data_path, data)
        except OSError:
            # 缓存写不进去不影响本次响应：字节已经在内存里。
            logger.warning("template avatar cache write failed", extra={"mime_type": mime_type})

    @staticmethod
    def _atomic_write(path: Path, payload: bytes) -> None:
        fd, temporary_name = tempfile.mkstemp(prefix=".avatar-", suffix=".tmp", dir=path.parent)
        os.close(fd)
        temporary = Path(temporary_name)
        try:
            with temporary.open("wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    # ---- 解析 ---------------------------------------------------------------
    def _fetch(self, ctx: TenantContext, template_id: str, template_version: str) -> tuple[bytes, str] | None:
        if self._catalog is None:
            return None
        try:
            template = self._catalog.pull_expert_template(
                template_id=template_id,
                version=None if template_version == "latest" else template_version,
                tenant_id=ctx.tenant_id,
            )
        except Exception:
            # 目录不可达/模板不在发布范围：本次按无头像处理，下次请求再试。
            logger.warning("template avatar fetch failed", extra={"template_id": template_id})
            return None
        parsed = parse_catalog_avatar_url(getattr(template, "avatar_url", "") or "")
        if parsed is None:
            return None
        try:
            raw = decode_avatar(*parsed)
            return normalize_image(parsed[0], raw)
        except Exception:
            logger.warning("template avatar is not decodable", extra={"template_id": template_id})
            return None

    def resolve(
        self,
        ctx: TenantContext,
        *,
        employee_id: str,
        template_id: str | None,
        template_version: str | None,
    ) -> tuple[bytes, str] | None:
        """返回 ``(bytes, mime_type)``；没有可继承的模板头像时返回 ``None``。"""
        if not template_id:
            return None
        try:
            employee_id = normalize_employee_id(employee_id)
        except Exception:
            return None
        version = (template_version or "latest").strip() or "latest"
        data_path, meta_path = self._paths(ctx, employee_id, template_id, version)
        cached = self._read_cache(data_path, meta_path, template_id, version)
        if cached is not None:
            return cached
        fetched = self._fetch(ctx, template_id, version)
        if fetched is None:
            return None
        self._write_cache(
            data_path,
            meta_path,
            data=fetched[0],
            mime_type=fetched[1],
            template_id=template_id,
            template_version=version,
        )
        return fetched
