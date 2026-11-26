from __future__ import annotations

import json

import pytest

from manager_service.avatar_backfill import (
    BACKFILL_ACTOR,
    AvatarBackfillReport,
    EmployeeAvatarBackfill,
    backfill_context,
)
from manager_service.employee_config_repository import EmployeeConfigRow
from shared.errors import NotFound

WEBP = b"RIFF0000WEBPVP8 fake-bytes"

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"


def _row(
    employee_id: str,
    *,
    status: str = "active",
    template_id: str | None = "tpl-1",
    origin: str = "recruited",
) -> EmployeeConfigRow:
    return EmployeeConfigRow(
        employee_id=employee_id,
        employee_slug=employee_id,
        display_name=employee_id,
        persona=None,
        model=None,
        provider_ref=None,
        thinking_level=None,
        timeout_seconds=None,
        tools=[],
        skills=[],
        knowledge_refs=[],
        connector_refs=[],
        memory_policy=None,
        version=1,
        status=status,
        source_template_id=template_id,
        source_template_version="3",
        origin=origin,
    )


class _FakeEmployees:
    def __init__(self, rows_by_tenant: dict[str, list[EmployeeConfigRow]]):
        self._rows = rows_by_tenant
        self.seen_tenants: list[str] = []

    def list_all(self, ctx):
        self.seen_tenants.append(ctx.tenant_id)
        return list(self._rows.get(ctx.tenant_id, []))


class _FakeAvatars:
    """按 (tenant, employee) 记头像；`avatar_urls` 与服务端一样只列有头像的员工。"""

    def __init__(self, existing: set[tuple[str, str]] | None = None, *, failing: set[str] | None = None):
        self._existing = set(existing or set())
        self._failing = set(failing or set())
        self.seeded: list[tuple[str, str, bytes]] = []
        self.listed: list[str] = []

    def avatar_urls(self, ctx) -> dict[str, str]:
        self.listed.append(ctx.tenant_id)
        return {
            employee_id: f"/api/manager/employees/{employee_id}/avatar/content?v=1"
            for tenant_id, employee_id in self._existing
            if tenant_id == ctx.tenant_id
        }

    def seed_from_template(self, ctx, *, employee_id: str, data: bytes):
        if employee_id in self._failing:
            raise RuntimeError("storage unavailable")
        self.seeded.append((ctx.tenant_id, employee_id, data))
        self._existing.add((ctx.tenant_id, employee_id))
        return {"employee_id": employee_id, "version": 1}


class _FakeCatalog:
    """templates: template_id -> 头像字节；值为 None 表示模板没有头像；缺键表示不在发布范围。"""

    def __init__(self, templates: dict[str, bytes | None], *, broken: set[str] | None = None):
        self._templates = templates
        self._broken = set(broken or set())
        self.calls: list[tuple[str, str]] = []

    def pull_expert_template_avatar(self, *, template_id: str, tenant_id: str):
        self.calls.append((template_id, tenant_id))
        if template_id in self._broken:
            raise RuntimeError("operator unreachable")
        if template_id not in self._templates:
            raise NotFound("template not found")
        data = self._templates[template_id]
        return None if data is None else (data, 2)


