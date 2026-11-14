"""目录读取不能每次都去同步 NewAPI / models.dev（验收时单次读 3–18 秒，拖垮 Manager 和用户端对话）。

口径：进程内首次读取同步刷新（保持「启动后首次访问刷新模型」）；之后在刷新间隔内只读库；
过期后读请求立即返回库内数据，由后台线程刷新，同一时刻最多一个刷新。
"""
from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from operation_service.newapi_client import NewApiError
from operation_service.platform_provider_repository import ModelRow, ProviderRow, RateRow
from operation_service.platform_provider_service import PlatformProviderService


NOW = datetime.now(UTC)
PROVIDER = ProviderRow("p1", "newapi", "LLM 网关", "http://relay/v1", "openai-completions", 1, "published", 1, NOW)
MODEL = ModelRow("p1", "minimax-m3", "MiniMax M3", {"thinking_levels": ["off"], "thinking_mode": "none"}, "published", "discovery", 1, NOW)
RATE = RateRow(
    "r1", "p1", "minimax-m3", 1, "known", "token", Decimal("0.3"), Decimal("1.2"), None, None, None,
    "USD", "public_reference", "models.dev/api.json", NOW, None, False,
)


class _Repo:
    def ensure_internal_provider(self, **_): return PROVIDER
    def list_providers(self, **_): return [PROVIDER]
    def get_provider(self, _provider_id): return PROVIDER
    def current_rate(self, *_): return RATE
    def publish_priced_models(self, _provider_id): return []
    def upsert_discovered_models(self, _provider_id, _model_ids): return [MODEL]
    def list_models(self, _provider_id, **_): return [MODEL]


class _NewAPI:
    def __init__(self) -> None:
        self.calls = 0
        self.gate: threading.Event | None = None
        self.fail = False

    def list_channels(self):
        self.calls += 1
        if self.gate is not None:
            assert self.gate.wait(5), "test gate never opened"
        if self.fail:
            raise NewApiError("gateway down")
        return [{"id": 1, "status": 1, "models": "minimax-m3"}]


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _service(newapi: _NewAPI, clock: _Clock) -> PlatformProviderService:
    return PlatformProviderService(
        _Repo(), newapi, None, "http://relay/v1", model_refresh_interval=300, monotonic=clock,
    )


def _join_refresh(service: PlatformProviderService) -> None:
    thread = service._model_refresh_thread
    assert thread is not None, "expected a background refresh"
    thread.join(5)
    assert not thread.is_alive()


def test_first_read_refreshes_then_reads_within_interval_skip_the_gateway() -> None:
    newapi, clock = _NewAPI(), _Clock()
    service = _service(newapi, clock)

    first = service.list_platform_catalog(tenant_id=None)
    assert [item["model"].model_id for item in first["models"]] == ["minimax-m3"]
    assert newapi.calls == 1

    clock.now += 299
    for _ in range(5):
        service.list_platform_catalog(tenant_id=None)
        service.list_providers()
    assert newapi.calls == 1
    assert service._model_refresh_thread is None


def test_stale_read_returns_without_waiting_and_refreshes_once_in_background() -> None:
    newapi, clock = _NewAPI(), _Clock()
    service = _service(newapi, clock)
    service.list_platform_catalog(tenant_id=None)

    clock.now += 301
    newapi.gate = threading.Event()
    # 网关卡住时读请求照样立即返回库内目录，且并发读取只启动一个刷新。
    catalog = service.list_platform_catalog(tenant_id=None)
    service.list_platform_catalog(tenant_id=None)
    assert [item["model"].model_id for item in catalog["models"]] == ["minimax-m3"]
    newapi.gate.set()
    _join_refresh(service)
    assert newapi.calls == 2

    # 刷新完成后重新计时，间隔内不再刷新。
    service.list_platform_catalog(tenant_id=None)
    assert newapi.calls == 2


def test_background_refresh_failure_keeps_serving_and_backs_off(caplog) -> None:
    newapi, clock = _NewAPI(), _Clock()
    service = _service(newapi, clock)
    service.list_platform_catalog(tenant_id=None)

    clock.now += 301
    newapi.fail = True
    with caplog.at_level(logging.WARNING, logger="operation_service.platform_provider_service"):
        service.list_platform_catalog(tenant_id=None)
        _join_refresh(service)
    assert newapi.calls == 2
    assert any("platform model refresh failed" in record.getMessage() for record in caplog.records)

    # 失败也要退避一个间隔，不能让每个读请求都去撞已经挂掉的网关。
    clock.now += 10
    service.list_platform_catalog(tenant_id=None)
    assert newapi.calls == 2


def test_explicit_channel_resync_resets_the_refresh_clock() -> None:
    newapi, clock = _NewAPI(), _Clock()
    service = _service(newapi, clock)
    service.list_platform_catalog(tenant_id=None)

    clock.now += 250
    service._resync_after_channel_change(PROVIDER)
    assert newapi.calls == 2
    clock.now += 100
    service.list_platform_catalog(tenant_id=None)
    assert newapi.calls == 2
    assert service._model_refresh_thread is None


def test_refresh_interval_must_be_positive() -> None:
    with pytest.raises(ValueError, match="model refresh interval"):
        PlatformProviderService(_Repo(), _NewAPI(), None, "http://relay/v1", model_refresh_interval=0)
