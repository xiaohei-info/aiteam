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


PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
JPEG = base64.b64decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGJqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyyiiivzo/ss//2Q==")


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
    employee_id = "11111111-1111-1111-1111-111111111111"
    avatar_row = (employee_id, "http://manager/avatar", "avatars/key.webp", "image/webp", len(PNG), "hash", 2, datetime.now(timezone.utc))
    router = FakeRouter().queue(FakeCursor(fetchone=(1,))).queue(FakeCursor(fetchone=avatar_row)).queue(FakeCursor(fetchone=avatar_row))
    service = EmployeeAvatarService(EmployeeAvatarRepository(router), tmp_path, "http://manager")
    result = service.update(ctx(), employee_id=employee_id, filename="avatar.png", mime_type="image/png", data=base64.b64encode(PNG).decode())
    assert result["version"] == 2
    assert (tmp_path / "avatars" / ctx().tenant_id / employee_id).exists()


def test_update_rejects_unsafe_employee_id_before_storage(tmp_path: Path):
    router = FakeRouter()
    service = EmployeeAvatarService(EmployeeAvatarRepository(router), tmp_path, "http://manager")
    with pytest.raises(Exception, match="valid UUID"):
        service.update(ctx(), employee_id="../../escape", filename="avatar.png", mime_type="image/png", data=base64.b64encode(PNG).decode())
    assert not list(tmp_path.rglob("*"))


def test_update_removes_object_when_metadata_write_fails(tmp_path: Path):
    class FailingRepository:
        def employee_exists(self, _ctx, _employee_id):
            return True

        def get(self, _ctx, _employee_id):
            return None

        def upsert(self, _ctx, **_kwargs):
            raise RuntimeError("metadata unavailable")

    service = EmployeeAvatarService(FailingRepository(), tmp_path, "http://manager")
    with pytest.raises(RuntimeError, match="metadata unavailable"):
        service.update(
            ctx(),
            employee_id="11111111-1111-1111-1111-111111111111",
            filename="avatar.png",
            mime_type="image/png",
            data=base64.b64encode(PNG).decode(),
        )
    assert list((tmp_path / "avatars").rglob("*.webp")) == []
    assert list((tmp_path / "avatars").rglob("*.tmp")) == []
