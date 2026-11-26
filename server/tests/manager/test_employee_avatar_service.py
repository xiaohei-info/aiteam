"""员工头像：每员工一个固定文件，表只存元数据；版本只在内容变化时 +1。"""

from __future__ import annotations

import base64
from dataclasses import replace
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from manager_service.employee_avatar_repository import EmployeeAvatarRow
from manager_service.employee_avatar_service import (
    EmployeeAvatarService,
    TemplateAvatarLocked,
    avatar_content_path,
    avatar_projection,
)
from shared.errors import NotFound

from ._fake_router import ctx

EMPLOYEE = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


def _image(fmt: str = "PNG", color=(10, 20, 30), frames: int = 1) -> bytes:
    out = BytesIO()
    images = [Image.new("RGB", (6, 6), (color[0], color[1], (color[2] + i * 70) % 256)) for i in range(frames)]
    images[0].save(out, format=fmt, save_all=frames > 1, append_images=images[1:])
    return out.getvalue()


class MemoryRepository:
    """In-memory stand-in for EmployeeAvatarRepository (same upsert/version semantics)."""

    def __init__(self, origins: dict[str, str]):
        self.origins = origins
        self.rows: dict[str, EmployeeAvatarRow] = {}
        self.fail_upsert = False

    def get(self, _ctx, employee_id):
        return self.rows.get(employee_id)

    def employee_origin(self, _ctx, employee_id):
        return self.origins.get(employee_id)

    def versions(self, _ctx):
        return {eid: row.version for eid, row in self.rows.items()}

    def upsert(self, _ctx, *, employee_id, storage_key, mime_type, byte_size, sha256):
        if self.fail_upsert:
            raise RuntimeError("metadata unavailable")
        previous = self.rows.get(employee_id)
        version = 1 if previous is None else previous.version + (previous.sha256 != sha256)
        row = EmployeeAvatarRow(employee_id, storage_key, mime_type, byte_size, sha256, version, datetime.now(timezone.utc))
        self.rows[employee_id] = row
        return row


@pytest.fixture
def repo():
    return MemoryRepository({EMPLOYEE: "custom", OTHER: "recruited"})


@pytest.fixture
def service(repo, tmp_path):
    return EmployeeAvatarService(repo, tmp_path)


def _file(tmp_path: Path, employee_id: str = EMPLOYEE) -> Path:
    return tmp_path / "avatars" / ctx().tenant_id / f"{employee_id}.webp"


def _upload(service, employee_id=EMPLOYEE, fmt="PNG", color=(10, 20, 30)):
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}[fmt]
    return service.update(ctx(), employee_id=employee_id, mime_type=mime,
                          data=base64.b64encode(_image(fmt, color)).decode())


def test_upload_writes_one_fixed_file_and_bumps_version_only_on_change(service, tmp_path):
    first = _upload(service)
    assert first.version == 1
    assert _file(tmp_path).read_bytes()[:4] == b"RIFF"
    assert _upload(service).version == 1  # same bytes → same version
    second = _upload(service, color=(200, 0, 0))
    assert second.version == 2
    assert [p.name for p in (tmp_path / "avatars").rglob("*") if p.is_file()] == [f"{EMPLOYEE}.webp"]
    content = service.content(ctx(), EMPLOYEE)
    assert content.version == 2 and content.mime_type == "image/webp" and content.sha256 == second.sha256


def test_template_employees_cannot_upload(service, tmp_path):
    with pytest.raises(TemplateAvatarLocked) as exc:
        _upload(service, employee_id=OTHER)
    assert exc.value.status == 409
    assert not _file(tmp_path, OTHER).exists()


def test_upload_unknown_employee_and_unsafe_id(service, tmp_path):
    with pytest.raises(NotFound):
        _upload(service, employee_id="33333333-3333-3333-3333-333333333333")
    with pytest.raises(Exception, match="valid UUID"):
        service.update(ctx(), employee_id="../../escape", mime_type="image/png", data="AAAA")
    assert not list(tmp_path.rglob("*.webp"))


def test_upload_rejects_spoofed_and_unsupported_input(service):
    jpeg = base64.b64encode(_image("JPEG")).decode()
    with pytest.raises(Exception) as exc:
        service.update(ctx(), employee_id=EMPLOYEE, mime_type="image/png", data=jpeg)
    assert exc.value.code == "invalid_avatar"
    with pytest.raises(Exception) as exc:
        service.update(ctx(), employee_id=EMPLOYEE, mime_type="image/svg+xml", data=jpeg)
    assert exc.value.code == "invalid_avatar"


def test_seed_from_template_converts_gif_to_static_webp(service, tmp_path):
    row = service.seed_from_template(ctx(), employee_id=OTHER, data=_image("GIF", frames=3))
    assert row.version == 1
    with Image.open(_file(tmp_path, OTHER)) as image:
        assert image.format == "WEBP" and getattr(image, "n_frames", 1) == 1


def test_metadata_failure_restores_previous_file(service, repo, tmp_path):
    _upload(service)
    before = _file(tmp_path).read_bytes()
    repo.fail_upsert = True
    with pytest.raises(RuntimeError, match="metadata unavailable"):
        _upload(service, color=(0, 255, 0))
    assert _file(tmp_path).read_bytes() == before
    assert not list(tmp_path.rglob("*.tmp"))


def test_metadata_failure_on_first_write_removes_file(service, repo, tmp_path):
    repo.fail_upsert = True
    with pytest.raises(RuntimeError):
        _upload(service)
    assert not _file(tmp_path).exists()


def test_copy_gives_target_its_own_file(service, repo, tmp_path):
    _upload(service)
    service.copy(ctx(), source_id=EMPLOYEE, target_id=OTHER)
    assert _file(tmp_path, OTHER).read_bytes() == _file(tmp_path).read_bytes()
    assert repo.rows[OTHER].version == 1
    service.copy(ctx(), source_id="33333333-3333-3333-3333-333333333333", target_id=EMPLOYEE)  # no avatar: no-op


def test_content_missing_file_is_none(service, repo, tmp_path):
    _upload(service)
    _file(tmp_path).unlink()
    assert service.content(ctx(), EMPLOYEE) is None
    assert service.content(ctx(), OTHER) is None


def test_projection_is_relative_path_with_version(repo):
    assert avatar_projection(None) == (None, 0)
    row = EmployeeAvatarRow(EMPLOYEE, "k", "image/webp", 1, "s", 3, datetime.now(timezone.utc))
    assert avatar_projection(row) == (f"/api/manager/employees/{EMPLOYEE}/avatar/content?v=3", 3)
    assert avatar_content_path(EMPLOYEE, 3).startswith("/api/manager/")
    assert replace(row, version=4).version == 4


def test_avatar_urls_for_list_pages(service):
    assert service.avatar_urls(ctx()) == {}
    _upload(service)
    _upload(service, color=(200, 0, 0))
    assert service.avatar_urls(ctx()) == {EMPLOYEE: f"/api/manager/employees/{EMPLOYEE}/avatar/content?v=2"}
