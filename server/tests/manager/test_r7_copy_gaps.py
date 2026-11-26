"""R7 复制专家的补充单测（不依赖真实 PG）：头像路径越界、slug 兜底、服务装配与路由里的懒加载。"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from manager_service import employee_copy_service, routes_employee
from manager_service.employee_avatar_repository import EmployeeAvatarRow
from manager_service.employee_avatar_service import EmployeeAvatarService, InvalidAvatar
from manager_service.employee_copy_service import EmployeeCopyService, _unique_slug, build_employee_copy_service
from shared.contracts.tenancy import TenantContext

T = "11111111-1111-4111-8111-111111111111"
SRC = "22222222-2222-4222-8222-222222222222"
DST = "33333333-3333-4333-8333-333333333333"


def _request(db_url="postgresql://fake/business"):
    state = SimpleNamespace(settings=SimpleNamespace(db_url=db_url, manager_data_root="/unused"),
                            _operator_catalog=None)
    return SimpleNamespace(app=SimpleNamespace(state=state), base_url="http://manager/")


def test_copy_avatar_rejects_a_target_key_that_escapes_the_storage_root(tmp_path):
    row = EmployeeAvatarRow(
        employee_id=SRC, storage_key=f"avatars/{T}/{SRC}.webp", mime_type="image/webp",
        byte_size=3, sha256="h", version=1, updated_at=datetime(2026, 11, 13, tzinfo=UTC),
    )
    repo = SimpleNamespace(get=lambda ctx, employee_id: row, upsert=lambda *a, **k: pytest.fail("不应写入"))
    # 租户 id 带 ".." 使头像路径解析到存储根目录之外。
    evil = TenantContext(tenant_id="../../escape", user_id="u1", roles=["owner"])
    with pytest.raises(InvalidAvatar):
        EmployeeAvatarService(repo, tmp_path / "root").copy(evil, source_id=SRC, target_id=DST)  # type: ignore[arg-type]


def test_unique_slug_falls_back_to_a_random_suffix_when_candidates_run_out():
    class AllTaken:
        def get_by_slug(self, ctx, *, employee_slug):
            return object()

    slug = _unique_slug(AllTaken(), None, "Copy Name")
    assert slug.startswith("copy_name_") and len(slug) == len("copy_name_") + 7


def test_build_copy_service_wires_transaction_scoped_repositories():
    service = build_employee_copy_service("router", None, "avatars", "config")
    assert isinstance(service, EmployeeCopyService)
    repos = service._repositories(SimpleNamespace())  # type: ignore[attr-defined]
    assert {type(repos.employees).__name__, type(repos.memory).__name__} == {
        "EmployeeConfigRepository", "EmployeeMemorySettingRepository",
    }


def test_avatar_service_requires_business_db():
    with pytest.raises(Exception) as exc:
        routes_employee._avatar_service(_request(None))
    assert "DB_URL" in str(exc.value)


def test_avatar_service_is_built_once_per_app(tmp_path):
    request = _request()
    with patch.object(routes_employee, "PgTenantRouter"), \
            patch.object(routes_employee, "manager_storage_root", return_value=tmp_path), \
            patch.object(routes_employee, "ensure_storage_root", return_value=tmp_path):
        first = routes_employee._avatar_service(request)
        second = routes_employee._avatar_service(request)
    # 不再从请求 Host 头推导公网地址：投影只发同源相对路径。
    assert first is second and not hasattr(first, "_public_base")


def test_copy_service_is_built_once_from_the_shared_services():
    request = _request()
    with patch.object(routes_employee, "PgTenantRouter") as router, \
            patch.object(routes_employee, "_avatar_service", return_value="avatars"), \
            patch.object(routes_employee, "_service", return_value="config"), \
            patch.object(routes_employee, "build_employee_copy_service", return_value=object()) as build:
        first = routes_employee._copy_service(request)
        second = routes_employee._copy_service(request)
    assert first is second
    build.assert_called_once_with(router.return_value, None, "avatars", "config")
