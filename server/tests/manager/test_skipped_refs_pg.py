"""授权同步 skipped_refs：真 PostgreSQL + 真路由，Manager 写目录 → 成员同步读到原因（设计 2026-11-22 §3.4）。"""

import pytest

from manager_service.capability_catalog_service import build_capability_catalog_service
from manager_service.schemas import EmployeeConfigIn, SkillCatalogIn
from tests.manager.test_knowledge_policy_pg import policy_pg  # noqa: F401  复用「员工 + 成员授权 + 路由」夹具

pytestmark = pytest.mark.integration


def _skill(catalog, ctx, skill_id):
    catalog.create_skill(ctx, SkillCatalogIn(
        skill_id=skill_id, display_name=skill_id, version="1",
        files=[{"path": "SKILL.md", "content": f"---\nname: {skill_id}\ndescription: Fixture\n---\nDo it."}],
    ))


def _pull(f, version):
    r = f.client.post("/api/manager/grants/authorized-config", headers=f.headers(f.member), json={
        "tenant_id": f.ctx.tenant_id, "member_id": f.member, "known_versions": {f.eid: str(version)},
    })
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_member_sync_learns_why_each_skill_was_not_delivered(policy_pg):  # noqa: F811
    f = policy_pg
    catalog = build_capability_catalog_service(f.router)
    for skill_id in ("weekly", "stopped", "gone"):
        _skill(catalog, f.ctx, skill_id)
    current = f.config.get(f.ctx, employee_id=f.eid)
    updated = f.config.update(f.ctx, EmployeeConfigIn(
        display_name=current.display_name, skills=["weekly", "stopped", "gone"],
        model_policy=current.model_policy, execution_policy=current.execution_policy,
    ), employee_id=f.eid)
    assert _pull(f, updated.version)["skipped_refs"] == []

    by_id = {item.skill_id: item for item in catalog.list_skills(f.ctx)}
    catalog.delete_skill(f.ctx, catalog_id=by_id["gone"].catalog_id, remove_from_employees=False)
    catalog.update_skill(f.ctx, SkillCatalogIn(skill_id="stopped", binding_policy="disabled"),
                         catalog_id=by_id["stopped"].catalog_id, remove_from_employees=False)

    data = _pull(f, updated.version)  # 员工配置没变：不重发专家，但原因照样给
    assert data["experts"] == []
    assert {(item["skill_id"], item["reason"], item["employee_id"]) for item in data["skipped_refs"]} == {
        ("stopped", "disabled", f.eid), ("gone", "missing", f.eid),
    }
    # 管理员重新启用：原因消失
    catalog.update_skill(f.ctx, SkillCatalogIn(skill_id="stopped", binding_policy="opt_in"), catalog_id=by_id["stopped"].catalog_id)
    assert {item["skill_id"] for item in _pull(f, updated.version)["skipped_refs"]} == {"gone"}
