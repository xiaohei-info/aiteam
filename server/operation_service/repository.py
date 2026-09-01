"""运营端企业账号仓储（oper 库）。

持「企业账号 + 负责人 bootstrap 校验材料(hash/一次性) + 平台模型 allow-list」——03 §9.2：Operator 永不持企业
长期密码。提供内存实现（dev/测试）与 PostgreSQL 实现（生产）。

单写者：企业账号表唯一写端是 Operator（CLAUDE/AGENTS §3.2）。
"""

from __future__ import annotations

import json
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from shared.errors import Conflict, NotFound


@dataclass(frozen=True)
class EnterpriseAccount:
    """运营端企业账号记录。owner_bootstrap_hash 只存校验材料，绝不存长期/明文密码。"""

    enterprise_id: str
    tenant_id: str
    enterprise_name: str
    enterprise_code: str | None
    owner_phone: str
    owner_bootstrap_hash: str
    # None keeps legacy enterprises unrestricted; [] is an explicit deny-all policy.
    allowed_model_refs: list[dict] | None = None


class EnterpriseRepository(ABC):
    """企业账号仓储抽象接口。"""

    @abstractmethod
    def create(self, account: EnterpriseAccount) -> EnterpriseAccount:
        """创建企业账号。enterprise_id 或 enterprise_code 冲突 -> Conflict。"""
        ...

    @abstractmethod
    def get(self, enterprise_id: str) -> EnterpriseAccount:
        """按 ID 查询。不存在 -> NotFound。"""
        ...

    @abstractmethod
    def update_bootstrap_hash(self, enterprise_id: str, bootstrap_hash: str) -> EnterpriseAccount:
        """更新负责人 bootstrap 校验材料。不存在 -> NotFound。"""
        ...

    @abstractmethod
    def get_by_tenant_id(self, tenant_id: str) -> EnterpriseAccount:
        """按 Manager tenant_id 查询企业。不存在 -> NotFound。"""
        ...

    @abstractmethod
    def update_allowed_model_refs(
        self, enterprise_id: str, allowed_model_refs: list[dict] | None
    ) -> EnterpriseAccount:
        """更新企业级平台模型允许列表。None=不限制，[] = 不开放任何模型。"""
        ...


class InMemoryEnterpriseRepository(EnterpriseRepository):
    """企业账号的进程内仓储（dev/测试用）。线程不安全；单端测试与流程闭环足够。"""

    def __init__(self) -> None:
        self._by_id: dict[str, EnterpriseAccount] = {}
        self._codes: set[str] = set()

    def create(self, account: EnterpriseAccount) -> EnterpriseAccount:
        if account.enterprise_id in self._by_id:
            raise Conflict(f"enterprise already exists: {account.enterprise_id}")
        if account.enterprise_code and account.enterprise_code in self._codes:
            raise Conflict(f"enterprise_code already taken: {account.enterprise_code}")
        self._by_id[account.enterprise_id] = account
        if account.enterprise_code:
            self._codes.add(account.enterprise_code)
        return account

    def get(self, enterprise_id: str) -> EnterpriseAccount:
        account = self._by_id.get(enterprise_id)
        if account is None:
            raise NotFound(f"enterprise not found: {enterprise_id}")
        return account

    def update_bootstrap_hash(self, enterprise_id: str, bootstrap_hash: str) -> EnterpriseAccount:
        account = self.get(enterprise_id)
        updated = EnterpriseAccount(
            enterprise_id=account.enterprise_id,
            tenant_id=account.tenant_id,
            enterprise_name=account.enterprise_name,
            enterprise_code=account.enterprise_code,
            owner_phone=account.owner_phone,
            owner_bootstrap_hash=bootstrap_hash,
            allowed_model_refs=account.allowed_model_refs,
        )
        self._by_id[enterprise_id] = updated
        return updated

    def get_by_tenant_id(self, tenant_id: str) -> EnterpriseAccount:
        for account in self._by_id.values():
            if account.tenant_id == tenant_id:
                return account
        raise NotFound(f"enterprise not found for tenant: {tenant_id}")

    def update_allowed_model_refs(
        self, enterprise_id: str, allowed_model_refs: list[dict] | None
    ) -> EnterpriseAccount:
        account = self.get(enterprise_id)
        updated = EnterpriseAccount(
            enterprise_id=account.enterprise_id,
            tenant_id=account.tenant_id,
            enterprise_name=account.enterprise_name,
            enterprise_code=account.enterprise_code,
            owner_phone=account.owner_phone,
            owner_bootstrap_hash=account.owner_bootstrap_hash,
            allowed_model_refs=allowed_model_refs,
        )
        self._by_id[enterprise_id] = updated
        return updated


