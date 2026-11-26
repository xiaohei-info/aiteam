"""One-off conversion: inline template avatar data URLs → template avatar files.

Run once per environment after deploying file-based template avatars::

    python -m operation_service.template_avatar_convert [--dry-run]

For every expert template whose payload still carries ``avatar_url``:
- a valid image data URL is normalized to ``template-avatars/{template_id}.webp`` and the
  payload gets ``avatar_version`` = 1 (or current + 1) and ``avatar_sha256``;
- any other value (legacy external URL, broken data) is dropped; that template shows no
  avatar until an operator uploads one.
``avatar_url`` is removed from the payload either way. Re-running is a no-op.

Templates that already have a file-based avatar (``avatar_version`` plus an existing file)
are never overwritten: the stale ``avatar_url`` key is dropped and the template is reported
under ``kept``. That keeps a newer operator upload from being clobbered by the legacy image
if the script runs after someone changed the avatar.

Prints a JSON summary; exits 1 if any template failed.
"""

from __future__ import annotations

import argparse
import json
import sys

from shared.avatar_image import AvatarImageError, decode_data_url, normalize_avatar
from shared.config import load_settings
from shared.contracts.enums import CatalogType

from .catalog_avatar import avatar_version
from .catalog_dependencies import get_catalog_repository
from .template_avatar_store import TemplateAvatarStore


def convert(repo, store: TemplateAvatarStore, *, dry_run: bool = False) -> dict:
    report = {"converted": [], "dropped": [], "kept": [], "failed": [], "dry_run": dry_run}
    for entry in repo.list(catalog_type=CatalogType.EXPERT_TEMPLATE):
        payload = dict(entry.payload or {})
        if "avatar_url" not in payload:
            continue
        value = payload.pop("avatar_url")
        # 已有文件态头像的模板不碰图：只清掉旧的内联 avatar_url，避免用旧图覆盖更新的头像。
        if avatar_version(payload) and store.read(entry.template_id) is not None:
            try:
                if not dry_run:
                    repo.update(entry, payload=payload)
            except Exception as exc:  # noqa: BLE001 — report and continue with the next template
                report["failed"].append({"template_id": entry.template_id, "error": type(exc).__name__})
                continue
            report["kept"].append(entry.template_id)
            continue
        try:
            avatar = normalize_avatar(decode_data_url(value)) if isinstance(value, str) and value.startswith("data:") else None
        except AvatarImageError:
            avatar = None
        try:
            if avatar is not None:
                payload["avatar_version"] = (avatar_version(payload) or 0) + 1
                payload["avatar_sha256"] = avatar.sha256
                if not dry_run:
                    store.write(entry.template_id, avatar.data)
            if not dry_run:
                repo.update(entry, payload=payload)
        except Exception as exc:  # noqa: BLE001 — report and continue with the next template
            report["failed"].append({"template_id": entry.template_id, "error": type(exc).__name__})
            continue
        report["converted" if avatar is not None else "dropped"].append(entry.template_id)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    args = parser.parse_args(argv)
    settings = load_settings("operation")
    report = convert(get_catalog_repository(), TemplateAvatarStore(settings.operation_data_root), dry_run=args.dry_run)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["failed"] else 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
