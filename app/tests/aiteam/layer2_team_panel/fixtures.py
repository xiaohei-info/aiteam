"""Layer2 Team Panel test fixtures.

Reuses Layer1 PostgreSQL bootstrap and seeds the minimum control-plane data
needed by the Team Panel northbound API contract tests.

Does NOT require the full test server — overrides the root autouse
test_server fixture to a no-op.
"""

import json
import os

import pytest

from team_panel.transactions.uow import UnitOfWork

from tests.aiteam.layer1_data.fixtures import clean_tables, db_conn  # noqa: F401


# Override the root conftest's autouse session-scoped test_server fixture.
# Layer2 tests only need PostgreSQL; they don't need the full web server.
@pytest.fixture(scope="session", autouse=True)
def test_server():
    """No-op: Layer2 tests don't need the test server."""
    yield None


@pytest.fixture(autouse=True)
def _clean_db(clean_tables):
    """Ensure each layer2 test runs against a fresh mutable schema."""
    yield


@pytest.fixture
def uow(db_conn):
    return UnitOfWork(db_conn)


@pytest.fixture
def clean_tables_with_enterprise(clean_tables, db_conn):
    cur = db_conn.cursor()
    data = {
        "enterprise_id": "ent_test",
        "employee_id": "emp_test",
        "template_id": "tpl_test",
        "solution_id": "sol_retail_v1",
        "conversation_id": "conv_test",
    }
    try:
        cur.execute(
            "INSERT INTO enterprise (id, slug, name, status, owner_user_id) VALUES (%s, %s, %s, %s, %s)",
            (data["enterprise_id"], "test-corp", "Test Corp", "active", "user_test"),
        )
        cur.execute(
            "INSERT INTO membership (id, enterprise_id, user_id, role, status, created_by) VALUES (%s, %s, %s, %s, %s, %s)",
            ("m_owner", data["enterprise_id"], "user_test", "owner", "active", "seed"),
        )
        cur.execute(
            "INSERT INTO membership (id, enterprise_id, user_id, role, status, created_by) VALUES (%s, %s, %s, %s, %s, %s)",
            ("m_member", data["enterprise_id"], "usr_member", "member", "active", "seed"),
        )
        cur.execute(
            "INSERT INTO membership (id, enterprise_id, user_id, role, status, created_by) VALUES (%s, %s, %s, %s, %s, %s)",
            ("m_finance", data["enterprise_id"], "usr_finance", "finance_admin", "active", "seed"),
        )
        cur.execute(
            "INSERT INTO membership (id, enterprise_id, user_id, role, status, created_by) VALUES (%s, %s, %s, %s, %s, %s)",
            ("m_enterprise", data["enterprise_id"], "usr_enterprise", "enterprise_admin", "active", "seed"),
        )
        cur.execute(
            "INSERT INTO agent_template (id, name, category_code, role_name, status, prompt_pack_json, default_model_json, default_binding_json, version_no, source_type) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                data["template_id"],
                "Marketing Analyst",
                "marketing",
                "市场分析",
                "published",
                json.dumps(
                    {
                        "description": "擅长竞品、增长、用户洞察",
                        "tags": ["营销", "策略"],
                        "preview_avatar_url": "https://cdn.example.com/avatars/marketing-analyst.png",
                        "price_tier": "standard",
                    },
                    ensure_ascii=False,
                ),
                json.dumps({"provider": "openai", "model": "gpt-4o"}, ensure_ascii=False),
                json.dumps(
                    {
                        "skills": ["web_search", "slides"],
                        "knowledge_bindings": [{"knowledge_id": "kb_style_guide", "scope": "enterprise"}],
                        "connector_requirements": [{"connector_type": "web_search", "required": False}],
                        "memory_config": {"type": "conversation scoped", "max_tokens": 8000},
                    },
                    ensure_ascii=False,
                ),
                1,
                "system",
            ),
        )
        cur.execute(
            "INSERT INTO industry_solution (id, name, status, tags_json, default_kb_blueprint_json, default_skill_bundle_json, default_collaboration_template_ref) VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)",
            (
                data["solution_id"],
                "Retail Growth Team",
                "published",
                '["retail"]',
                "{}",
                "{}",
                None,
            ),
        )
        cur.execute(
            "INSERT INTO solution_template_binding (id, solution_id, template_id, sequence_no, enabled) VALUES (%s, %s, %s, %s, %s)",
            (
                "sol_bind_retail_tpl_test",
                data["solution_id"],
                data["template_id"],
                1,
                True,
            ),
        )
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                data["employee_id"],
                data["enterprise_id"],
                data["template_id"],
                "emp-test",
                "Test Analyst",
                "市场分析",
                "active",
                "talent_market",
            ),
        )
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                "emp_member",
                data["enterprise_id"],
                data["template_id"],
                "emp-member",
                "Member Employee",
                "协作成员",
                "active",
                "talent_market",
            ),
        )
        cur.execute(
            "INSERT INTO employee (id, enterprise_id, template_id, profile_name, display_name, role_name, status, created_from) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                "emp_planner",
                data["enterprise_id"],
                data["template_id"],
                "emp-planner",
                "Planner Analyst",
                "规划协调",
                "active",
                "talent_market",
            ),
        )
        cur.execute(
            "INSERT INTO conversation (id, enterprise_id, type, status, title, entry_employee_id, last_message_preview, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                data["conversation_id"],
                data["enterprise_id"],
                "private",
                "active",
                "Test Conversation",
                data["employee_id"],
                "hello",
                "user_test",
            ),
        )
        cur.execute(
            "INSERT INTO department (id, enterprise_id, parent_id, name, visibility_scope, sort_order) VALUES (%s, %s, %s, %s, %s, %s)",
            ("dept_marketing", data["enterprise_id"], None, "市场部", "enterprise", 1),
        )
        cur.execute(
            "INSERT INTO department (id, enterprise_id, parent_id, name, visibility_scope, sort_order) VALUES (%s, %s, %s, %s, %s, %s)",
            ("dept_content", data["enterprise_id"], "dept_marketing", "内容组", "department", 2),
        )
        cur.execute(
            "INSERT INTO employee_org_assignment (id, enterprise_id, employee_id, department_id, position_title, visibility_scope) VALUES (%s, %s, %s, %s, %s, %s)",
            (data["employee_id"], data["enterprise_id"], data["employee_id"], "dept_marketing", "营销分析师", "department"),
        )
        db_conn.commit()
        return data
    except Exception:
        db_conn.rollback()
        raise
    finally:
        cur.close()


@pytest.fixture
def seeded_enterprise(clean_tables_with_enterprise):
    return clean_tables_with_enterprise


@pytest.fixture(autouse=True)
def _set_db_url(db_conn):
    """Point the router at the test DB via DATABASE_URL env var."""
    from tests.aiteam.layer1_data.fixtures import _DB_PASSWORD
    dsn = db_conn.get_dsn_parameters()
    url = (
        f"postgresql://{dsn.get('user')}:{_DB_PASSWORD}@"
        f"{dsn.get('host')}:{dsn.get('port')}/{dsn.get('dbname')}"
    )
    old = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    yield
    if old is not None:
        os.environ["DATABASE_URL"] = old
    else:
        os.environ.pop("DATABASE_URL", None)
