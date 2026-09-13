"""Validated employee avatar upload orchestration."""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import secrets
from io import BytesIO
from pathlib import Path
from typing import Any

from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, NotFound, RequestTooLarge

from .employee_avatar_repository import EmployeeAvatarRepository

MAX_AVATAR_BYTES = 5 * 1024 * 1024
ALLOWED_MIMES = frozenset({"image/jpeg", "image/png", "image/webp"})


class InvalidAvatar(AppError):
    status, code, title = 400, "invalid_avatar", "Invalid Avatar"


class UnsupportedAvatarType(AppError):
    status, code, title = 415, "unsupported_avatar_type", "Unsupported Avatar Type"


def _signature_matches(mime: str, raw: bytes) -> bool:
    return {
        "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
        "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
    }.get(mime, False)


def decode_avatar(mime_type: str, encoded: str) -> bytes:
    if mime_type not in ALLOWED_MIMES:
        raise UnsupportedAvatarType("only JPEG, PNG and WebP avatars are supported")
    if not isinstance(encoded, str) or not encoded:
        raise InvalidAvatar("avatar data is required")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise InvalidAvatar("avatar data must be valid base64") from exc
    if not raw:
        raise InvalidAvatar("avatar data is empty")
    if len(raw) > MAX_AVATAR_BYTES:
        raise RequestTooLarge("avatar must be 5 MB or smaller")
    if not _signature_matches(mime_type, raw):
        raise InvalidAvatar("avatar content does not match mime_type")
    return raw


def normalize_image(mime_type: str, raw: bytes) -> tuple[bytes, str]:
    """Decode and normalize with Pillow when available.

    Pillow is an optional runtime acceleration for minimal test installations;
    signature validation remains enforced when it is unavailable.
    """
    try:
        from PIL import Image
    except ImportError:
        return raw, mime_type
    try:
        with Image.open(BytesIO(raw)) as image:
            image.verify()
        with Image.open(BytesIO(raw)) as image:
            image = image.convert("RGBA")
            out = BytesIO()
            image.save(out, format="WEBP", quality=85, method=6)
            normalized = out.getvalue()
    except Exception as exc:
        raise InvalidAvatar("avatar image cannot be decoded") from exc
    if not normalized or len(normalized) > MAX_AVATAR_BYTES:
        raise RequestTooLarge("normalized avatar must be 5 MB or smaller")
    return normalized, "image/webp"


class EmployeeAvatarService:
    def __init__(self, repository: EmployeeAvatarRepository, storage_root: Path, public_base_url: str | None = None):
        self._repo = repository
        self._root = storage_root.resolve()
        self._public_base = (public_base_url or "").rstrip("/")

    def update(self, ctx: TenantContext, *, employee_id: str, filename: str, mime_type: str, data: str) -> dict[str, Any]:
        raw = decode_avatar(mime_type, data)
        raw, stored_mime = normalize_image(mime_type, raw)
        if not self._repo.employee_exists(ctx, employee_id):
            raise NotFound("employee not found in this tenant")
        digest = hashlib.sha256(raw).hexdigest()
        key = f"avatars/{ctx.tenant_id}/{employee_id}/{secrets.token_urlsafe(24)}.webp"
        path = self._root / key
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(raw)
        os.chmod(path, 0o600)
        url = f"{self._public_base}/api/manager/employees/{employee_id}/avatar/content" if self._public_base else f"/api/manager/employees/{employee_id}/avatar/content"
        row = self._repo.upsert(ctx, employee_id=employee_id, avatar_url=url, storage_key=key, mime_type=stored_mime, byte_size=len(raw), sha256=digest)
        return {"employee_id": row.employee_id, "avatar_url": row.avatar_url, "version": row.version, "updated_at": row.updated_at, "byte_size": row.byte_size}

    def content(self, ctx: TenantContext, employee_id: str) -> tuple[bytes, str] | None:
        row = self._repo.get(ctx, employee_id)
        if not row:
            return None
        path = (self._root / row.storage_key).resolve()
        try:
            path.relative_to(self._root)
        except ValueError:
            return None
        if not path.is_file():
            return None
        return path.read_bytes(), row.mime_type
