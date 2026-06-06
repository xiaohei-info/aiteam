"""EnterpriseSkillInstall repository."""
from __future__ import annotations

from typing import Optional

from ..domain.entities import EnterpriseSkillInstall


class EnterpriseSkillInstallRepo:
    def __init__(self, cur):
        self._cur = cur

    def create(self, item: EnterpriseSkillInstall) -> EnterpriseSkillInstall:
        self._cur.execute(
            "INSERT INTO enterprise_skill_install (id, enterprise_id, skill_code, display_name, description, source_marketplace, version, latest_version, scope_mode, install_status, manifest_json, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)",
            (
                item.id, item.enterprise_id, item.skill_code, item.display_name, item.description,
                item.source_marketplace, item.version, item.latest_version, item.scope_mode,
                item.install_status, item.manifest_json, item.created_by or None, item.updated_by or None,
            ),
        )
        return item

    def get_by_id(self, install_id: str, *, include_deleted: bool = False) -> Optional[EnterpriseSkillInstall]:
        sql = (
            "SELECT id, enterprise_id, skill_code, display_name, description, source_marketplace, version, latest_version, scope_mode, install_status, manifest_json, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise_skill_install WHERE id = %s"
        )
        if not include_deleted:
            sql += " AND deleted_at IS NULL"
        self._cur.execute(sql, (install_id,))
        row = self._cur.fetchone()
        return _row_to_entity(row) if row else None

    def get_active_by_skill_code(self, enterprise_id: str, skill_code: str) -> Optional[EnterpriseSkillInstall]:
        self._cur.execute(
            "SELECT id, enterprise_id, skill_code, display_name, description, source_marketplace, version, latest_version, scope_mode, install_status, manifest_json, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise_skill_install WHERE enterprise_id = %s AND skill_code = %s AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
            (enterprise_id, skill_code),
        )
        row = self._cur.fetchone()
        return _row_to_entity(row) if row else None

    def list_by_enterprise(self, enterprise_id: str) -> list[EnterpriseSkillInstall]:
        self._cur.execute(
            "SELECT id, enterprise_id, skill_code, display_name, description, source_marketplace, version, latest_version, scope_mode, install_status, manifest_json, created_at, updated_at, created_by, updated_by, deleted_at "
            "FROM enterprise_skill_install WHERE enterprise_id = %s AND deleted_at IS NULL ORDER BY created_at DESC",
            (enterprise_id,),
        )
        return [_row_to_entity(row) for row in self._cur.fetchall()]

    def update(self, item: EnterpriseSkillInstall) -> EnterpriseSkillInstall:
        self._cur.execute(
            "UPDATE enterprise_skill_install SET display_name=%s, description=%s, source_marketplace=%s, version=%s, latest_version=%s, scope_mode=%s, install_status=%s, manifest_json=%s::jsonb, updated_at=now(), updated_by=%s WHERE id=%s AND deleted_at IS NULL",
            (
                item.display_name, item.description, item.source_marketplace, item.version,
                item.latest_version, item.scope_mode, item.install_status, item.manifest_json,
                item.updated_by or None, item.id,
            ),
        )
        return item

    def delete(self, install_id: str) -> None:
        self._cur.execute(
            "UPDATE enterprise_skill_install SET deleted_at=now(), updated_at=now(), install_status='uninstalled' WHERE id = %s AND deleted_at IS NULL",
            (install_id,),
        )

    def count_active_by_skill_code(self, skill_code: str) -> int:
        self._cur.execute(
            "SELECT COUNT(*) FROM enterprise_skill_install WHERE skill_code = %s AND deleted_at IS NULL",
            (skill_code,),
        )
        row = self._cur.fetchone()
        return int(row[0]) if row else 0


def _row_to_entity(row) -> EnterpriseSkillInstall:
    return EnterpriseSkillInstall(
        id=row[0], enterprise_id=row[1], skill_code=row[2], display_name=row[3] or '',
        description=row[4] or '', source_marketplace=row[5], version=row[6], latest_version=row[7],
        scope_mode=row[8], install_status=row[9], manifest_json=str(row[10]) if row[10] else '{}',
        created_at=str(row[11]), updated_at=str(row[12]), created_by=row[13] or '', updated_by=row[14] or '',
        deleted_at=str(row[15]) if row[15] else None,
    )
