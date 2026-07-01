"""运营端 admin 依赖装配（DI，S01/S03/S04）。

集中提供 AdminService 的构造：组合 AdminRepository + EnterpriseRepository +
CatalogRepository + RollupRepository + SolutionRepository。测试经 app.dependency_overrides 注入 fake。
"""

from __future__ import annotations

from functools import lru_cache

from .admin_repository import AdminRepository
from .admin_service import AdminService
from .catalog_dependencies import get_catalog_repository
from .dependencies import get_manager_gateway, get_repository, get_rollup_repository
from .health_probes import build_agent_health_probe, build_manager_health_probe
from .solution_repository import SolutionRepository

@lru_cache(maxsize=1)
def get_admin_repository() -> AdminRepository:
    """单例 admin 仓储（骨架进程内）。详设替换为 PG 实现。"""
    return AdminRepository()

@lru_cache(maxsize=1)
def get_solution_repository() -> SolutionRepository:
    """单例行业方案统计仓储（骨架进程内）。详设替换为 PG 实现。"""
    return SolutionRepository()

def get_admin_service() -> AdminService:
    return AdminService(
        admin_repo=get_admin_repository(),
        enterprise_repo=get_repository(),
        catalog_repo=get_catalog_repository(),
        rollup_repo=get_rollup_repository(),
        solution_repo=get_solution_repository(),
        manager_gateway=get_manager_gateway(),
        manager_health=build_manager_health_probe(),
        agent_health=build_agent_health_probe(),
    )
