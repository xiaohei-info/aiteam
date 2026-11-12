"""行业文档生成：依赖装配、进程内任务轮询，以及任务执行器的几条失败路径。"""

from __future__ import annotations

import logging
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import operation_service.solution_authoring_dependencies as deps
from operation_service.solution_authoring_jobs import GenerationJobExecutor, install_solution_authoring_worker_lifespan
from operation_service.solution_authoring_models import FAUX_ENV, RELAY_TOKEN_ENV, FauxModelConfigResolver, PlatformModelCatalog, RelayModelConfigResolver
from operation_service.solution_authoring_repository import MemorySolutionAuthoringRepository
from operation_service.solution_authoring_repository_pg import PgSolutionAuthoringRepository
from operation_service.solution_authoring_service import SolutionAuthoringService
from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import ServiceUnavailable
from shared.solution_authoring.parsing import ParseLimits
from tests.operation.test_solution_authoring_service import MANUAL, Env

REF = PlatformModelRef(provider_id="provider-1", model_id="model-1")
_CACHED = (deps.get_solution_authoring_repository, deps.get_source_file_store, deps.get_model_config_resolver)
_ENV = (
    "OPERATION_DB_URL", "OPERATION_ADMIN_DB_URL", "DB_URL", "ADMIN_DB_URL", "NEWAPI_URL", "NEWAPI_ADMIN_BASE_URL",
    "NEWAPI_PUBLIC_BASE_URL", deps.STORAGE_DIR_ENV, deps.WORKER_ENABLED_ENV, deps.WORKER_CONCURRENCY_ENV, FAUX_ENV, RELAY_TOKEN_ENV,
)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    for cached in _CACHED:
        cached.cache_clear()
    yield
    for cached in _CACHED:
        cached.cache_clear()


def _with_database(monkeypatch) -> None:
    monkeypatch.setenv("OPERATION_DB_URL", "postgresql://app_rw@localhost/oper")
    monkeypatch.setenv("OPERATION_ADMIN_DB_URL", "postgresql://admin@localhost/oper")


@pytest.fixture
def env(tmp_path) -> Env:
    return Env(tmp_path)


# ---- 依赖装配 ----

def test_repository_follows_the_operation_database_setting(monkeypatch):
    assert isinstance(deps.get_solution_authoring_repository(), MemorySolutionAuthoringRepository)
    deps.get_solution_authoring_repository.cache_clear()
    _with_database(monkeypatch)
    # 构造不连库：连接在第一次读写时才建立。
    assert isinstance(deps.get_solution_authoring_repository(), PgSolutionAuthoringRepository)


def test_source_store_needs_an_explicit_directory_in_production(monkeypatch, tmp_path):
    assert deps.get_source_file_store().root == Path(tempfile.gettempdir()) / "aiteam-solution-authoring"

    deps.get_source_file_store.cache_clear()
    monkeypatch.setenv(deps.STORAGE_DIR_ENV, f"  {tmp_path / 'sources'}  ")
    assert deps.get_source_file_store().root == tmp_path / "sources"

    deps.get_source_file_store.cache_clear()
    monkeypatch.delenv(deps.STORAGE_DIR_ENV)
    monkeypatch.setattr(deps, "load_settings", lambda _tier: SimpleNamespace(is_production=True))
    with pytest.raises(ServiceUnavailable) as raised:
        deps.get_source_file_store()
    assert deps.STORAGE_DIR_ENV in str(raised.value)


def test_model_catalog_needs_the_gateway_settings_and_the_database(monkeypatch):
    def unconfigured():
        raise RuntimeError("Operator LLM gateway settings are incomplete")

    monkeypatch.setattr(deps, "build_platform_provider_service", unconfigured)
    with pytest.raises(RuntimeError, match="gateway settings"):
        deps.build_platform_model_catalog()

    monkeypatch.setattr(deps, "build_platform_provider_service", lambda: object())
    with pytest.raises(RuntimeError, match="database"):
        deps.build_platform_model_catalog()

    _with_database(monkeypatch)
    monkeypatch.setenv("NEWAPI_PUBLIC_BASE_URL", "http://127.0.0.1:3000/v1")
    assert isinstance(deps.build_platform_model_catalog(), PlatformModelCatalog)


