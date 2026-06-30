"""运营端 admin 依赖装配（DI，S01/S03/S04）。

集中提供 AdminService 的构造：组合 AdminRepository + EnterpriseRepository +
CatalogRepository + RollupRepository。测试经 app.dependency_overrides 注入 fake。
"""

from __future__ import annotations

from functools import lru_cache

from .admin_repository import AdminRepository
from .admin_service import AdminService
from .catalog_dependencies import get_catalog_repository
from .dependencies import get_repository, get_rollup_repository


@lru_cache(maxsize=1)
def get_admin_repository() -> AdminRepository:
    """单例 admin 仓储（骨架进程内）。详设替换为 PG 实现。"""
    return AdminRepository()


def get_admin_service() -> AdminService:
    return AdminService(
        admin_repo=get_admin_repository(),
        enterprise_repo=get_repository(),
        catalog_repo=get_catalog_repository(),
        rollup_repo=get_rollup_repository(),
    )
