"""Avatar image handling shared by Operator template avatars and Manager employee avatars.

Avatars are stored as files, one per owner (template or employee), never as bytes in a
database column. Every stored avatar is a normalized static WebP so all tiers serve one
format; animated GIF input keeps only its first frame.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import re
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, UnidentifiedImageError

MAX_AVATAR_BYTES = 5 * 1024 * 1024
MAX_AVATAR_SIDE = 512
AVATAR_MIME_TYPE = "image/webp"
INPUT_MIME_TYPES = frozenset({"image/gif", "image/jpeg", "image/png", "image/webp"})
_DATA_URL = re.compile(r"^data:(image/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$")
# Upper bound for a base64 data URL carrying MAX_AVATAR_BYTES of image data.
MAX_AVATAR_DATA_URL_LENGTH = len("data:image/jpeg;base64,") + 4 * ((MAX_AVATAR_BYTES + 2) // 3)


class AvatarImageError(ValueError):
    """Input is not an acceptable avatar image. Messages never echo the input."""


@dataclass(frozen=True)
class AvatarFile:
    data: bytes
    sha256: str


def _signature_matches(mime_type: str, raw: bytes) -> bool:
    return {
        "image/gif": raw.startswith((b"GIF87a", b"GIF89a")),
        "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
        "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
    }.get(mime_type, False)


def decode_base64_image(mime_type: str, encoded: str) -> bytes:
    """Strict base64 decode + size + magic-signature check for a declared image MIME type."""
    if mime_type not in INPUT_MIME_TYPES:
        raise AvatarImageError("avatar must be a PNG, JPEG, GIF or WebP image")
    if not isinstance(encoded, str) or not encoded:
        raise AvatarImageError("avatar data is required")
    if len(encoded) > MAX_AVATAR_DATA_URL_LENGTH:
        raise AvatarImageError("avatar must be 5 MB or smaller")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise AvatarImageError("avatar data must be valid base64") from exc
    if not raw:
        raise AvatarImageError("avatar data is empty")
    if len(raw) > MAX_AVATAR_BYTES:
        raise AvatarImageError("avatar must be 5 MB or smaller")
    if not _signature_matches(mime_type, raw):
        raise AvatarImageError("avatar content does not match its image type")
    return raw


def decode_data_url(value: str) -> bytes:
    """Decode ``data:image/<type>;base64,<data>`` into raw image bytes."""
    match = _DATA_URL.fullmatch(value.strip()) if isinstance(value, str) else None
    if match is None:
        raise AvatarImageError("avatar must be a PNG, JPEG, GIF or WebP data URL")
    return decode_base64_image(match.group(1), match.group(2))


def normalize_avatar(raw: bytes) -> AvatarFile:
    """Decode with Pillow and re-encode as a static WebP no larger than MAX_AVATAR_SIDE."""
    try:
        with Image.open(BytesIO(raw)) as image:
            image.verify()
        with Image.open(BytesIO(raw)) as image:
            image.seek(0)  # animated input keeps only the first frame
            frame = image.convert("RGBA")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise AvatarImageError("avatar image cannot be decoded") from exc
    frame.thumbnail((MAX_AVATAR_SIDE, MAX_AVATAR_SIDE))
    out = BytesIO()
    frame.save(out, format="WEBP", quality=85, method=6)
    data = out.getvalue()
    if not data or len(data) > MAX_AVATAR_BYTES:
        raise AvatarImageError("normalized avatar must be 5 MB or smaller")
    return AvatarFile(data=data, sha256=hashlib.sha256(data).hexdigest())


def contained_path(root: Path, relative: str) -> Path:
    """Resolve ``relative`` under ``root``; refuse anything that escapes it."""
    root = root.resolve()
    path = (root / relative).resolve()
    path.relative_to(root)  # raises ValueError when outside root
    return path


def write_private_file(path: Path, data: bytes) -> None:
    """Atomically replace ``path`` with ``data`` (directories 0700, file 0600)."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=".avatar-", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
