from __future__ import annotations

import base64
from datetime import datetime, timezone
from pathlib import Path

import pytest

from manager_service.employee_avatar_service import decode_avatar
from manager_service.employee_avatar_service import EmployeeAvatarService
from manager_service.employee_avatar_repository import EmployeeAvatarRepository
from ._fake_router import FakeCursor, FakeRouter, ctx
from shared.errors import RequestTooLarge


PNG = b"\x89PNG\r\n\x1a\n" + b"avatar"
JPEG = b"\xff\xd8\xff" + b"avatar"


def test_decode_avatar_accepts_allowed_signature():
    assert decode_avatar("image/png", base64.b64encode(PNG).decode()) == PNG
    assert decode_avatar("image/jpeg", base64.b64encode(JPEG).decode()) == JPEG


def test_decode_avatar_rejects_mime_spoofing():
    with pytest.raises(Exception) as exc:
        decode_avatar("image/png", base64.b64encode(JPEG).decode())
    assert exc.value.code == "invalid_avatar"


def test_decode_avatar_rejects_oversized_payload():
    with pytest.raises(RequestTooLarge):
        decode_avatar("image/png", base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * (5 * 1024 * 1024)).decode())


def test_update_stores_random_key_and_increments_metadata(tmp_path: Path):
    router = FakeRouter().queue(FakeCursor(fetchone=(1,))).queue(FakeCursor(fetchone=("emp-1", "http://manager/avatar", "avatars/key.webp", "image/png", len(PNG), "hash", 2, datetime.now(timezone.utc))))
    service = EmployeeAvatarService(EmployeeAvatarRepository(router), tmp_path, "http://manager")
    result = service.update(ctx(), employee_id="emp-1", filename="avatar.png", mime_type="image/png", data=base64.b64encode(PNG).decode())
    assert result["version"] == 2
    assert (tmp_path / "avatars" / ctx().tenant_id / "emp-1").exists()
