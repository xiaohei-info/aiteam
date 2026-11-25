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
    # 报表要能让运维直接定位到该改哪个模板。
    assert report.as_dict()["skipped_avatar_employees"] == [
        {"employee_id": "e1", "template_id": "tpl-1", "reason": "external_url"}
    ]


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

    report = AvatarBackfillReport()
    data = report.as_dict()
    assert set(data) == {
        "tenants",
        "employees",
        "seeded",
        "skipped_existing",
        "skipped_archived",
        "skipped_no_template",
        "skipped_avatar",
        "template_unavailable",
        "failed",
        "skipped_avatar_employees",
        "skipped_avatar_truncated",
    }
    assert data["skipped_avatar_employees"] == []
    assert data["skipped_avatar_truncated"] is False


def test_report_records_skipped_avatar_details_with_a_cap():
    from manager_service.avatar_backfill import MAX_SKIPPED_AVATAR_DETAILS, AvatarBackfillReport

    report = AvatarBackfillReport()
    for index in range(MAX_SKIPPED_AVATAR_DETAILS + 5):
        report.note_skipped_avatar(employee_id=f"e{index}", template_id="tpl-1", reason="external_url")

    data = report.as_dict()
    assert report.skipped_avatar == MAX_SKIPPED_AVATAR_DETAILS + 5
    assert len(data["skipped_avatar_employees"]) == MAX_SKIPPED_AVATAR_DETAILS
    assert data["skipped_avatar_employees"][0] == {"employee_id": "e0", "template_id": "tpl-1", "reason": "external_url"}
    assert data["skipped_avatar_truncated"] is True


@pytest.mark.parametrize(
    ("value", "reason"),
    [
        (None, "empty"),
        ("", "empty"),
        ("   ", "empty"),
        ("https://cdn.example/a.png", "external_url"),
        ("http://cdn.example/a.png", "external_url"),
        ("//cdn.example/a.png", "external_url"),
        ("/api/manager/employees/x/avatar/content", "relative_path"),
        ("avatars/x.webp", "relative_path"),
        ("data:text/plain;base64,AAAA", "unsupported_format"),
        ("data:image/gif;base64,****", "unsupported_format"),
    ],
)
def test_avatar_skip_reason_classifies_why_the_template_cannot_be_stored(value, reason):
    from manager_service.avatar_backfill import avatar_skip_reason

    assert avatar_skip_reason(value) == reason


class _FakeBackfill:
    def __init__(self, report):
        self.report = report
        self.calls: list[tuple[list[str], bool]] = []

    def run(self, tenant_ids, *, dry_run=False):
        self.calls.append((list(tenant_ids), dry_run))
        return self.report


def test_backfill_counts_a_vanished_employee_as_failed(tmp_path):
    from manager_service.avatar_backfill import AvatarBackfillReport

    class VanishingAvatars(_FakeAvatars):
        def update(self, ctx, *, employee_id, filename, mime_type, data):
            raise NotFound("employee not found in this tenant")

    report = AvatarBackfillReport()
    backfill = EmployeeAvatarBackfill(
        employees=_FakeEmployees({TENANT_A: [_row("gone")]}),
        avatars=VanishingAvatars(),
        catalog=_FakeCatalog({"tpl-1": PNG_DATA_URL}),
    )

    result = backfill.run([TENANT_A])

    assert result.failed == 1
    assert result.seeded == 0
    assert result.skipped_avatar == 0


def test_backfill_caches_template_pull_errors_so_operator_is_not_hammered():
    class UnreachableCatalog:
        def __init__(self):
            self.calls = 0

        def pull_expert_template(self, **_kwargs):
            self.calls += 1
            raise RuntimeError("operator unreachable")

    catalog = UnreachableCatalog()
    report = EmployeeAvatarBackfill(
        employees=_FakeEmployees({TENANT_A: [_row("e1"), _row("e2")]}),
        avatars=_FakeAvatars(),
        catalog=catalog,
    ).run([TENANT_A])

    assert catalog.calls == 1
    assert report.template_unavailable == 2
    assert report.failed == 0