# ---- PostgreSQL 实现 ----
#
# oper 库是 Operation 专属单租户库，无 RLS（不同于 Manager 多租户 RLS）。
# 但采用业界规范：应用角色非 superuser、迁移/DDL 用独立管理连接。
# psycopg 延迟导入：保证 `import operation_service.repository` 在无 psycopg 环境下仍可用。

_APP_ROLE = "app_rw"
_MIGRATION_LOCK = threading.Lock()


class PgEnterpriseRepository(EnterpriseRepository):
    """企业账号 PostgreSQL 仓储（生产用）。

    连接身份即受约束角色 app_rw（业务 DSN）。oper 库单租户，无 RLS，但保持规范。
    每操作一个事务（自动提交/回滚），无状态持久化连接。
    """

    def __init__(self, dsn: str):
        self._dsn = dsn

    def create(self, account: EnterpriseAccount) -> EnterpriseAccount:
        import psycopg
        from psycopg.errors import UniqueViolation

        try:
            with psycopg.connect(self._dsn, autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO enterprise_account
                            (enterprise_id, tenant_id, enterprise_name, enterprise_code,
                             owner_phone, owner_bootstrap_hash, allowed_model_refs)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            account.enterprise_id,
                            account.tenant_id,
                            account.enterprise_name,
                            account.enterprise_code,
                            account.owner_phone,
                            account.owner_bootstrap_hash,
                            json.dumps(account.allowed_model_refs) if account.allowed_model_refs is not None else None,
                        ),
                    )
            return account
        except UniqueViolation as e:
            # 区分是 enterprise_id 还是 enterprise_code 冲突。
            if "enterprise_account_pkey" in str(e) or "enterprise_id" in str(e):
                raise Conflict(f"enterprise already exists: {account.enterprise_id}") from e
            if "enterprise_code" in str(e):
                raise Conflict(f"enterprise_code already taken: {account.enterprise_code}") from e
            raise Conflict(f"enterprise constraint violation: {e}") from e

    def get(self, enterprise_id: str) -> EnterpriseAccount:
        import psycopg

        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT enterprise_id, tenant_id, enterprise_name, enterprise_code,
                           owner_phone, owner_bootstrap_hash, allowed_model_refs
                    FROM enterprise_account
                    WHERE enterprise_id = %s
                    """,
                    (enterprise_id,),
                )
                row = cur.fetchone()

        if row is None:
            raise NotFound(f"enterprise not found: {enterprise_id}")

        return EnterpriseAccount(
            enterprise_id=str(row[0]),
            tenant_id=str(row[1]),
            enterprise_name=row[2],
            enterprise_code=row[3],
            owner_phone=row[4],
            owner_bootstrap_hash=row[5],
            allowed_model_refs=list(row[6]) if row[6] is not None else None,
        )

    def get_by_tenant_id(self, tenant_id: str) -> EnterpriseAccount:
        import psycopg

        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT enterprise_id, tenant_id, enterprise_name, enterprise_code,
                           owner_phone, owner_bootstrap_hash, allowed_model_refs
                    FROM enterprise_account
                    WHERE tenant_id = %s
                    """,
                    (tenant_id,),
                )
                row = cur.fetchone()
        if row is None:
            raise NotFound(f"enterprise not found for tenant: {tenant_id}")
        return EnterpriseAccount(
            enterprise_id=str(row[0]),
            tenant_id=str(row[1]),
            enterprise_name=row[2],
            enterprise_code=row[3],
            owner_phone=row[4],
            owner_bootstrap_hash=row[5],
            allowed_model_refs=list(row[6]) if row[6] is not None else None,
        )

    def update_allowed_model_refs(
        self, enterprise_id: str, allowed_model_refs: list[dict] | None
    ) -> EnterpriseAccount:
        import psycopg

        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE enterprise_account
                    SET allowed_model_refs = %s, updated_at = now()
                    WHERE enterprise_id = %s
                    """,
                    (json.dumps(allowed_model_refs) if allowed_model_refs is not None else None, enterprise_id),
                )
                if cur.rowcount == 0:
                    raise NotFound(f"enterprise not found: {enterprise_id}")
        return self.get(enterprise_id)

    def update_bootstrap_hash(self, enterprise_id: str, bootstrap_hash: str) -> EnterpriseAccount:
        import psycopg

        with psycopg.connect(self._dsn, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE enterprise_account
                    SET owner_bootstrap_hash = %s, updated_at = now()
                    WHERE enterprise_id = %s
                    """,
                    (bootstrap_hash, enterprise_id),
                )
                if cur.rowcount == 0:
                    raise NotFound(f"enterprise not found: {enterprise_id}")

        return self.get(enterprise_id)


