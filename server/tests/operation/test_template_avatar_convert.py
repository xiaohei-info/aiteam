"""一次性转换脚本：模板 data URL 头像 → 文件（幂等）。"""

import base64
from io import BytesIO

from PIL import Image

from operation_service.catalog_repository import CatalogEntry, CatalogRepository
from operation_service.template_avatar_convert import convert
from operation_service.template_avatar_store import TemplateAvatarStore
from shared.contracts.enums import CatalogType


def _png() -> str:
    out = BytesIO()
    Image.new("RGB", (4, 4), (9, 9, 9)).save(out, format="PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()


def _entry(template_id, payload):
    return CatalogEntry(catalog_type=CatalogType.EXPERT_TEMPLATE, template_id=template_id,
                        version="1.0.0", display_name=template_id, payload=payload)


def test_convert_moves_data_url_to_file_and_drops_legacy_values(tmp_path):
    repo = CatalogRepository()
    repo.create(_entry("ok", {"avatar_url": _png(), "category": "x"}))
    repo.create(_entry("legacy", {"avatar_url": "https://cdn.example/a.png"}))
    repo.create(_entry("broken", {"avatar_url": "data:image/png;base64,AAAA"}))
    repo.create(_entry("none", {"category": "x"}))
    store = TemplateAvatarStore(tmp_path)

    dry = convert(repo, store, dry_run=True)
    assert dry["converted"] == ["ok"] and sorted(dry["dropped"]) == ["broken", "legacy"]
    assert "avatar_url" in repo.get(CatalogType.EXPERT_TEMPLATE, "ok").payload
    assert store.read("ok") is None

    report = convert(repo, store)
    assert report["converted"] == ["ok"] and not report["failed"]
    ok = repo.get(CatalogType.EXPERT_TEMPLATE, "ok").payload
    assert "avatar_url" not in ok and ok["avatar_version"] == 1 and ok["category"] == "x"
    assert store.read("ok")[:4] == b"RIFF"
    legacy = repo.get(CatalogType.EXPERT_TEMPLATE, "legacy").payload
    assert "avatar_url" not in legacy and "avatar_version" not in legacy

    again = convert(repo, store)
    assert again["converted"] == [] and again["dropped"] == []


def test_convert_keeps_newer_uploaded_avatar_and_only_drops_stale_key(tmp_path):
    """部署后运营先上传了新头像，再跑脚本：必须保留当前头像，不被 payload 里的旧 data URL 覆盖。"""
    repo = CatalogRepository()
    repo.create(_entry("uploaded", {"avatar_url": _png(), "avatar_version": 3, "avatar_sha256": "sha-new"}))
    store = TemplateAvatarStore(tmp_path)
    store.write("uploaded", b"RIFFnew-avatar-bytes")

    report = convert(repo, store)

    assert report["kept"] == ["uploaded"] and report["converted"] == [] and not report["failed"]
    payload = repo.get(CatalogType.EXPERT_TEMPLATE, "uploaded").payload
    assert "avatar_url" not in payload
    assert payload["avatar_version"] == 3 and payload["avatar_sha256"] == "sha-new"
    assert store.read("uploaded") == b"RIFFnew-avatar-bytes"
