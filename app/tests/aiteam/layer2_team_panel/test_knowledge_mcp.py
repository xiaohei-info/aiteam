"""Task 3 — knowledge MCP 服务的纯函数与装配。"""

from __future__ import annotations

import uuid

import pytest

from team_panel.domain.entities import EmployeeKnowledgeBinding
from team_panel.integration import knowledge_mcp_server as kms
from team_panel.transactions.uow import UnitOfWork


def test_parse_bearer_token():
    assert kms.parse_bearer_token("Bearer emp_123") == "emp_123"
    assert kms.parse_bearer_token("bearer emp_x") == "emp_x"
    assert kms.parse_bearer_token("Basic abc") == ""
    assert kms.parse_bearer_token("") == ""
    assert kms.parse_bearer_token(None) == ""


def _seed_enterprise(db_conn, ent_id):
    cur = db_conn.cursor()
    cur.execute(
        "INSERT INTO enterprise (id, slug, name, status, owner_user_id) "
        "VALUES (%s, %s, %s, %s, %s)",
        (ent_id, f"s-{ent_id[:6]}", "Corp", "active", "u1"),
    )
    db_conn.commit()
    cur.close()


def _seed_employee(db_conn, ent_id, emp_id):
    cur = db_conn.cursor()
    cur.execute(
        "INSERT INTO employee (id, enterprise_id, profile_name, display_name, "
        "role_name, status, created_from, model_provider, model_name, "
        "prompt_version, config_version, capabilities_json) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (emp_id, ent_id, f"p-{emp_id[:8]}", f"N-{emp_id[:6]}", "assistant",
         "active", "talent_market", "openai", "gpt-4o", 1, 1, "{}"),
    )
    db_conn.commit()
    cur.close()


def _seed_kb(db_conn, ent_id, kb_id):
    cur = db_conn.cursor()
    cur.execute(
        "INSERT INTO knowledge_base (id, enterprise_id, name, description, "
        "status, document_count, storage_prefix) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (kb_id, ent_id, f"KB-{kb_id}", "", "active", 0, ""),
    )
    db_conn.commit()
    cur.close()


def _bind_kb(db_conn, ent_id, emp_id, kb_id, enabled=True):
    with UnitOfWork(db_conn) as uow:
        uow.employee_knowledge_bindings().create(EmployeeKnowledgeBinding(
            id=f"ekb_{uuid.uuid4().hex[:8]}", enterprise_id=ent_id,
            employee_id=emp_id, knowledge_base_id=kb_id, enabled=enabled,
        ))


def test_resolve_employee_kb_ids(db_conn, clean_tables):
    ent = f"ent_{uuid.uuid4().hex[:8]}"
    _seed_enterprise(db_conn, ent)
    _seed_employee(db_conn, ent, "emp_a")
    _seed_kb(db_conn, ent, "kb_1")
    _seed_kb(db_conn, ent, "kb_2")
    _bind_kb(db_conn, ent, "emp_a", "kb_1", enabled=True)
    _bind_kb(db_conn, ent, "emp_a", "kb_2", enabled=False)
    ids = kms.resolve_employee_kb_ids(db_conn, "emp_a")
    assert ids == ["kb_1"]
    assert kms.resolve_employee_kb_ids(db_conn, "emp_none") == []


def test_search_for_employee_merges_and_authorizes(db_conn, clean_tables, monkeypatch):
    ent = f"ent_{uuid.uuid4().hex[:8]}"
    _seed_enterprise(db_conn, ent)
    _seed_employee(db_conn, ent, "emp_a")
    _seed_kb(db_conn, ent, "kb_1")
    _bind_kb(db_conn, ent, "emp_a", "kb_1")

    calls = []

    def fake_query(kb_id, q, top_k=5, llm_provider=None):
        calls.append((kb_id, q))
        return {"chunks": [{"content": f"片段 from {kb_id}", "doc_id": "d1",
                            "file_name": "f.md", "score": 0.9}], "answer": ""}

    monkeypatch.setattr(kms.lightrag_service, "query", fake_query)

    out = kms.search_for_employee(db_conn, "emp_a", "入职流程", top_k=5)
    assert calls == [("kb_1", "入职流程")]
    assert out["chunks"][0]["kb_id"] == "kb_1"
    assert out["citations"][0]["knowledge_base_id"] == "kb_1"

    # 未授权员工 -> 不检索任何 KB。
    out2 = kms.search_for_employee(db_conn, "emp_none", "x")
    assert out2 == {"chunks": [], "citations": []}


def test_build_asgi_app_constructs():
    app = kms.build_asgi_app(conn_factory=lambda: None)
    assert app is not None
