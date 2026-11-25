"""员工头像继承人才市场模板头像（无企业头像行时的回退口径）。

口径（v1 补充）：`employee_avatar` 行是**企业覆盖**，不是唯一来源。
- 有行 → 用行（企业上传/复制/回填）；
- 无行但员工来自人才市场模板 → 继承模板头像：快照/增量仍下发本企业头像 URL，
  内容接口按需到 Operator 目录取模板头像并缓存；
- 两者都没有 → 不下发 URL，前端回退插画。

覆盖点：纯投影口径、快照、增量 pull、内容接口回退、模板头像缓存（命中/换版本/目录不可用）。
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from shared.config import Settings
from shared.contracts.crosstier import AuthorizedConfigPullRequest
from shared.contracts.snapshot import ExecutionPolicy, ModelPolicy
from shared.contracts.tenancy import TenantContext

from manager_service.authorized_config_service import AuthorizedConfigService
from manager_service.employee_avatar_repository import EmployeeAvatarRow
from manager_service.employee_avatar_service import (
    avatar_content_url,
    avatar_projection,
)
from manager_service.schemas import EmployeeConfigOut
from manager_service.snapshot_service import SnapshotService
from manager_service.template_avatar_cache import TemplateAvatarCache

from tests.manager._auth_helper import make_inmem_verifier_and_signer, sign_inmem_token


_PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00"
    b"\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _data_url(raw: bytes = _PNG, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _ctx(roles=None, tenant_id="t-a", user_id="admin-1") -> TenantContext:
    return TenantContext(tenant_id=tenant_id, user_id=user_id, roles=roles or ["owner"])


def _config(**overrides) -> EmployeeConfigOut:
    base = dict(
        employee_id="e1",
        employee_slug="e1",
        version=7,
        status="active",
        display_name="销售主管",
        model_policy=ModelPolicy(model="m1", provider_ref="p1"),
        execution_policy=ExecutionPolicy(timeout_seconds=60),
    )
    base.update(overrides)
    return EmployeeConfigOut(**base)


def _avatar_row(**overrides) -> EmployeeAvatarRow:
    base = dict(
        employee_id="e1",
        avatar_url="/api/manager/employees/e1/avatar/content",
        storage_key="avatars/t-a/e1/x.webp",
        mime_type="image/webp",
        byte_size=123,
        sha256="0" * 64,
        version=2,
        updated_at=None,
    )
    base.update(overrides)
    return EmployeeAvatarRow(**base)


# ---- 投影口径 ---------------------------------------------------------------


def test_avatar_content_url_uses_public_base_when_configured():
    assert (
        avatar_content_url("e1", "https://manager.example.com/")
        == "https://manager.example.com/api/manager/employees/e1/avatar/content"
    )
    assert avatar_content_url("e1", None) == "/api/manager/employees/e1/avatar/content"


def test_avatar_projection_prefers_enterprise_row():
    url, version, sync = avatar_projection(
        employee_id="e1",
        config_version=7,
        avatar=_avatar_row(),
        source_template_id="tpl-1",
        source_template_version="3",
        public_base_url="https://m.example",
    )
    assert url == "/api/manager/employees/e1/avatar/content"
    assert version == 2
    assert sync == "7:avatar-2"


def test_avatar_projection_inherits_template_when_row_is_missing():
    url, version, sync = avatar_projection(
        employee_id="e1",
        config_version=7,
        avatar=None,
        source_template_id="tpl-1",
        source_template_version="3",
        public_base_url="https://m.example",
    )
    assert url == "https://m.example/api/manager/employees/e1/avatar/content"
    assert version == 0
    assert sync == "7:avatar-template-3"


def test_avatar_projection_without_any_source_is_empty():
    url, version, sync = avatar_projection(
        employee_id="e1",
        config_version=7,
        avatar=None,
        source_template_id=None,
        source_template_version=None,
        public_base_url="https://m.example",
    )
    assert url is None
    assert version == 0
    assert sync == "7:avatar-0"


def test_avatar_projection_marks_latest_template_when_version_missing():
    _url, _version, sync = avatar_projection(
        employee_id="e1",
        config_version=7,
        avatar=None,
        source_template_id="tpl-1",
        source_template_version=None,
        public_base_url=None,
    )
    assert sync == "7:avatar-template-latest"


# ---- 快照 -------------------------------------------------------------------


class _StaticConfig:
    def __init__(self, config: EmployeeConfigOut):
        self._config = config

    def get(self, _ctx, *, employee_id):
        assert employee_id == self._config.employee_id
        return self._config


class _StaticAvatars:
    def __init__(self, row: EmployeeAvatarRow | None):
        self._row = row

    def get(self, _ctx, _employee_id):
        return self._row


class _Members:
    def get_member(self, _ctx, member_id):
        return SimpleNamespace(id=member_id, status="active", roles=["owner"], department_ids=[])


def _snapshot(config: EmployeeConfigOut, row: EmployeeAvatarRow | None, base: str | None = "https://m.example"):
    svc = SnapshotService(
        config_service=_StaticConfig(config),
        grant_service=SimpleNamespace(),
        member_service=_Members(),
        avatar_repository=_StaticAvatars(row),
        avatar_public_base=base,
    )
    return svc.generate(_ctx(), member_id="admin-1", employee_id=config.employee_id)


def test_snapshot_inherits_template_avatar_without_enterprise_row():
    snap = _snapshot(_config(source_template_id="tpl-1", source_template_version="3"), None)
    assert snap.avatar_url == "https://m.example/api/manager/employees/e1/avatar/content"
    assert snap.avatar_version == 0
    assert snap.avatar_sync_version == "7:avatar-template-3"


def test_snapshot_enterprise_avatar_wins_over_template():
    snap = _snapshot(_config(source_template_id="tpl-1", source_template_version="3"), _avatar_row())
    assert snap.avatar_url == "/api/manager/employees/e1/avatar/content"
    assert snap.avatar_version == 2
    assert snap.avatar_sync_version == "7:avatar-2"


def test_snapshot_custom_employee_without_avatar_stays_empty():
    snap = _snapshot(_config(), None)
    assert snap.avatar_url is None
    assert snap.avatar_version == 0
    assert snap.avatar_sync_version == "7:avatar-0"


# ---- 增量 pull --------------------------------------------------------------


class _ConfigList:
    def __init__(self, configs):
        self._configs = configs

    def list_all(self, _ctx, with_status=True):
        return list(self._configs)


def _pull_service(config: EmployeeConfigOut, row: EmployeeAvatarRow | None, base: str | None = "https://m.example"):
    return AuthorizedConfigService(
        config_service=_ConfigList([config]),
        grant_service=SimpleNamespace(),
        member_service=SimpleNamespace(get_member=lambda _ctx, member_id: SimpleNamespace(
            id=member_id, status="active", roles=["member"], department_ids=[])),
        avatar_repository=_StaticAvatars(row),
        avatar_public_base=base,
    )


def _pull(service: AuthorizedConfigService, known: dict[str, str]):
    return service.pull(_ctx(roles=["owner"]), AuthorizedConfigPullRequest(
        tenant_id="t-a", member_id="admin-1", known_versions=known,
    ))


def test_authorized_pull_emits_inherited_avatar_and_resyncs_legacy_clients():
    service = _pull_service(_config(source_template_id="tpl-1", source_template_version="3"), None)
    # 老客户端只持有配置版本 → 继承头像上线后必须再拉一次。
    first = _pull(service, {"e1": "7"})
    assert len(first.experts) == 1
    assert first.experts[0]["avatar_url"] == "https://m.example/api/manager/employees/e1/avatar/content"
    assert first.experts[0]["avatar_version"] == 0
    assert first.experts[0]["avatar_sync_version"] == "7:avatar-template-3"
    # 已持有继承标记 → 无变化。
    assert _pull(service, {"e1": "7:avatar-template-3"}).experts == []


def test_authorized_pull_enterprise_avatar_still_wins():
    service = _pull_service(_config(source_template_id="tpl-1", source_template_version="3"), _avatar_row())
    result = _pull(service, {"e1": "7:avatar-template-3"})
    assert result.experts[0]["avatar_url"] == "/api/manager/employees/e1/avatar/content"
    assert result.experts[0]["avatar_sync_version"] == "7:avatar-2"


def test_authorized_pull_without_any_avatar_keeps_legacy_version_accepted():
    service = _pull_service(_config(), None)
    assert _pull(service, {"e1": "7"}).experts == []
    assert _pull(service, {"e1": "7:avatar-0"}).experts == []


# ---- 模板头像缓存 -----------------------------------------------------------


class _Catalog:
    def __init__(self, avatar_url: str | None, *, fail: bool = False):
        self.avatar_url = avatar_url
        self.fail = fail
        self.calls: list[dict] = []

    def pull_expert_template(self, *, template_id, version=None, tenant_id=None):
        self.calls.append({"template_id": template_id, "version": version, "tenant_id": tenant_id})
        if self.fail:
            raise RuntimeError("operator unreachable")
        return SimpleNamespace(template_id=template_id, avatar_url=self.avatar_url)


def test_template_avatar_cache_fetches_once_and_serves_from_disk(tmp_path: Path):
    catalog = _Catalog(_data_url())
    cache = TemplateAvatarCache(catalog, tmp_path)
    first = cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3")
    assert first is not None and first[1] == "image/webp"
    second = cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3")
    assert second == first
    assert len(catalog.calls) == 1
    assert catalog.calls[0]["version"] == "3"


def test_template_avatar_cache_refetches_on_template_version_change(tmp_path: Path):
    catalog = _Catalog(_data_url())
    cache = TemplateAvatarCache(catalog, tmp_path)
    cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3")
    cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="4")
    assert [call["version"] for call in catalog.calls] == ["3", "4"]


def test_template_avatar_cache_does_not_cache_catalog_failures(tmp_path: Path):
    catalog = _Catalog(_data_url(), fail=True)
    cache = TemplateAvatarCache(catalog, tmp_path)
    assert cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3") is None
    catalog.fail = False
    assert cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3") is not None


def test_template_avatar_cache_skips_legacy_external_avatar(tmp_path: Path):
    catalog = _Catalog("https://cdn.example.com/avatar.png")
    cache = TemplateAvatarCache(catalog, tmp_path)
    assert cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3") is None


def test_template_avatar_cache_ignores_corrupt_metadata(tmp_path: Path):
    catalog = _Catalog(_data_url())
    cache = TemplateAvatarCache(catalog, tmp_path)
    cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3")
    for meta in tmp_path.rglob("*.json"):
        meta.write_text(json.dumps({"template_id": "other"}), encoding="utf-8")
    assert cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3") is not None
    assert len(catalog.calls) == 2


def test_template_avatar_cache_without_catalog_returns_none(tmp_path: Path):
    cache = TemplateAvatarCache(None, tmp_path)
    assert cache.resolve(_ctx(), employee_id=_EMPLOYEE_ID, template_id="tpl-1", template_version="3") is None


# ---- 内容接口回退 -----------------------------------------------------------

_VERIFIER, _SIGNER = make_inmem_verifier_and_signer()
_EMPLOYEE_ID = "11111111-1111-1111-1111-111111111111"


def _client() -> TestClient:
    from shared.app_factory import create_app
    from manager_service.app import router as manager_router
    from manager_service.routes_employee import build_employee_router

    settings = Settings(tier="manager", service_name="aiteam-manager-service", db_url="postgresql://fake/fake")
    app = create_app(settings, manager_router)
    app.state._token_verifier = _VERIFIER
    app.include_router(build_employee_router(_VERIFIER))
    return TestClient(app)


def _auth_header() -> dict[str, str]:
    token = sign_inmem_token(_SIGNER, "t1", ["owner"], user_id="u1")
    return {"Authorization": f"Bearer {token}"}


def test_avatar_content_falls_back_to_template_avatar():
    client = _client()
    fake_service = SimpleNamespace(content=lambda _ctx, _employee_id: None)
    fake_cache = SimpleNamespace(resolve=lambda *_a, **_kw: (b"webp-bytes", "image/webp"))
    with patch("manager_service.routes_employee._avatar_service", return_value=fake_service), \
         patch("manager_service.routes_employee._service",
               return_value=SimpleNamespace(get=lambda _ctx, employee_id: _config(
                   employee_id=_EMPLOYEE_ID, source_template_id="tpl-1", source_template_version="3"))), \
         patch("manager_service.routes_employee._template_avatar_cache", return_value=fake_cache):
        response = client.get(
            f"/api/manager/employees/{_EMPLOYEE_ID}/avatar/content", headers=_auth_header(),
        )
    assert response.status_code == 200, response.text
    assert response.content == b"webp-bytes"
    assert response.headers["content-type"] == "image/webp"


def test_avatar_content_404_when_no_row_and_no_template_avatar():
    client = _client()
    fake_service = SimpleNamespace(content=lambda _ctx, _employee_id: None)
    fake_cache = SimpleNamespace(resolve=lambda *_a, **_kw: None)
    with patch("manager_service.routes_employee._avatar_service", return_value=fake_service), \
         patch("manager_service.routes_employee._service",
               return_value=SimpleNamespace(get=lambda _ctx, employee_id: _config(employee_id=_EMPLOYEE_ID))), \
         patch("manager_service.routes_employee._template_avatar_cache", return_value=fake_cache):
        response = client.get(
            f"/api/manager/employees/{_EMPLOYEE_ID}/avatar/content", headers=_auth_header(),
        )
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


@pytest.mark.parametrize("employee_id", ["not-a-uuid", ""])
def test_template_avatar_cache_rejects_invalid_employee_ids(tmp_path: Path, employee_id: str):
    cache = TemplateAvatarCache(_Catalog(_data_url()), tmp_path)
    assert cache.resolve(_ctx(), employee_id=employee_id, template_id="tpl-1", template_version="3") is None


# ---- 路由内部构造（缓存单例 / 继承判定分支） ---------------------------------


def _fake_request(settings, catalog=None):
    state = SimpleNamespace(settings=settings, _operator_catalog=catalog)
    return SimpleNamespace(app=SimpleNamespace(state=state), base_url="http://m.example/")


def _tmp_settings(tmp_path: Path) -> Settings:
    return Settings(
        tier="manager",
        service_name="aiteam-manager-service",
        db_url="postgresql://fake/fake",
        manager_data_root=str(tmp_path),
    )


def test_template_avatar_cache_is_built_once_per_app(tmp_path: Path):
    from manager_service.routes_employee import _template_avatar_cache

    request = _fake_request(_tmp_settings(tmp_path), catalog=_Catalog(_data_url()))
    first = _template_avatar_cache(request)
    assert isinstance(first, TemplateAvatarCache)
    assert _template_avatar_cache(request) is first


def test_inherited_avatar_skips_employees_without_template(tmp_path: Path):
    from manager_service.routes_employee import _inherited_avatar

    request = _fake_request(_tmp_settings(tmp_path))
    with patch("manager_service.routes_employee._service",
               return_value=SimpleNamespace(get=lambda _ctx, employee_id: _config(employee_id=employee_id))):
        assert _inherited_avatar(request, _ctx(), _EMPLOYEE_ID) is None


def test_inherited_avatar_returns_none_when_employee_is_not_found(tmp_path: Path):
    from shared.errors import NotFound
    from manager_service.routes_employee import _inherited_avatar

    def _raise(_ctx, *, employee_id):
        raise NotFound("employee not found")

    request = _fake_request(_tmp_settings(tmp_path))
    with patch("manager_service.routes_employee._service", return_value=SimpleNamespace(get=_raise)):
        assert _inherited_avatar(request, _ctx(), _EMPLOYEE_ID) is None


def test_inherited_avatar_resolves_through_template_cache(tmp_path: Path):
    from manager_service.routes_employee import _inherited_avatar

    request = _fake_request(_tmp_settings(tmp_path))
    cache = SimpleNamespace(resolve=lambda *_a, **_kw: (b"cached", "image/webp"))
    with patch("manager_service.routes_employee._service",
               return_value=SimpleNamespace(get=lambda _ctx, employee_id: _config(
                   employee_id=employee_id, source_template_id="tpl-1", source_template_version="3"))), \
         patch("manager_service.routes_employee._template_avatar_cache", return_value=cache):
        assert _inherited_avatar(request, _ctx(), _EMPLOYEE_ID) == (b"cached", "image/webp")
