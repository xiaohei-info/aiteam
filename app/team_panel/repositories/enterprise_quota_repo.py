"""EnterpriseQuota repository — persistence for enterprise_quota table."""

from typing import Optional

from ..domain.entities import EnterpriseQuota


class EnterpriseQuotaRepo:
    """Repository for EnterpriseQuota entity backed by a psycopg cursor."""

    def __init__(self, cur):
        self._cur = cur

    def get_by_enterprise(self, enterprise_id: str) -> Optional[EnterpriseQuota]:
        self._cur.execute(
            "SELECT enterprise_id, employee_quota, storage_quota_mb, "
            "api_rate_limit, token_quota, created_at, updated_at, "
            "created_by, updated_by "
            "FROM enterprise_quota WHERE enterprise_id = %s",
            (enterprise_id,),
        )
        row = self._cur.fetchone()
        if row is None:
            return None
        return EnterpriseQuota(
            enterprise_id=row[0],
            employee_quota=row[1],
            storage_quota_mb=row[2],
            api_rate_limit=row[3],
            token_quota=row[4],
            created_at=str(row[5]),
            updated_at=str(row[6]),
            created_by=row[7] or "",
            updated_by=row[8] or "",
        )

    def create(self, quota: EnterpriseQuota) -> EnterpriseQuota:
        self._cur.execute(
            "INSERT INTO enterprise_quota (enterprise_id, employee_quota, "
            "storage_quota_mb, api_rate_limit, token_quota, created_by, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (quota.enterprise_id, quota.employee_quota,
             quota.storage_quota_mb, quota.api_rate_limit, quota.token_quota,
             quota.created_by or None, quota.updated_by or None),
        )
        return quota

    def update(self, quota: EnterpriseQuota) -> EnterpriseQuota:
        self._cur.execute(
            "UPDATE enterprise_quota SET employee_quota=%s, "
            "storage_quota_mb=%s, api_rate_limit=%s, token_quota=%s, "
            "updated_at=now(), updated_by=%s "
            "WHERE enterprise_id=%s",
            (quota.employee_quota, quota.storage_quota_mb,
             quota.api_rate_limit, quota.token_quota,
             quota.updated_by or None, quota.enterprise_id),
        )
        return quota

    def get_or_create(self, enterprise_id: str, *, defaults: dict) -> EnterpriseQuota:
        existing = self.get_by_enterprise(enterprise_id)
        if existing is not None:
            return existing
        quota = EnterpriseQuota(
            enterprise_id=enterprise_id,
            employee_quota=int(defaults.get("employee_quota", 50)),
            storage_quota_mb=int(defaults.get("storage_quota_mb", 1024)),
            api_rate_limit=int(defaults.get("api_rate_limit", 100)),
            token_quota=int(defaults.get("token_quota", 0)),
            created_by=str(defaults.get("created_by") or ""),
            updated_by=str(defaults.get("updated_by") or ""),
        )
        return self.create(quota)
