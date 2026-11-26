"""Expert template avatar files (Operator owns the template avatar truth).

One file per template at ``template-avatars/{template_id}.webp`` under the Operator data
root. The catalog payload only keeps ``avatar_version`` / ``avatar_sha256``; bytes never go
into the database.
"""

from __future__ import annotations

from pathlib import Path

from shared.avatar_image import contained_path, write_private_file

_NAMESPACE = "template-avatars"


def template_avatar_path(template_id: str, version: int, *, pull: bool = False) -> str:
    """Same-origin content path for a template avatar; ``v`` busts HTTP caches on change."""
    prefix = "/api/operation/catalog/pull" if pull else "/api/operation/catalog"
    return f"{prefix}/expert-templates/{template_id}/avatar/content?v={version}"


class TemplateAvatarStore:
    def __init__(self, root: Path):
        self._root = Path(root).resolve()

    def _path(self, template_id: str) -> Path:
        if not template_id or "/" in template_id or "\\" in template_id or template_id.startswith("."):
            raise ValueError("invalid template id")
        return contained_path(self._root, f"{_NAMESPACE}/{template_id}.webp")

    def write(self, template_id: str, data: bytes) -> None:
        write_private_file(self._path(template_id), data)

    def read(self, template_id: str) -> bytes | None:
        try:
            path = self._path(template_id)
        except ValueError:
            return None
        return path.read_bytes() if path.is_file() else None

    def delete(self, template_id: str) -> None:
        try:
            self._path(template_id).unlink(missing_ok=True)
        except ValueError:
            return
