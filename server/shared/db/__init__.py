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


def apply_migrations(db_url: str | None) -> None:
    """schema migration 首次连接自动应用的占位（04 §6.4：建表脚本，非数据迁移）。

    真实实现按端读取各自 migrations 目录并幂等应用；骨架期 no-op。
    """
    return None