def test_list_tenants_reads_registry_rows(monkeypatch):
    import sys
    from types import SimpleNamespace

    from manager_service import avatar_backfill

    executed: list[tuple[str, tuple]] = []

    class _Cursor:
        def fetchall(self):
            return [("11111111-1111-1111-1111-111111111111",), ("",), (None,)]

    class _Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def execute(self, sql, params):
            executed.append((sql, params))
            return _Cursor()

    fake = SimpleNamespace(connect=lambda dsn, autocommit=False: _Connection())
    monkeypatch.setitem(sys.modules, "psycopg", fake)

    assert avatar_backfill.list_tenants("postgresql://admin/db", limit=7) == [
        "11111111-1111-1111-1111-111111111111"
    ]
    assert "tenant_registry" in executed[0][0]
    assert executed[0][1] == (7,)


def test_build_backfill_defaults_to_the_operator_catalog_client(tmp_path, monkeypatch):
    from manager_service import avatar_backfill
    from manager_service.operator_catalog import OperatorCatalogClient

    # 装配路径本身不联网：这里只验证未注入 catalog 时用的是 Operator 目录客户端。
    monkeypatch.setattr(avatar_backfill, "service_client_kwargs", lambda _settings: {})
    backfill, _ = avatar_backfill.build_backfill(_settings(tmp_path))
    assert isinstance(backfill._catalog, OperatorCatalogClient)


def test_build_backfill_rejects_missing_db_url(tmp_path):
    from manager_service.avatar_backfill import build_backfill

    settings = _settings(tmp_path)
    settings.db_url = ""
    with pytest.raises(RuntimeError, match="DB_URL"):
        build_backfill(settings, catalog=_FakeCatalog({}))


def test_cli_main_prints_counts_and_returns_zero(tmp_path, monkeypatch, capsys):
    from types import SimpleNamespace

    from manager_service import avatar_backfill
    from manager_service.avatar_backfill import AvatarBackfillReport

    report = AvatarBackfillReport(tenants=1, employees=2, seeded=2)
    fake_backfill = _FakeBackfill(report)
    monkeypatch.setattr(avatar_backfill, "load_settings", lambda _tier: _settings(tmp_path))
    monkeypatch.setattr(avatar_backfill, "build_backfill", lambda *a, **k: (fake_backfill, lambda limit=500: [TENANT_A]))

    assert avatar_backfill.main(["--tenant", TENANT_A, "--dry-run"]) == 0
    assert fake_backfill.calls == [([TENANT_A], True)]
    printed = capsys.readouterr().out.strip()
    assert '"seeded": 2' in printed
    assert '"skipped_avatar_employees": []' in printed


def test_cli_main_uses_the_tenant_registry_when_no_tenant_is_given(tmp_path, monkeypatch):
    from manager_service import avatar_backfill
    from manager_service.avatar_backfill import AvatarBackfillReport

    fake_backfill = _FakeBackfill(AvatarBackfillReport())
    seen_limits: list[int] = []

    def tenants(limit=500):
        seen_limits.append(limit)
        return [TENANT_A, TENANT_B]

    monkeypatch.setattr(avatar_backfill, "load_settings", lambda _tier: _settings(tmp_path))
    monkeypatch.setattr(avatar_backfill, "build_backfill", lambda *a, **k: (fake_backfill, tenants))

    assert avatar_backfill.main(["--tenant-limit", "9"]) == 0
    assert fake_backfill.calls == [([TENANT_A, TENANT_B], False)]
    assert seen_limits == [9]


def test_cli_main_returns_nonzero_when_some_employees_fail(tmp_path, monkeypatch):
    from manager_service import avatar_backfill
    from manager_service.avatar_backfill import AvatarBackfillReport

    monkeypatch.setattr(avatar_backfill, "load_settings", lambda _tier: _settings(tmp_path))
    monkeypatch.setattr(
        avatar_backfill,
        "build_backfill",
        lambda *a, **k: (_FakeBackfill(AvatarBackfillReport(failed=1)), lambda limit=500: [TENANT_A]),
    )

    assert avatar_backfill.main(["--tenant", TENANT_A]) == 1


def test_cli_main_requires_an_operator_url(tmp_path, monkeypatch):
    from manager_service import avatar_backfill

    settings = _settings(tmp_path)
    settings.operator_url = None
    monkeypatch.setattr(avatar_backfill, "load_settings", lambda _tier: settings)

    with pytest.raises(RuntimeError, match="OPERATOR_URL"):
        avatar_backfill.main(["--tenant", TENANT_A])
