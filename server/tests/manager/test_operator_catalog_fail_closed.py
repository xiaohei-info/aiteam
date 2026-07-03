"""AITEAM-331 C1: Operator 目录拉取客户端在缺 OPERATOR_URL 时必须 fail-closed。

历史行为：无 OPERATOR_URL → 静默 fallback 到 FakeOperatorCatalogClient，导致 Manager 招募路由
可在未配置环境下成功下单、写 DB，但拉到的模板/方案包是内存预置的假数据，静默数据错。
修复：缺 OPERATOR_URL → RuntimeError（fail-closed / 启动拒绝），明确报错而非返回 fake。
"""

from __future__ import annotations

import pytest

from manager_service.app import _build_operator_catalog
from manager_service.operator_catalog import FakeOperatorCatalogClient, OperatorCatalogClient


def test_build_operator_catalog_fails_when_url_unset(monkeypatch):
    """AITEAM-331 C1：缺 OPERATOR_URL → _build_operator_catalog 必须 RuntimeError。"""
    monkeypatch.delenv("OPERATOR_URL", raising=False)
    with pytest.raises(RuntimeError, match="OPERATOR_URL is not configured"):
        _build_operator_catalog()


def test_build_operator_catalog_returns_real_client_when_url_set(monkeypatch):
    """AITEAM-331 C1：配置了 OPERATOR_URL → 真实 OperatorCatalogClient（不再 fallback fake）。"""
    monkeypatch.setenv("OPERATOR_URL", "http://operator.test.local:8000")
    client = _build_operator_catalog()
    assert isinstance(client, OperatorCatalogClient)
    assert not isinstance(client, FakeOperatorCatalogClient)
    client.close()
