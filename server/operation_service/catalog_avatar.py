"""Validated local avatar data for Operator catalog templates.

The northbound catalog keeps the historical ``avatar_url`` string field. New
uploads use a canonical ``data:image/...;base64,...`` value in that field so
existing Catalog consumers do not need a second upload protocol. Legacy URL
values remain readable for API compatibility, but are never produced by the
Operator UI.
"""

from __future__ import annotations

import base64
import binascii
import re

from shared.errors import ValidationProblem

AVATAR_MIME_TYPES = frozenset(
    {
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
    }
)
AVATAR_MAX_BYTES = 2 * 1024 * 1024
_AVATAR_DATA_PREFIX = re.compile(
    r"^data:(image/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$"
)
_AVATAR_DATA_PREFIX_LENGTH = max(
    len(f"data:{mime};base64,") for mime in AVATAR_MIME_TYPES
)
AVATAR_MAX_DATA_URL_LENGTH = _AVATAR_DATA_PREFIX_LENGTH + 4 * (
    (AVATAR_MAX_BYTES + 2) // 3
)
_LEGACY_AVATAR_PREFIXES = ("http://", "https://", "/")


def _has_image_signature(mime_type: str, data: bytes) -> bool:
    if mime_type == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime_type == "image/gif":
        return data.startswith((b"GIF87a", b"GIF89a"))
    if mime_type == "image/webp":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    return False


def canonical_avatar_data_url(value: str) -> str:
    """Validate and canonicalize an inline avatar data URL.

    The function intentionally accepts one exact data URL shape: an allowlisted
    raster MIME type, standard base64 without parameters, and bytes whose magic
    signature matches the declared MIME type. It never includes the input in an
    exception message.
    """

    if len(value) > AVATAR_MAX_DATA_URL_LENGTH:
        raise ValueError("avatar image is too large")
    match = _AVATAR_DATA_PREFIX.fullmatch(value)
    if match is None:
        raise ValueError("avatar must be a PNG, JPEG, GIF, or WEBP data URL")
    mime_type, encoded = match.groups()
    if not encoded:
        raise ValueError("avatar data must not be empty")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("avatar data must be canonical base64") from exc
    if not data:
        raise ValueError("avatar data must not be empty")
    if len(data) > AVATAR_MAX_BYTES:
        raise ValueError("avatar image is too large")
    if base64.b64encode(data).decode("ascii") != encoded:
        raise ValueError("avatar data must be canonical base64")
    if not _has_image_signature(mime_type, data):
        raise ValueError("avatar MIME type does not match image content")
    return f"data:{mime_type};base64,{encoded}"


def validate_avatar_value(value: str) -> str:
    """Validate a new avatar value while retaining old Catalog URL values.

    ``avatar_url`` predates local uploads and is part of the public Catalog
    response. HTTP and root-relative values therefore remain accepted for old
    API clients; all newly encoded image data takes the strict path above.
    Other schemes (for example ``javascript:``) are rejected at the trust
    boundary.
    """

    if not value:
        return ""
    if value.startswith("data:"):
        return canonical_avatar_data_url(value)
    if value.startswith(_LEGACY_AVATAR_PREFIXES) or ":" not in value:
        return value
    raise ValueError(
        "avatar must be a local image data URL or a legacy HTTP/path reference"
    )


def normalize_avatar_for_service(value: object) -> str:
    """Convert schema ``ValueError`` failures into the API's business error."""

    if not isinstance(value, str):
        raise ValidationProblem("avatar must be a string")
    try:
        return validate_avatar_value(value)
    except ValueError as exc:
        raise ValidationProblem(str(exc)) from exc


def safe_avatar_for_response(value: object) -> str:
    """Return only valid inline data or compatible legacy string values.

    Legacy rows may have been written before validation existed. Invalid inline
    data is omitted rather than reflected to clients; no avatar bytes or secret
    material are included in the error path.
    """

    if not isinstance(value, str) or not value:
        return ""
    if value.startswith("data:"):
        try:
            return canonical_avatar_data_url(value)
        except ValueError:
            return ""
    return value if value.startswith(_LEGACY_AVATAR_PREFIXES) else ""
