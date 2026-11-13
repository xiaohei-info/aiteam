"""Review 修复补充（企业端）：复制专家时的头像复制、发布范围对账的装配与遍历（不依赖真实 PG）。"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from manager_service import catalog_scope_wiring
from manager_service.employee_avatar_repository import EmployeeAvatarRow
from manager_service.employee_avatar_service import EmployeeAvatarService
from shared.contracts.tenancy import TenantContext

T = "11111111-1111-4111-8111-111111111111"
SRC = "22222222-2222-4222-8222-222222222222"
DST = "33333333-3333-4333-8333-333333333333"
CTX = TenantContext(tenant_id=T, user_id="u1", roles=["owner"])


class _AvatarRepo:
    def __init__(self, row, *, fail=False):
        self.row, self.fail, self.upserts = row, fail, []

    def get(self, ctx, employee_id):
        return self.row if employee_id == SRC else None

    def upsert(self, ctx, **fields):
        if self.fail:
            raise RuntimeError("metadata unavailable")
        self.upserts.append(fields)


def _source_row(key: str) -> EmployeeAvatarRow:
    return EmployeeAvatarRow(
        employee_id=SRC, avatar_url="http://m/a", storage_key=key, mime_type="image/webp",
        byte_size=3, sha256="h", version=1, updated_at=datetime(2026, 11, 13, tzinfo=UTC),
    )


def _with_source_file(root: Path) -> str:
    key = f"avatars/{T}/{SRC}/a.webp"
    (root / key).parent.mkdir(parents=True)
    (root / key).write_bytes(b"img")
    return key


def test_copy_avatar_creates_an_independent_file_and_record(tmp_path):
    repo = _AvatarRepo(_source_row(_with_source_file(tmp_path)))
    EmployeeAvatarService(repo, tmp_path, "http://manager").copy(CTX, source_id=SRC, target_id=DST)  # type: ignore[arg-type]
    [fields] = repo.upserts
    assert fields["employee_id"] == DST and fields["storage_key"].startswith(f"avatars/{T}/{DST}/")
    assert fields["avatar_url"] == f"http://manager/api/manager/employees/{DST}/avatar/content"
    copied = tmp_path / fields["storage_key"]
    assert copied.read_bytes() == b"img" and (copied.stat().st_mode & 0o777) == 0o600
    assert (tmp_path / f"avatars/{T}/{SRC}/a.webp").exists()  # 源文件不动


def test_copy_avatar_without_source_does_nothing(tmp_path):
    repo = _AvatarRepo(None)
    EmployeeAvatarService(repo, tmp_path, "http://manager").copy(CTX, source_id=SRC, target_id=DST)  # type: ignore[arg-type]
    missing_file = _AvatarRepo(_source_row(f"avatars/{T}/{SRC}/gone.webp"))
    EmployeeAvatarService(missing_file, tmp_path, "http://manager").copy(CTX, source_id=SRC, target_id=DST)  # type: ignore[arg-type]
    assert repo.upserts == [] and missing_file.upserts == []


def test_copy_avatar_removes_the_file_when_the_record_cannot_be_written(tmp_path):
    repo = _AvatarRepo(_source_row(_with_source_file(tmp_path)), fail=True)
    with pytest.raises(RuntimeError, match="metadata unavailable"):
        EmployeeAvatarService(repo, tmp_path, "http://manager").copy(CTX, source_id=SRC, target_id=DST)  # type: ignore[arg-type]
    assert list((tmp_path / "avatars" / T / DST).rglob("*.webp")) == []


# ---- 发布范围对账的装配 ----

def _messages(caplog) -> str:
    # 用原始消息而不是 caplog.text：应用装上的脱敏格式器会把带异常的日志整条替换掉。
    return "\n".join(record.getMessage() for record in caplog.records)


def _request(*, db_url="postgresql://biz", admin_db_url="postgresql://admin", catalog=object()):
    state = SimpleNamespace(settings=SimpleNamespace(db_url=db_url, admin_db_url=admin_db_url), _operator_catalog=catalog)
    return SimpleNamespace(app=SimpleNamespace(state=state))


def test_build_reconciler_needs_a_database_and_the_operator_catalog(monkeypatch):
    assert catalog_scope_wiring.build_reconciler(_request(db_url=None)) is None  # type: ignore[arg-type]
    assert catalog_scope_wiring.build_reconciler(_request(catalog=None)) is None  # type: ignore[arg-type]
    monkeypatch.setattr(catalog_scope_wiring, "PgTenantRouter", lambda dsn: ("router", dsn))
    assert catalog_scope_wiring.build_reconciler(_request()) is not None  # type: ignore[arg-type]


def test_reconcile_all_tenants_walks_every_tenant_and_isolates_failures(monkeypatch, caplog):
    seen = []

    class Reconciler:
        def reconcile(self, ctx, *, template_id):
            seen.append((ctx.tenant_id, template_id))
            if ctx.tenant_id == "t2":
                raise RuntimeError("tenant db down")

    pages = {None: ["t1", "t2"], "t2": ["t3"], "t3": []}
    monkeypatch.setattr(catalog_scope_wiring, "build_reconciler", lambda request: Reconciler())
    monkeypatch.setattr(catalog_scope_wiring, "_list_manager_tenants", lambda dsn, *, after: pages[after])
    with caplog.at_level("WARNING", logger=catalog_scope_wiring.logger.name):
        catalog_scope_wiring.reconcile_all_tenants(_request(), "tpl-1")  # type: ignore[arg-type]
    assert seen == [("t1", "tpl-1"), ("t2", "tpl-1"), ("t3", "tpl-1")]
    assert "scope reconcile failed for tenant t2" in _messages(caplog)


def test_reconcile_all_tenants_is_a_no_op_or_logs_without_raising(monkeypatch, caplog):
    monkeypatch.setattr(catalog_scope_wiring, "build_reconciler", lambda request: pytest.fail("must not build"))
    catalog_scope_wiring.reconcile_all_tenants(_request(admin_db_url=None), "tpl")  # type: ignore[arg-type]

    monkeypatch.setattr(catalog_scope_wiring, "build_reconciler", lambda request: None)
    catalog_scope_wiring.reconcile_all_tenants(_request(), "tpl")  # type: ignore[arg-type]

    def boom(dsn, *, after):
        raise RuntimeError("control db down")

    monkeypatch.setattr(catalog_scope_wiring, "build_reconciler", lambda request: SimpleNamespace())
    monkeypatch.setattr(catalog_scope_wiring, "_list_manager_tenants", boom)
    with caplog.at_level("WARNING", logger=catalog_scope_wiring.logger.name):
        catalog_scope_wiring.reconcile_all_tenants(_request(), "tpl")  # type: ignore[arg-type]
    assert "scope reconcile sweep failed" in _messages(caplog)


def test_reconcile_for_admin_skips_members_and_swallows_errors(monkeypatch, caplog):
    monkeypatch.setattr(catalog_scope_wiring, "build_reconciler", lambda request: pytest.fail("must not build"))
    member = TenantContext(tenant_id=T, user_id="u", roles=["member"])
    catalog_scope_wiring.reconcile_for_admin(_request(), member)  # type: ignore[arg-type]

    def broken(request):
        raise RuntimeError("operator down")

    monkeypatch.setattr(catalog_scope_wiring, "build_reconciler", broken)
    with caplog.at_level("WARNING", logger=catalog_scope_wiring.logger.name):
        catalog_scope_wiring.reconcile_for_admin(_request(), CTX)  # type: ignore[arg-type]
    assert "scope reconcile (on read) failed" in _messages(caplog)
