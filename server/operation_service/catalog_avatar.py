"""Operator catalog template avatar: request parsing and response projection.

Requests still carry the avatar in the ``avatar_url`` field as a ``data:image/...`` URL (the
upload). The service decodes it, normalizes it to a static WebP file (``TemplateAvatarStore``)
and keeps only ``avatar_version`` / ``avatar_sha256`` in the payload. Responses expose the
same-origin content path in ``avatar_url`` plus ``avatar_version``.

``avatar_url`` request values:
- ``""``: remove the avatar;
- ``data:image/...``: new upload;
- the template's own content path (echoed back by an edit form): no change.
Anything else (external URLs, other schemes) is rejected at the trust boundary.
"""

from __future__ import annotations

import re

from shared.avatar_image import MAX_AVATAR_DATA_URL_LENGTH, AvatarImageError, decode_data_url
from shared.errors import ValidationProblem

from .template_avatar_store import template_avatar_path

AVATAR_MAX_DATA_URL_LENGTH = MAX_AVATAR_DATA_URL_LENGTH
_OWN_CONTENT_PATH = re.compile(r"^/api/operation/catalog/expert-templates/[^/?#]+/avatar/content(?:\?v=\d+)?$")


class KeepAvatar:
    """Marker: the request echoed the current avatar path; leave the avatar unchanged."""


KEEP_AVATAR = KeepAvatar()


def validate_avatar_value(value: str) -> str:
    """Schema-level check (Pydantic validator); raises ``ValueError`` on bad input."""
    if not value or _OWN_CONTENT_PATH.fullmatch(value):
        return value
    if value.startswith("data:"):
        try:
            decode_data_url(value)
        except AvatarImageError as exc:
            raise ValueError(str(exc)) from exc
        return value
    raise ValueError("avatar must be an uploaded PNG, JPEG, GIF or WebP image")


def parse_avatar_upload(value: object) -> bytes | None | KeepAvatar:
    """Service-level parse: raw image bytes for an upload, ``None`` to remove, or KEEP_AVATAR."""
    if not isinstance(value, str):
        raise ValidationProblem("avatar must be a string")
    if not value:
        return None
    if _OWN_CONTENT_PATH.fullmatch(value):
        return KEEP_AVATAR
    try:
        return decode_data_url(value)
    except AvatarImageError as exc:
        raise ValidationProblem(str(exc)) from exc


def avatar_version(payload: dict | None) -> int | None:
    value = (payload or {}).get("avatar_version")
    return value if isinstance(value, int) and value > 0 else None


def avatar_url_for(template_id: str, payload: dict | None, *, pull: bool = False) -> str:
    version = avatar_version(payload)
    return template_avatar_path(template_id, version, pull=pull) if version else ""