def test_model_resolver_turns_an_unconfigured_catalog_into_a_503(monkeypatch):
    resolver = deps.get_model_config_resolver()
    assert isinstance(resolver, RelayModelConfigResolver)
    # 本测试环境没有网关设置：选模型时得到 503，而不是未处理的异常。
    with pytest.raises(ServiceUnavailable):
        resolver.check(REF, need_images=False)

    deps.get_model_config_resolver.cache_clear()
    monkeypatch.setenv(FAUX_ENV, "1")
    assert isinstance(deps.get_model_config_resolver(), FauxModelConfigResolver)


def test_service_and_executor_are_assembled_without_touching_node_or_the_database(monkeypatch, tmp_path):
    monkeypatch.setenv(deps.STORAGE_DIR_ENV, str(tmp_path))
    monkeypatch.setenv("SOLUTION_AUTHORING_WORKER_DIR", str(tmp_path / "no-worker-here"))
    assert isinstance(deps.get_solution_authoring_service(), SolutionAuthoringService)
    executor = deps.build_generation_job_executor()
    assert isinstance(executor, GenerationJobExecutor)
    # 没有排队的任务：不会去找 Node。
    assert executor.run_once() is False
    executor.shutdown()


def test_worker_switch_and_concurrency(monkeypatch):
    assert deps.worker_enabled() is False
    monkeypatch.setenv(deps.WORKER_ENABLED_ENV, "1")
    assert deps.worker_enabled() is True
    _with_database(monkeypatch)
    monkeypatch.setenv(deps.WORKER_ENABLED_ENV, "0")
    assert deps.worker_enabled() is False
    monkeypatch.setenv(deps.WORKER_ENABLED_ENV, "yes")  # 认不出的取值：按默认规则
    assert deps.worker_enabled() is True
    monkeypatch.delenv(deps.WORKER_ENABLED_ENV)
    assert deps.worker_enabled() is True

    for raw, expected in (("", 1), ("abc", 1), ("0", 1), ("-2", 1), (" 3 ", 3), ("9", 9)):
        monkeypatch.setenv(deps.WORKER_CONCURRENCY_ENV, raw)
        assert deps.worker_concurrency() == expected


# ---- 进程内任务轮询 ----

class _Executor:
    """假执行器：前 `busy` 次有活可干，之后空转；记录调用次数与是否被关停。"""

    def __init__(self, busy: int = 0, fail_first: bool = False):
        self.calls = 0
        self.busy, self.fail_first = busy, fail_first
        self.stopped = 0
        self.reached = threading.Event()
        self._lock = threading.Lock()

    def run_once(self) -> bool:
        with self._lock:
            self.calls += 1
            call = self.calls
        if self.fail_first and call == 1:
            raise RuntimeError("质量手册第一章")
        if call >= self.busy + 2:
            self.reached.set()
        return call <= self.busy

    def shutdown(self) -> None:
        self.stopped += 1


def _app(build_executor, **options) -> FastAPI:
    app = FastAPI()
    install_solution_authoring_worker_lifespan(app, build_executor, poll_seconds=0.01, **options)
    return app


def test_poller_builds_the_executor_once_keeps_polling_and_shuts_it_down():
    executor = _Executor(busy=2)
    built: list[int] = []

    def build():
        built.append(1)
        return executor

    with TestClient(_app(build)):
        # 有活时连续领取，没活时按间隔再看：两种情况都要继续轮询。
        assert executor.reached.wait(5)
    assert built == [1] and executor.calls >= 4 and executor.stopped == 1
    settled = executor.calls
    time.sleep(0.05)
    assert executor.calls == settled  # 服务停止后不再领取


def test_poller_survives_failures_and_logs_only_the_error_type(caplog):
    executor = _Executor(fail_first=True)
    attempts: list[int] = []

    def build():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("storage directory /secret/path is not writable")
        return executor

    with caplog.at_level(logging.WARNING), TestClient(_app(build)):
        assert executor.reached.wait(5)
    assert len(attempts) == 2 and executor.stopped == 1
    messages = [record.getMessage() for record in caplog.records if "solution generation poll failed" in record.getMessage()]
    assert len(messages) == 2 and all("error_type=RuntimeError" in message for message in messages)
    assert "/secret/path" not in caplog.text and "质量手册" not in caplog.text


