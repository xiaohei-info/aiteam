"""Employee avatar files: one file per employee, metadata (version/sha256) in ``employee_avatar``.

- File path is fixed: ``avatars/{tenant_id}/{employee_id}.webp`` under the Manager storage root;
  it is overwritten in place, never one random file per upload.
- ``version`` starts at 1 and increases only when the bytes actually change; every tier caches
  avatar bytes by (employee_id, version).
- Recruit / solution apply copy the Operator template avatar once (initial consistency).
  Employees that come from a template (recruited / solution / copied) keep that avatar; uploads
  are only for employees the enterprise created itself (``origin = 'custom'``).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from shared.avatar_image import (
    AVATAR_MIME_TYPE,
    AvatarFile,
    AvatarImageError,
    contained_path,
    decode_base64_image,
    normalize_avatar,
    write_private_file,
)
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Conflict, NotFound

from .employee_avatar_repository import EmployeeAvatarRepository, EmployeeAvatarRow


class InvalidAvatar(AppError):
    status, code, title = 400, "invalid_avatar", "Invalid Avatar"


class TemplateAvatarLocked(Conflict):
    """Employees recruited from a template keep the template avatar (one avatar per expert)."""

    code = "employee_avatar_locked"


def normalize_employee_id(value: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise InvalidAvatar("employee_id must be a valid UUID") from exc


def avatar_content_path(employee_id: str, version: int) -> str:
    """Same-origin relative content path; ``v`` changes whenever the avatar bytes change."""
    return f"/api/manager/employees/{employee_id}/avatar/content?v={version}"


def avatar_projection(row: EmployeeAvatarRow | None) -> tuple[str | None, int]:
    """(avatar_url, avatar_version) for snapshots / authorized config; (None, 0) = no avatar."""
    if row is None:
        return None, 0
    return avatar_content_path(row.employee_id, row.version), row.version


@dataclass(frozen=True)
class AvatarContent:
    data: bytes
    version: int
    sha256: str
    mime_type: str = AVATAR_MIME_TYPE


class EmployeeAvatarService:
    def __init__(self, repository: EmployeeAvatarRepository, storage_root: Path):
        self._repo = repository
        self._root = Path(storage_root).resolve()

    def _path(self, ctx: TenantContext, employee_id: str) -> Path:
        try:
            return contained_path(self._root, f"avatars/{ctx.tenant_id}/{employee_id}.webp")
        except ValueError as exc:
            raise InvalidAvatar("avatar path escapes the storage root") from exc

    def _store(self, ctx: TenantContext, employee_id: str, avatar: AvatarFile) -> EmployeeAvatarRow:
        """Write the file first, then the metadata: whoever reads a new version finds its bytes."""
        previous = self._repo.get(ctx, employee_id)
        if previous is not None and previous.sha256 == avatar.sha256:
            return previous
        path = self._path(ctx, employee_id)
        old_bytes = path.read_bytes() if path.is_file() else None
        write_private_file(path, avatar.data)
        try:
            return self._repo.upsert(
                ctx, employee_id=employee_id, storage_key=str(path.relative_to(self._root)),
                mime_type=AVATAR_MIME_TYPE, byte_size=len(avatar.data), sha256=avatar.sha256,
            )
        except Exception:
            # Metadata did not move: put the file back so bytes and version stay consistent.
            if old_bytes is None:
                path.unlink(missing_ok=True)
            else:
                write_private_file(path, old_bytes)
            raise

    def update(self, ctx: TenantContext, *, employee_id: str, mime_type: str, data: str) -> EmployeeAvatarRow:
        """Enterprise admin upload, only for enterprise-created employees."""
        employee_id = normalize_employee_id(employee_id)
        origin = self._repo.employee_origin(ctx, employee_id)
        if origin is None:
            raise NotFound("employee not found in this tenant")
        if origin != "custom":
            raise TemplateAvatarLocked("this employee uses its expert template avatar and cannot change it")
        try:
            avatar = normalize_avatar(decode_base64_image(mime_type, data))
        except AvatarImageError as exc:
            raise InvalidAvatar(str(exc)) from exc
        return self._store(ctx, employee_id, avatar)

    def seed_from_template(self, ctx: TenantContext, *, employee_id: str, data: bytes) -> EmployeeAvatarRow:
        """Recruit / solution apply: copy the template avatar bytes as the employee's own file."""
        employee_id = normalize_employee_id(employee_id)
        try:
            avatar = normalize_avatar(data)
        except AvatarImageError as exc:
            raise InvalidAvatar(str(exc)) from exc
        return self._store(ctx, employee_id, avatar)

    def copy(self, ctx: TenantContext, *, source_id: str, target_id: str) -> None:
        """Employee copy: the copy gets its own file with the source avatar; no avatar → no-op."""
        target_id = normalize_employee_id(target_id)
        content = self.content(ctx, source_id)
        if content is None:
            return
        # Already a normalized WebP: copy the bytes as-is (re-encoding would change them).
        self._store(ctx, target_id, AvatarFile(data=content.data, sha256=content.sha256))

    def avatar_urls(self, ctx: TenantContext) -> dict[str, str]:
        """{employee_id: 带版本的内容路径}，供员工列表/详情展示；没有头像的员工不在其中。"""
        return {eid: avatar_content_path(eid, v) for eid, v in self._repo.versions(ctx).items()}

    def content(self, ctx: TenantContext, employee_id: str) -> AvatarContent | None:
        employee_id = normalize_employee_id(employee_id)
        row = self._repo.get(ctx, employee_id)
        if row is None:
            return None
        path = self._path(ctx, employee_id)
        if not path.is_file():
            return None
        return AvatarContent(data=path.read_bytes(), version=row.version, sha256=row.sha256)