def test_backfill_seeds_missing_template_avatar_and_pulls_each_template_once():
    employees = _FakeEmployees({TENANT_A: [_row("e1"), _row("e2")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": WEBP})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert (report.tenants, report.employees, report.seeded, report.failed) == (1, 2, 2, 0)
    # 方案展开时多个员工共用一个模板：字节只拉一次。
    assert catalog.calls == [("tpl-1", TENANT_A)]
    assert [(tenant, employee) for tenant, employee, _ in avatars.seeded] == [(TENANT_A, "e1"), (TENANT_A, "e2")]
    assert avatars.seeded[0][2] == WEBP


def test_backfill_does_not_touch_employees_that_already_have_an_avatar():
    # 管理员手工换过的头像不能被脚本盖掉。
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars(existing={(TENANT_A, "e1")})
    catalog = _FakeCatalog({"tpl-1": WEBP})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert (report.skipped_existing, report.seeded) == (1, 0)
    assert avatars.seeded == []
    assert catalog.calls == []


def test_backfill_queries_existing_avatars_once_per_tenant():
    employees = _FakeEmployees({TENANT_A: [_row("e1"), _row("e2"), _row("e3")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": WEBP})

    EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert avatars.listed == [TENANT_A]


def test_backfill_skips_archived_and_enterprise_created_employees():
    employees = _FakeEmployees(
        {TENANT_A: [_row("archived-1", status="archived"), _row("custom-1", template_id=None, origin="custom")]}
    )
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": WEBP})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert (report.skipped_archived, report.skipped_no_template, report.seeded) == (1, 1, 0)
    assert avatars.seeded == []


def test_backfill_skips_templates_without_an_avatar():
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": None})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert (report.skipped_template_no_avatar, report.seeded, report.failed) == (1, 0, 0)
    assert avatars.seeded == []


def test_backfill_counts_out_of_scope_template_without_failing():
    employees = _FakeEmployees({TENANT_A: [_row("e1", template_id="tpl-missing")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert (report.template_unavailable, report.failed, report.seeded) == (1, 0, 0)


def test_backfill_caches_an_unreachable_operator_instead_of_retrying_per_employee():
    employees = _FakeEmployees({TENANT_A: [_row("e1"), _row("e2")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": WEBP}, broken={"tpl-1"})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert (report.template_unavailable, report.failed) == (2, 0)
    assert catalog.calls == [("tpl-1", TENANT_A)]


def test_backfill_is_idempotent_across_runs():
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": WEBP})
    backfill = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog)

    first = backfill.run([TENANT_A])
    second = backfill.run([TENANT_A])

    assert (first.seeded, second.seeded) == (1, 0)
    assert second.skipped_existing == 1
    assert len(avatars.seeded) == 1


def test_backfill_dry_run_reports_without_writing():
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": WEBP})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run(
        [TENANT_A], dry_run=True
    )

    assert report.seeded == 1
    assert avatars.seeded == []


def test_backfill_isolates_each_tenant_context():
    employees = _FakeEmployees({TENANT_A: [_row("e1")], TENANT_B: [_row("e2")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": WEBP})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A, TENANT_B])

    assert report.tenants == 2
    assert employees.seen_tenants == [TENANT_A, TENANT_B]
    assert [(tenant, employee) for tenant, employee, _ in avatars.seeded] == [(TENANT_A, "e1"), (TENANT_B, "e2")]
    # 同一模板在不同租户各拉一次：发布范围按租户判定。
    assert catalog.calls == [("tpl-1", TENANT_A), ("tpl-1", TENANT_B)]


def test_backfill_continues_after_a_single_employee_failure():
    employees = _FakeEmployees({TENANT_A: [_row("bad"), _row("good")]})
    avatars = _FakeAvatars(failing={"bad"})
    catalog = _FakeCatalog({"tpl-1": WEBP})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert (report.failed, report.seeded) == (1, 1)
    assert [employee for _, employee, _ in avatars.seeded] == ["good"]


def test_backfill_context_marks_the_maintenance_actor():
    ctx = backfill_context(TENANT_A)
    assert ctx.tenant_id == TENANT_A
    assert ctx.user_id == BACKFILL_ACTOR
    assert ctx.roles == []


def _settings(tmp_path, *, admin_db_url="postgresql://admin/db"):
    from types import SimpleNamespace

    return SimpleNamespace(
        db_url="postgresql://manager/db",
        admin_db_url=admin_db_url,
        operator_url="http://operator.test",
        manager_data_root=str(tmp_path),
    )


def test_build_backfill_requires_the_tenant_database(tmp_path):
    from manager_service.avatar_backfill import build_backfill

    settings = _settings(tmp_path)
    settings.db_url = ""
    with pytest.raises(RuntimeError, match="DB_URL"):
        build_backfill(settings, catalog=_FakeCatalog({}))


def test_build_backfill_requires_admin_db_url_to_enumerate_tenants(tmp_path):
    from manager_service.avatar_backfill import build_backfill

    _, tenants = build_backfill(_settings(tmp_path, admin_db_url=None), catalog=_FakeCatalog({}))
    with pytest.raises(RuntimeError, match="ADMIN_DB_URL"):
        tenants()


def test_build_backfill_enumerates_tenants_from_the_control_database(tmp_path, monkeypatch):
    from manager_service import avatar_backfill

    calls: list[tuple[str, int]] = []

    def fake_list_tenants(admin_db_url: str, *, limit: int = 500) -> list[str]:
        calls.append((admin_db_url, limit))
        return [TENANT_A, TENANT_B]

    monkeypatch.setattr(avatar_backfill, "list_tenants", fake_list_tenants)
    _, tenants = avatar_backfill.build_backfill(_settings(tmp_path), catalog=_FakeCatalog({}))

    assert tenants(25) == [TENANT_A, TENANT_B]
    assert calls == [("postgresql://admin/db", 25)]


def test_main_prints_the_report_and_maps_failures_to_a_non_zero_exit(tmp_path, monkeypatch, capsys):
    from manager_service import avatar_backfill

    employees = _FakeEmployees({TENANT_A: [_row("bad"), _row("good")]})
    avatars = _FakeAvatars(failing={"bad"})
    catalog = _FakeCatalog({"tpl-1": WEBP})
    backfill = avatar_backfill.EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog)
    monkeypatch.setattr(avatar_backfill, "load_settings", lambda _tier: _settings(tmp_path))
    monkeypatch.setattr(avatar_backfill, "build_backfill", lambda _s: (backfill, lambda _limit: [TENANT_A]))

    assert avatar_backfill.main(["--tenant", TENANT_A]) == 1
    report = json.loads(capsys.readouterr().out)
    assert (report["seeded"], report["failed"]) == (1, 1)

    # dry-run 不写库，也不会因为上一轮的失败而非零退出。
    assert avatar_backfill.main(["--tenant", TENANT_A, "--dry-run"]) == 0


def test_main_requires_operator_url(tmp_path, monkeypatch):
    from manager_service import avatar_backfill

    settings = _settings(tmp_path)
    settings.operator_url = ""
    monkeypatch.setattr(avatar_backfill, "load_settings", lambda _tier: settings)
    with pytest.raises(RuntimeError, match="OPERATOR_URL"):
        avatar_backfill.main(["--tenant", TENANT_A])


def test_report_as_dict_lists_every_counter():
    assert set(AvatarBackfillReport().as_dict()) == {
        "tenants",
        "employees",
        "seeded",
        "skipped_existing",
        "skipped_archived",
        "skipped_no_template",
        "skipped_template_no_avatar",
        "template_unavailable",
        "failed",
    }
