"""租户数据底座骨架（04 §6.1.1/§6.1.2/§6.1.3，D20/D21/D22）。

统一入口（04 §6.1.1）：
    request -> shared/auth 解析 token -> TenantContext -> TenantRouter.session()
    -> SET LOCAL app.tenant_id -> repository 查询

铁律（D22）：任何 session/router/rag 都**只从 TenantContext 读 tenant_id**，禁止接受调用方
手写 tenant 字符串；业务代码不感知 L1/L2/L3 差异，只经 TenantRouter/TenantDataSession。

本文件是**抽象 + 内存 dev 实现**，用于在真实 PG 落地前就锁住"按 tenant 隔离"的接口形状与
隔离语义测试。**真实 PostgreSQL + RLS + `SET LOCAL app.tenant_id` + 连接池租户边界由 M0 落地**
（04 §6.1.1）；真实 LightRAG workspace 路由由 ManagerRagService 实现（04 §6.1.2）。
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any

from shared.contracts.enums import IsolationLevel
from shared.contracts.tenancy import TenantContext


class TenantDataSession(ABC):
    """租户作用域的数据会话。真实实现进入事务前 `SET LOCAL app.tenant_id`（04 §6.1.1）。"""

    @property
    @abstractmethod
    def tenant_id(self) -> str:
        ...


class TenantRouter(ABC):
    """按隔离档位把 TenantContext 路由到对应数据会话（04 §6.1.1，D20）。"""

    @abstractmethod
    def isolation_level(self, tenant_id: str) -> IsolationLevel:
        ...

    @abstractmethod
    def session(self, ctx: TenantContext) -> TenantDataSession:
        ...


class ManagerRagService(ABC):
    """RAG 租户隔离封装（04 §6.1.2，D21）。workspace 只能由本服务从 TenantContext 推导。"""

    @staticmethod
    def derive_workspace(tenant_id: str, knowledge_space_id: str) -> str:
        """workspace = tenant_id + knowledge_space_id（04 §6.1.2）。禁止前端/Agent 直传 workspace。"""
        return f"t{tenant_id.replace('-', '')}__{knowledge_space_id}"

    @abstractmethod
    def get(self, ctx: TenantContext, knowledge_space_id: str) -> Any:
        ...


# ---- 内存 dev 实现（仅本地/测试；真实 PG/RLS 由 M0 替换）----

class InMemoryTenantSession(TenantDataSession):
    def __init__(self, store: dict[str, dict[str, Any]], tenant_id: str):
        self._store = store
        self._tenant_id = tenant_id

    @property
    def tenant_id(self) -> str:
        return self._tenant_id

    def put(self, key: str, value: Any) -> None:
        self._store.setdefault(self._tenant_id, {})[key] = value

    def get(self, key: str) -> Any:
        # 只能看到本 tenant 数据——模拟 RLS 隔离语义（真实由 PG RLS 强制）。
        return self._store.get(self._tenant_id, {}).get(key)


class InMemoryTenantRouter(TenantRouter):
    """默认全部 L1；演进档位由真实实现按 isolation_policy 决定。"""

    def __init__(self):
        self._store: dict[str, dict[str, Any]] = {}

    def isolation_level(self, tenant_id: str) -> IsolationLevel:
        return IsolationLevel.L1_SHARED_RLS

    def session(self, ctx: TenantContext) -> InMemoryTenantSession:
        return InMemoryTenantSession(self._store, ctx.tenant_id)


# ---- 真实 PostgreSQL + RLS 实现（04 §6.1.1，D20/D22）----
#
# 隔离铁律落地（#60：从连接身份层根除超管旁路面）：
#   - 业务连接**直接以受约束角色 app_rw（非 superuser、非 BYPASSRLS、非表 owner）身份建连**，
#     业务 DSN 即 `postgresql://app_rw:...@.../...`；不再运行时 SET LOCAL ROLE 降权。
#     连接身份本身受 RLS 约束，故即使后续误写 RESET ROLE 也无超管可回退。
#   - 每事务进入前只 SET LOCAL app.tenant_id = ctx.tenant_id（绑定租户，事务级）。
#   - tenant_id 只从 TenantContext 取，session 不接受调用方手写 tenant 过滤（D22）。
#   - SET LOCAL 是事务级，事务结束自动失效，连接池复用无残留上下文。
#   - 迁移/建角色/DDL 与控制面表（如签名私钥）走独立的**管理连接**（admin DSN，超管/DDL owner）。
#
# psycopg 延迟导入：默认 `-m 'not integration'` 门不需要 PG，故 import 进函数/方法内，
# 保证 `import shared.db` 在无 psycopg 环境（纯契约/单测）下仍可用。

_APP_ROLE = "app_rw"


class PgTenantSession(TenantDataSession):
    """租户作用域的 PG 事务会话（04 §6.1.1）。

    用法（上下文管理器，事务边界 = 隔离边界）：
        with router.session(ctx) as s:
            s.execute("SELECT ...", params)
    连接身份即受约束角色 app_rw（业务 DSN）。进入即 BEGIN + SET LOCAL app.tenant_id；
    正常退出 COMMIT，异常 ROLLBACK。
    """

    def __init__(self, dsn: str, tenant_id: str):
        self._dsn = dsn
        self._tenant_id = tenant_id
        self._conn = None  # type: ignore[var-annotated]
        self._cur = None  # type: ignore[var-annotated]

    @property
    def tenant_id(self) -> str:
        return self._tenant_id

    def __enter__(self) -> "PgTenantSession":
        import psycopg

        # 连接身份已是 app_rw（业务 DSN），无需 SET LOCAL ROLE 降权（#60）。
        self._conn = psycopg.connect(self._dsn, autocommit=False)
        self._cur = self._conn.cursor()
        # 绑定租户（事务级，配连接池安全）。
        # set_config(..., is_local=true) ≡ SET LOCAL，但支持参数绑定（避免 SQL 注入 / 引号问题）。
        self._cur.execute("SELECT set_config('app.tenant_id', %s, true)", (self._tenant_id,))
        return self

    def execute(self, sql: str, params: tuple | list | None = None):
        """在租户事务内执行 SQL，返回 cursor（可 .fetchone()/.fetchall()）。"""
        self._cur.execute(sql, params)
        return self._cur

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._cur.close()
            self._conn.close()


class PgTenantRouter(TenantRouter):
    """按隔离档位把 TenantContext 路由到 PG 会话（04 §6.1.1，D20）。

    L1（默认）：共享库共享表 + RLS。L2/L3 演进时按 isolation_policy 路由到不同 schema/库，
    业务代码不感知差异（只拿到一个 TenantDataSession）。
    """

    def __init__(self, dsn: str):
        self._dsn = dsn

    def isolation_level(self, tenant_id: str) -> IsolationLevel:
        # M0 默认 L1；L2/L3 路由按 tenant_registry.isolation_level 演进（留详设）。
        return IsolationLevel.L1_SHARED_RLS

    def session(self, ctx: TenantContext) -> PgTenantSession:
        return PgTenantSession(self._dsn, ctx.tenant_id)


def _migrations_dir() -> str:
    # manager_service/migrations 与本文件同属 server/ 包根下。
    here = os.path.dirname(os.path.abspath(__file__))
    server_root = os.path.dirname(os.path.dirname(here))
    return os.path.join(server_root, "manager_service", "migrations")


def apply_migrations(db_url: str | None, app_rw_password: str | None = None) -> None:
    """首次连接自动应用迁移（04 §6.4：建表脚本，非数据迁移）。幂等。

    `db_url` 必须是**管理连接**（admin DSN：超管/DDL owner），用于建角色/DDL/RLS（#60）；
    业务连接（app_rw 身份）不得用于迁移。

    无 db_url（骨架/纯契约场景）→ no-op，保持对外契约不破坏。
    有 db_url → 以管理连接身份按文件名顺序执行 manager_service/migrations/*.sql，
    迁移负责创建受约束角色 app_rw、租户表与 RLS 策略。
    `app_rw_password`（来源配置/env，禁止硬编码）非空时，额外幂等下发 app_rw 的 LOGIN 口令，
    使业务连接可直接以 app_rw 身份建连——口令只在管理连接内 ALTER ROLE，不入迁移脚本。
    """
    if not db_url:
        return None

    import psycopg

    mig_dir = _migrations_dir()
    if not os.path.isdir(mig_dir):
        return None
    files = sorted(f for f in os.listdir(mig_dir) if f.endswith(".sql"))
    with psycopg.connect(db_url, autocommit=True) as conn:
        for fname in files:
            with open(os.path.join(mig_dir, fname), encoding="utf-8") as fh:
                sql = fh.read()
            with conn.cursor() as cur:
                cur.execute(sql)
        if app_rw_password:
            # 幂等下发业务角色登录口令（口令来自配置/env，绝不入源码/迁移脚本）。
            # 用 psycopg.sql 安全拼接（ALTER ROLE 的 PASSWORD 不支持参数占位符）。
            from psycopg import sql as _sql

            with conn.cursor() as cur:
                cur.execute(
                    _sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(
                        _sql.Identifier(_APP_ROLE),
                        _sql.Literal(app_rw_password),
                    )
                )
    return None
