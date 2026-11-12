"""行业文档生成：运营端依赖装配（DI）。

有 OPERATION_DB_URL → PostgreSQL 仓储；否则进程内内存仓储（dev / 测试）。测试经 app.dependency_overrides
替换 `get_solution_authoring_service`。
"""

from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from pathlib import Path

from shared.config import load_settings
from shared.errors import ServiceUnavailable
from shared.solution_authoring.runner import PiWorkerRunner

from .catalog_dependencies import get_catalog_service
from .platform_provider_repository import PlatformProviderRepository
from .platform_provider_service import build_platform_provider_service, newapi_urls
from .solution_authoring_jobs import GenerationJobExecutor
from .solution_authoring_models import ModelConfigResolver, PlatformModelCatalog, build_model_config_resolver
from .solution_authoring_repository import MemorySolutionAuthoringRepository, SolutionAuthoringRepository
from .solution_authoring_service import SolutionAuthoringService
from .solution_authoring_storage import SourceFileStore

STORAGE_DIR_ENV = "SOLUTION_AUTHORING_STORAGE_DIR"
WORKER_ENABLED_ENV = "SOLUTION_AUTHORING_WORKER_ENABLED"
WORKER_CONCURRENCY_ENV = "SOLUTION_AUTHORING_WORKER_CONCURRENCY"


@lru_cache(maxsize=1)
def get_solution_authoring_repository() -> SolutionAuthoringRepository:
    settings = load_settings("operation")
    if settings.db_url:
        from .solution_authoring_repository_pg import PgSolutionAuthoringRepository

        return PgSolutionAuthoringRepository(settings.db_url)
    return MemorySolutionAuthoringRepository()


@lru_cache(maxsize=1)
def get_source_file_store() -> SourceFileStore:
    configured = (os.getenv(STORAGE_DIR_ENV) or "").strip()
    if configured:
        return SourceFileStore(Path(configured))
    if load_settings("operation").is_production:
        raise ServiceUnavailable(f"solution generation storage is not configured on this Operator ({STORAGE_DIR_ENV} is missing)")
    return SourceFileStore(Path(tempfile.gettempdir()) / "aiteam-solution-authoring")


def build_platform_model_catalog() -> PlatformModelCatalog:
    """平台目录未配置齐（无库 / 无网关设置）时抛 RuntimeError，由解析器转成 503。"""
    settings = load_settings("operation")
    service = build_platform_provider_service()
    if not settings.db_url:
        raise RuntimeError("Operation database is not configured")
    _admin_url, public_url = newapi_urls(production=settings.is_production)
    return PlatformModelCatalog(service, PlatformProviderRepository(settings.db_url), public_url)


@lru_cache(maxsize=1)
def get_model_config_resolver() -> ModelConfigResolver:
    return build_model_config_resolver(build_platform_model_catalog, production=load_settings("operation").is_production)


def get_solution_authoring_service() -> SolutionAuthoringService:
    return SolutionAuthoringService(
        get_solution_authoring_repository(), get_source_file_store(), get_model_config_resolver(), get_catalog_service,
    )


def build_generation_job_executor() -> GenerationJobExecutor:
    models = get_model_config_resolver()
    return GenerationJobExecutor(
        get_solution_authoring_repository(), get_source_file_store(), models,
        PiWorkerRunner(allow_faux=models.uses_faux_model),
    )


def worker_enabled() -> bool:
    """任务执行器默认随持久化库启用；`SOLUTION_AUTHORING_WORKER_ENABLED=1/0` 可显式开关（无库的本机联调用 1）。"""
    flag = (os.getenv(WORKER_ENABLED_ENV) or "").strip()
    if flag in ("0", "1"):
        return flag == "1"
    settings = load_settings("operation")
    return bool(settings.db_url and settings.admin_db_url)


def worker_concurrency() -> int:
    raw = (os.getenv(WORKER_CONCURRENCY_ENV) or "").strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 1
