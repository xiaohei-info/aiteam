from __future__ import annotations

from team_panel.domain.entities import EnterpriseSkillInstall
from team_panel.repositories.enterprise_skill_install_repo import EnterpriseSkillInstallRepo


def _seed_enterprise(db_conn):
    cur = db_conn.cursor()
    try:
        cur.execute(
            "INSERT INTO enterprise (id, slug, name, status, owner_user_id) VALUES (%s, %s, %s, %s, %s)",
            ("ent_skill", "ent-skill", "Skill Corp", "active", "usr_skill"),
        )
        db_conn.commit()
    finally:
        cur.close()


def test_enterprise_skill_install_repo_crud(db_conn, clean_tables):
    _seed_enterprise(db_conn)
    cur = db_conn.cursor()
    repo = EnterpriseSkillInstallRepo(cur)

    item = EnterpriseSkillInstall(
        id="esi_001", enterprise_id="ent_skill", skill_code="web-search", display_name="Web Search",
        description="Search the web", source_marketplace="builtin", version="1.0.0", latest_version="1.1.0",
        scope_mode="selected_employees", install_status="update_available", manifest_json='{"tags": ["search"]}',
    )
    repo.create(item)
    db_conn.commit()

    loaded = repo.get_by_id("esi_001")
    assert loaded is not None
    assert loaded.skill_code == "web-search"
    assert loaded.install_status == "update_available"
    assert repo.count_active_by_skill_code("web-search") == 1

    item.version = "1.1.0"
    item.latest_version = "1.1.0"
    item.install_status = "active"
    item.updated_by = "usr_skill"
    repo.update(item)
    db_conn.commit()

    updated = repo.get_by_id("esi_001")
    assert updated is not None
    assert updated.version == "1.1.0"
    assert updated.install_status == "active"
    assert repo.get_active_by_skill_code("ent_skill", "web-search").id == "esi_001"

    repo.delete("esi_001")
    db_conn.commit()
    assert repo.get_by_id("esi_001") is None
