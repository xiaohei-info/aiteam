"""R5 租户生命周期：状态读取（带短缓存）、入口拦截、保留期后的数据清理。

状态真相在控制库 `tenant_registry.status`（active / suspended / banned / closed / deleted），
只能由 Operator 经服务间调用写入。业务连接（app_rw）无权写该表，这里一律走管理连接。
"""

from __future__ import annotations

import logging
import re
import shutil
import time
from collections.abc import Callable, Iterable
from pathlib import Path

from shared.errors import AppError, Conflict, ServiceUnavailable, problem_response

logger = logging.getLogger(__name__)

ACTIVE = "active"
STATUSES = ("active", "suspended", "banned", "closed", "deleted")
_CODES = {
    "suspended": "tenant_suspended", "banned": "tenant_banned",
    "closed": "tenant_closed", "deleted": "tenant_deleted",
}
_MESSAGES = {
    "suspended": "企业已暂停，仅可查看；管理操作已被禁用",
    "banned": "企业已被封禁",
    "closed": "企业已注销",
    "deleted": "企业已删除",
}
# 暂停期间仍放行的写操作：退出登录、用户端授权配置同步 / 用量与结算上报。
SUSPENDED_WRITE_ALLOWLIST = frozenset({
    "/api/auth/logout",
    "/api/manager/usage/upload",
    "/api/manager/usage/segment-outcomes",
    "/api/manager/snapshots",
})
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_CONTROL_PLANE_TABLES = frozenset({
    "tenant_registry", "tenant_signing_key", "operator_tenant_binding", "manager_onboarding_receipt",
})
_UUID = re.compile(r"^[0-9a-fA-F-]{36}$")


class TenantUnavailable(AppError):
    """企业不可用：按状态区分 problem code（tenant_suspended / tenant_banned / tenant_closed / tenant_deleted）。"""

    status, title = 403, "Tenant unavailable"

    def __init__(self, tenant_status: str):
        self.code = _CODES.get(tenant_status, "tenant_unavailable")
        super().__init__(_MESSAGES.get(tenant_status, "企业当前不可用"))


def check_access(tenant_status: str, method: str, path: str) -> None:
    """按租户状态判定一次请求；不放行则抛 TenantUnavailable。"""
    if tenant_status == ACTIVE or tenant_status not in _CODES:
        return
    if tenant_status == "suspended" and (
        method.upper() in _SAFE_METHODS or path in SUSPENDED_WRITE_ALLOWLIST
    ):
        return
    raise TenantUnavailable(tenant_status)


def fetch_tenant_status(admin_dsn: str, tenant_id: str) -> str:
    """直读控制库状态；未登记的租户视为 active（由其他校验处理不存在）。"""
    import psycopg

    try:
        with psycopg.connect(admin_dsn, autocommit=True) as conn:
            row = conn.execute("SELECT status FROM tenant_registry WHERE tenant_id = %s", (tenant_id,)).fetchone()
    except psycopg.Error as exc:
        raise ServiceUnavailable("Manager tenant status is unavailable") from exc
    return row[0] if row and row[0] else ACTIVE


class TenantStatusStore:
    """状态读取 + 5 秒进程内缓存，所以状态变更最多 5 秒后在各 Manager 进程生效。"""

    def __init__(self, admin_dsn: str, *, ttl: float = 5.0, clock: Callable[[], float] = time.monotonic,
                 fetch: Callable[[str, str], str] = fetch_tenant_status):
        self._dsn, self._ttl, self._clock, self._fetch = admin_dsn, ttl, clock, fetch
        self._cache: dict[str, tuple[float, str]] = {}

    def get(self, tenant_id: str) -> str:
        hit = self._cache.get(tenant_id)
        now = self._clock()
        if hit and now - hit[0] < self._ttl:
            return hit[1]
        try:
            value = self._fetch(self._dsn, tenant_id)
        except ServiceUnavailable:
            if hit:  # 控制库短暂不可用时沿用上次结果，避免全站 503
                return hit[1]
            raise
        self._cache[tenant_id] = (now, value)
        return value

    def invalidate(self, tenant_id: str) -> None:
        self._cache.pop(tenant_id, None)

    def record(self, tenant_id: str):
        """(status, purged_at) 或 None；直读不走缓存。"""
        import psycopg

        with psycopg.connect(self._dsn, autocommit=True) as conn:
            return conn.execute(
                "SELECT status, purged_at FROM tenant_registry WHERE tenant_id = %s", (tenant_id,),
            ).fetchone()

    def set_status(self, tenant_id: str, status: str, reason: str | None) -> bool:
        import psycopg

        with psycopg.connect(self._dsn, autocommit=True) as conn:
            cur = conn.execute(
                "UPDATE tenant_registry SET status = %s, status_reason = %s, status_changed_at = now() "
                "WHERE tenant_id = %s", (status, reason, tenant_id),
            )
            changed = cur.rowcount > 0
        self.invalidate(tenant_id)
        return changed