def _migrations_dir() -> Path:
    # operation_service/migrations 与本文件同目录。
    here = Path(__file__).parent
    return here / "migrations"


def apply_migrations(db_url: str | None, app_rw_password: str | None = None) -> None:
    if not db_url:
        return None
    # Serialize first-request DDL/ALTER ROLE across concurrent Operator requests.
    with _MIGRATION_LOCK:
        return _apply_migrations_unlocked(db_url, app_rw_password)


def _apply_migrations_unlocked(db_url: str | None, app_rw_password: str | None = None) -> None:
    """首次连接自动应用迁移（建表脚本）。幂等。

    `db_url` 必须是**管理连接**（admin DSN：超管/DDL owner），用于建角色/DDL；
    业务连接（app_rw 身份）不得用于迁移。

    无 db_url（骨架/纯契约场景）→ no-op，保持对外契约不破坏。
    有 db_url → 以管理连接身份按文件名顺序执行 operation_service/migrations/*.sql。
    `app_rw_password`（来源配置/env，禁止硬编码）非空时，额外幂等下发 app_rw 的 LOGIN 口令。
    """
    if not db_url:
        return None

    import psycopg

    mig_dir = _migrations_dir()
    if not mig_dir.is_dir():
        return None

    files = sorted(f for f in mig_dir.glob("*.sql"))
    with psycopg.connect(db_url, autocommit=True) as conn:
        for fpath in files:
            sql = fpath.read_text(encoding="utf-8")
            with conn.cursor() as cur:
                cur.execute(sql)

        # 动态授予 CONNECT 权限（问题2修复：迁移脚本无法硬编码数据库名）
        with conn.cursor() as cur:
            # 获取当前数据库名
            cur.execute("SELECT current_database()")
            db_name = cur.fetchone()[0]
            # 幂等授权：GRANT 可重复执行
            from psycopg import sql as _sql

            cur.execute(
                _sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                    _sql.Identifier(db_name), _sql.Identifier(_APP_ROLE)
                )
            )

        if app_rw_password:
            # 幂等下发业务角色登录口令（口令来自配置/env，绝不入源码/迁移脚本）。
            from psycopg import sql as _sql

            with conn.cursor() as cur:
                cur.execute(
                    _sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(
                        _sql.Identifier(_APP_ROLE),
                        _sql.Literal(app_rw_password),
                    )
                )
    return None
