from __future__ import annotations

import base64

import pytest

from manager_service.avatar_backfill import (
    BACKFILL_ACTOR,
    EmployeeAvatarBackfill,
    backfill_context,
)
from manager_service.employee_config_repository import EmployeeConfigRow
from shared.errors import NotFound

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG).decode()

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"


def _row(employee_id: str, *, status: str = "active", template_id: str | None = "tpl-1", template_version: str | None = "3") -> EmployeeConfigRow:
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
        source_template_version=template_version,
        origin="recruited",
    )


class _FakeEmployees:
    def __init__(self, rows_by_tenant: dict[str, list[EmployeeConfigRow]]):
        self._rows = rows_by_tenant
        self.seen_tenants: list[str] = []

    def list_all(self, ctx):
        self.seen_tenants.append(ctx.tenant_id)
        return list(self._rows.get(ctx.tenant_id, []))


class _FakeAvatars:
    def __init__(self, existing: set[tuple[str, str]] | None = None, *, failing: set[str] | None = None):
        self._existing = set(existing or set())
        self._failing = set(failing or set())
        self.updates: list[tuple[str, str, str, str, str]] = []

    def exists(self, ctx, employee_id: str) -> bool:
        return (ctx.tenant_id, employee_id) in self._existing

    def update(self, ctx, *, employee_id: str, filename: str, mime_type: str, data: str):
        if employee_id in self._failing:
            raise RuntimeError("storage unavailable")
        self.updates.append((ctx.tenant_id, employee_id, filename, mime_type, data))
        self._existing.add((ctx.tenant_id, employee_id))
        return {"employee_id": employee_id, "avatar_url": f"/api/manager/employees/{employee_id}/avatar/content", "version": 1}


class _FakeCatalog:
    def __init__(self, templates: dict[str, str | None]):
        self._templates = templates
        self.calls: list[tuple[str, str | None, str | None]] = []

    def pull_expert_template(self, *, template_id: str, version: str | None = None, tenant_id: str | None = None):
        self.calls.append((template_id, version, tenant_id))
        if template_id not in self._templates:
            raise NotFound("template not found")
        avatar_url = self._templates[template_id]
        return type("Template", (), {"template_id": template_id, "avatar_url": avatar_url})()


def test_backfill_seeds_missing_template_avatar_once_per_template():
    employees = _FakeEmployees({TENANT_A: [_row("e1"), _row("e2")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": PNG_DATA_URL})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert report.tenants == 1
    assert report.employees == 2
    assert report.seeded == 2
    assert report.failed == 0
    assert [call[0] for call in catalog.calls] == ["tpl-1"]
    assert catalog.calls[0][1] == "3"
    assert catalog.calls[0][2] == TENANT_A
    assert [update[1] for update in avatars.updates] == ["e1", "e2"]
    assert avatars.updates[0][2] == "template-avatar"
    assert avatars.updates[0][3] == "image/png"
    assert avatars.updates[0][4] == base64.b64encode(PNG).decode()


def test_backfill_skips_employees_that_already_have_an_avatar():
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars(existing={(TENANT_A, "e1")})
    catalog = _FakeCatalog({"tpl-1": PNG_DATA_URL})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert report.skipped_existing == 1
    assert report.seeded == 0
    assert avatars.updates == []
    assert catalog.calls == []


def test_backfill_skips_archived_and_custom_employees():
    employees = _FakeEmployees({TENANT_A: [_row("archived-1", status="archived"), _row("custom-1", template_id=None)]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": PNG_DATA_URL})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert report.skipped_archived == 1
    assert report.skipped_no_template == 1
    assert report.seeded == 0
    assert avatars.updates == []


def test_backfill_skips_legacy_http_template_avatar():
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": "https://cdn.example/avatar.png"})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert report.skipped_avatar == 1
    assert report.seeded == 0
    assert avatars.updates == []


def test_backfill_counts_template_unavailable_without_failing():
    employees = _FakeEmployees({TENANT_A: [_row("e1", template_id="tpl-missing")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert report.template_unavailable == 1
    assert report.failed == 0
    assert report.seeded == 0


def test_backfill_is_idempotent_across_runs():
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": PNG_DATA_URL})
    backfill = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog)

    first = backfill.run([TENANT_A])
    second = backfill.run([TENANT_A])

    assert (first.seeded, second.seeded) == (1, 0)
    assert second.skipped_existing == 1
    assert len(avatars.updates) == 1


def test_backfill_dry_run_reports_without_writing():
    employees = _FakeEmployees({TENANT_A: [_row("e1")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": PNG_DATA_URL})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A], dry_run=True)

    assert report.seeded == 1
    assert avatars.updates == []


def test_backfill_isolates_each_tenant_context():
    employees = _FakeEmployees({TENANT_A: [_row("e1")], TENANT_B: [_row("e2")]})
    avatars = _FakeAvatars()
    catalog = _FakeCatalog({"tpl-1": PNG_DATA_URL})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A, TENANT_B])

    assert report.tenants == 2
    assert employees.seen_tenants == [TENANT_A, TENANT_B]
    assert [(update[0], update[1]) for update in avatars.updates] == [(TENANT_A, "e1"), (TENANT_B, "e2")]
    assert [call[2] for call in catalog.calls] == [TENANT_A, TENANT_B]


def test_backfill_continues_after_a_single_employee_failure():
    employees = _FakeEmployees({TENANT_A: [_row("bad"), _row("good")]})
    avatars = _FakeAvatars(failing={"bad"})
    catalog = _FakeCatalog({"tpl-1": PNG_DATA_URL})

    report = EmployeeAvatarBackfill(employees=employees, avatars=avatars, catalog=catalog).run([TENANT_A])

    assert report.failed == 1
    assert report.seeded == 1
    assert [update[1] for update in avatars.updates] == ["good"]


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


def test_report_as_dict_lists_every_counter():
    from manager_service.avatar_backfill import AvatarBackfillReport

    assert set(AvatarBackfillReport().as_dict()) == {
        "tenants",
        "employees",
        "seeded",
        "skipped_existing",
        "skipped_archived",
        "skipped_no_template",
        "skipped_avatar",
        "template_unavailable",
        "failed",
    }