def test_poller_that_never_gets_an_executor_still_stops_cleanly():
    attempts: list[int] = []
    tried = threading.Event()

    def build():
        attempts.append(1)
        if len(attempts) >= 2:
            tried.set()
        raise RuntimeError("database unavailable")

    with TestClient(_app(build)):
        assert tried.wait(5)


@pytest.mark.parametrize(("requested", "expected"), [(0, 1), (3, 3), (9, 4)])
def test_poller_concurrency_is_clamped(requested, expected):
    entered = threading.Semaphore(0)
    release = threading.Event()
    active: list[int] = []
    lock = threading.Lock()

    class Blocking:
        def run_once(self) -> bool:
            with lock:
                active.append(1)
            entered.release()
            release.wait(5)
            return False

        def shutdown(self) -> None:
            release.set()

    try:
        with TestClient(_app(Blocking, concurrency=requested)):
            for _ in range(expected):
                assert entered.acquire(timeout=5)
            # 多出来的轮询协程（如果有）此时早该进入 run_once 了。
            assert not entered.acquire(timeout=0.2)
            assert len(active) == expected
    finally:
        release.set()


# ---- 任务执行器：失败路径 ----

def _queued(env: Env) -> str:
    draft_id = env.draft()
    env.service.add_source(draft_id, "op1", "质量手册.md", MANUAL)
    env.service.request_generation(draft_id, "op1", "k1")
    return draft_id


def _failed_with(env: Env, draft_id: str) -> str | None:
    detail = env.service.get_draft(draft_id)
    assert detail.latest_job is not None and detail.latest_job.status == "failed"
    assert (detail.status, detail.package) == ("draft", None)
    return detail.latest_job.error_code


def test_an_unexpected_crash_fails_the_job_without_logging_its_message(env, caplog):
    draft_id = _queued(env)

    def crash(*_args, **_kwargs):
        raise RuntimeError("质量手册第一章：来料检验流程")

    env.runner.generate = crash
    with caplog.at_level(logging.INFO):
        assert env.executor.run_once() is True
    assert _failed_with(env, draft_id) == "internal_error"
    assert "error_type=RuntimeError" in caplog.text and "来料检验流程" not in caplog.text
    job = env.service.get_draft(draft_id).latest_job
    assert job is not None and "来料检验流程" not in (job.error_message or "")


def test_a_model_that_became_unavailable_fails_the_job(env):
    draft_id = _queued(env)

    def unavailable(_ref):
        raise ServiceUnavailable("solution generation is not configured on this Operator")

    env.models.resolve = unavailable
    assert env.executor.run_once() is True
    assert _failed_with(env, draft_id) == "model_unavailable"
    assert env.runner.chunks == []


def test_a_source_that_no_longer_parses_fails_the_job(env):
    draft_id = _queued(env)
    strict = GenerationJobExecutor(
        env.repo, env.store, env.models, env.runner, owner="w1", clock=env.clock, parse_limits=ParseLimits(max_file_bytes=8),
    )
    assert strict.run_once() is True
    assert _failed_with(env, draft_id) == "source_parse_failed"
    assert env.runner.chunks == []


def test_a_heartbeat_error_does_not_abandon_the_job(env, caplog):
    draft_id = _queued(env)
    real = env.repo.heartbeat_job
    failures: list[int] = []

    def flaky(*args, **kwargs):
        if not failures:
            failures.append(1)
            raise ConnectionError("db connection reset")
        return real(*args, **kwargs)

    env.repo.heartbeat_job = flaky
    with caplog.at_level(logging.WARNING):
        assert env.executor.run_once() is True
    # 一次心跳失败只是数据库抖动：任务照常完成并落库。
    assert failures == [1] and env.service.get_draft(draft_id).status == "ready_for_review"
    assert "lease heartbeat failed" in caplog.text and "error_type=ConnectionError" in caplog.text