def install_tenant_status_guard(app) -> None:
    """统一入口拦截：先验签，验签通过才按租户状态放行；验签失败交给路由返回 401（不泄露租户状态）。"""

    @app.middleware("http")
    async def tenant_status_guard(request, call_next):
        store = getattr(request.app.state, "_tenant_status_store", None)
        verifier = getattr(request.app.state, "_token_verifier", None)
        header = request.headers.get("Authorization", "")
        if store is None or verifier is None or not header.startswith("Bearer ") or not request.url.path.startswith("/api/"):
            return await call_next(request)
        try:
            claims = verifier.verify(header[7:].strip())
        except Exception:  # noqa: BLE001 - 无效 token 由路由统一 401
            return await call_next(request)
        if not getattr(claims, "tenant_id", None):
            return await call_next(request)
        try:
            check_access(store.get(claims.tenant_id), request.method, request.url.path)
        except AppError as exc:
            return problem_response(exc, instance=request.url.path, request_id=getattr(request.state, "request_id", None))
        return await call_next(request)


def delete_in_dependency_order(tables: Iterable[str], try_delete: Callable[[str], bool]) -> None:
    """多轮删除：被外键挡住（try_delete 返回 False）的表留到下一轮；一轮无进展则报阻塞。"""
    pending = list(tables)
    while pending:
        blocked = [table for table in pending if not try_delete(table)]
        if len(blocked) == len(pending):
            raise Conflict("tenant purge is blocked by foreign keys: " + ", ".join(sorted(blocked)))
        pending = blocked


def purge_tenant_data(admin_dsn: str, tenant_id: str, storage_root: Path | None) -> dict[str, int]:
    """清理该租户的全部业务数据（按元数据发现带 tenant_id 的表，不手写表名单），并释放企业代码 / slug。

    同一事务内完成；可重入：已清理的租户再次调用不会报错。返回各表删除行数。
    """
    import psycopg
    from psycopg import errors, sql

    if not _UUID.match(tenant_id):
        raise Conflict("invalid tenant id")
    counts: dict[str, int] = {}
    with psycopg.connect(admin_dsn) as conn:
        tables = [r[0] for r in conn.execute(
            "SELECT c.table_name FROM information_schema.columns c "
            "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name "
            "WHERE c.table_schema = current_schema() AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'"
        ).fetchall() if r[0] not in _CONTROL_PLANE_TABLES]
        conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))

        def try_delete(table: str) -> bool:
            try:
                with conn.transaction():
                    cur = conn.execute(
                        sql.SQL("DELETE FROM {} WHERE tenant_id = %s::uuid").format(sql.Identifier(table)), (tenant_id,),
                    )
                    counts[table] = counts.get(table, 0) + cur.rowcount
                return True
            except errors.ForeignKeyViolation:
                return False

        delete_in_dependency_order(tables, try_delete)
        leftovers: dict[str, int] = {}
        for t in tables:
            row = conn.execute(
                sql.SQL("SELECT count(*) FROM {} WHERE tenant_id = %s::uuid").format(sql.Identifier(t)), (tenant_id,),
            ).fetchone()
            if row and row[0]:
                leftovers[t] = row[0]
        if leftovers:
            raise Conflict(f"tenant purge left rows behind: {leftovers}")
        conn.execute("DELETE FROM tenant_signing_key WHERE tenant_id = %s::uuid", (tenant_id,))
        conn.execute(
            "UPDATE tenant_registry SET enterprise_slug = %s, enterprise_code = %s, purged_at = now() "
            "WHERE tenant_id = %s::uuid", (f"deleted-{tenant_id}", f"deleted-{tenant_id}", tenant_id),
        )
    _remove_tenant_files(storage_root, tenant_id)
    return counts


def _remove_tenant_files(root: Path | None, tenant_id: str) -> None:
    if root is None:
        return
    for namespace in ("knowledge", "avatars"):
        target = root / namespace / tenant_id
        if target.is_symlink():
            logger.warning("skip symlinked tenant storage: %s", target)
        elif target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
