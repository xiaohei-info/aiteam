"""Exercise the provenance refresh SQL against the real employee table and triggers."""
from pathlib import Path
import uuid

import psycopg
import pytest

pytestmark = pytest.mark.integration


def test_provenance_refresh_advances_existing_template_employees_only(admin_url, two_tenants):
    migration = Path(__file__).resolve().parents[2] / "manager_service/migrations/0047_employee_provenance_refresh.sql"
    cases = [(two_tenants[0], "template-a"), (two_tenants[0], None), (two_tenants[1], "template-a")]
    with psycopg.connect(admin_url) as conn:
        try:
            ids = []
            for tenant_id, template_id in cases:
                row = conn.execute(
                    "INSERT INTO employee (tenant_id, employee_slug, source_template_id, source_template_version, version) "
                    "VALUES (%s, %s, %s, %s, 7) RETURNING id",
                    (tenant_id, "provenance-" + uuid.uuid4().hex, template_id, "v1" if template_id else None),
                ).fetchone()
                ids.append(row[0])
            conn.execute(migration.read_text())
            rows = dict(conn.execute("SELECT id, version FROM employee WHERE id = ANY(%s)", (ids,)).fetchall())
            assert [rows[employee_id] for employee_id in ids] == [8, 7, 8]
            assert conn.execute(
                "SELECT source_template_id, source_template_version FROM employee WHERE id=%s", (ids[0],),
            ).fetchone() == ("template-a", "v1")
        finally:
            conn.rollback()
