"""人才市场同步 + 端点测试（AITEAM-275 / GH#331 / AITEAM-672）。

AITEAM-672 后契约变更：
- 不再有 FakeMarketplaceProvider 兜底；默认无 provider 时 WorkspaceService 构造抛 ValueError。
- ManagerMarketplaceProvider 不再假数据兜底：Manager 不可达抛 MarketplaceProviderError；
  无 token 时返回空列表（引导登录）；空 Manager 目录返回空列表（前端展示无数据）。
- GET /marketplace/templates 每次请求前执行一次实时同步。
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from agent_service.workspace.marketplace_provider import (
    ManagerMarketplaceProvider,
    MarketplaceProvider,
    MarketplaceProviderError,
)
from agent_service.workspace.service import MarketTemplate, WorkspaceService
from agent_service.workspace.store import (
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
)
from agent_service.grants.store import InMemoryProjectionRepository


def _stub_provider(templates):
    class Stub:
        def list_templates(self_inner):
            return templates
    return Stub()


def _make_service(*, provider: MarketplaceProvider):
    return WorkspaceService(
        projections=InMemoryProjectionRepository(),
        workbench_store=InMemoryWorkbenchStateRepository(),
        kb_store=InMemoryKnowledgeBaseRepository(),
        doc_store=InMemoryKnowledgeDocumentRepository(),
        upload_store=InMemoryUploadAssetRepository(),
        upload_dir=None,
        marketplace_provider=provider,
    )


class TestWorkspaceServiceRequiresProvider:
    def test_no_provider_raises_value_error(self):
        """未注入 provider 不再回退假数据，应显式报 ValueError。"""
        with pytest.raises(ValueError, match="真实的 MarketplaceProvider"):
            _make_service(provider=None)  # type: ignore[arg-type]

    def test_stub_provider_used_directly(self):
        """注入 stub provider 时使用其提供的真实模板。"""
        custom = [MarketTemplate(template_id="custom-1", display_name="定制专家")]
        svc = _make_service(provider=_stub_provider(custom))
        templates = svc.list_marketplace()
        assert len(templates) == 1
        assert templates[0].template_id == "custom-1"


class TestManagerMarketplaceProvider:
    def test_no_client_raises(self):
        """service_client=None 时抛 MarketplaceProviderError。"""
        provider = ManagerMarketplaceProvider(service_client=None)
        with pytest.raises(MarketplaceProviderError):
            provider.list_templates()

    def test_no_token_returns_empty(self):
        """无 token 时返回空列表（未登录状态），不抛错。"""
        client = MagicMock()
        provider = ManagerMarketplaceProvider(service_client=client, token_provider=lambda: None)
        templates = provider.list_templates()
        assert templates == []
        client.get.assert_not_called()

    def test_maps_manager_response_to_templates(self):
        """Manager 目录响应正确映射到 MarketTemplate。"""
        client = MagicMock()
        client.get.return_value = {
            "data": [
                {
                    "template_id": "mgr-1",
                    "display_name": "Manager Expert",
                    "category_code": "marketing",
                    "persona": "marketing leader",
                    "default_model_json": {"provider": "openai", "model": "gpt-5"},
                    "default_binding_json": {"skills": ["web_search"], "knowledge_bases": ["kb_general"]},
                    "tags": ["ai"],
                    "role_name": "CMO",
                }
            ]
        }
        provider = ManagerMarketplaceProvider(
            service_client=client,
            token_provider=lambda: "fake-token",
        )
        templates = provider.list_templates()
        assert len(templates) == 1
        t = templates[0]
        assert t.template_id == "mgr-1"
        assert t.display_name == "Manager Expert"
        assert t.category == "marketing"
        assert t.model_name == "openai::gpt-5"
        assert "web_search" in [s.get("code") for s in t.skills]
        assert "CMO" in t.tags

    def test_manager_failure_propagates(self):
        """Manager 调用异常时不再静默降级假数据，而是抛 MarketplaceProviderError。"""
        client = MagicMock()
        client.get.side_effect = RuntimeError("connection refused")
        provider = ManagerMarketplaceProvider(
            service_client=client,
            token_provider=lambda: "fake-token",
        )
        with pytest.raises(MarketplaceProviderError, match="connection refused"):
            provider.list_templates()

    def test_empty_manager_response_returns_empty(self):
        """Manager 返回空列表时返回空列表（前端展示"暂无可招募专家"）。"""
        client = MagicMock()
        client.get.return_value = {"data": []}
        provider = ManagerMarketplaceProvider(
            service_client=client,
            token_provider=lambda: "fake-token",
        )
        templates = provider.list_templates()
        assert templates == []


class TestSyncEndpoint:
    def test_sync_endpoint_via_http(self):
        """POST /api/agent/marketplace/sync 返回 Envelope[synced]。"""
        from fastapi import FastAPI

        from agent_service.workspace.routes import build_workspace_router

        svc = _make_service(provider=_stub_provider([
            MarketTemplate(template_id="t1", display_name="专家A"),
        ]))
        app = FastAPI()
        app.include_router(build_workspace_router(svc))
        client = TestClient(app)
        r = client.post("/api/agent/marketplace/sync")
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["synced"] >= 1
        assert body["data"]["source"] == "provider"

    def test_list_endpoint_syncs_fresh_and_returns_templates(self):
        """GET /marketplace/templates 实时同步并把 Manager 真数据返给前端。"""
        from fastapi import FastAPI

        from agent_service.workspace.routes import build_workspace_router

        svc = _make_service(provider=_stub_provider([
            MarketTemplate(template_id="fresh-1", display_name="最新专家"),
        ]))
        app = FastAPI()
        app.include_router(build_workspace_router(svc))
        client = TestClient(app)
        r = client.get("/api/agent/marketplace/templates")
        assert r.status_code == 200
        body = r.json()
        ids = {t["template_id"] for t in body["data"]}
        assert "fresh-1" in ids

    def test_list_endpoint_propagates_real_error(self):
        """Manager 不可达时 /marketplace/templates 返回真实错误（problem+json, 503），
        而不是静默换成假数据。
        """
        from fastapi import FastAPI

        from agent_service.workspace.routes import build_workspace_router
        from shared.errors import install_exception_handlers

        class Boom:
            def list_templates(self):
                raise MarketplaceProviderError("Manager 不可达：connection refused")

        svc = _make_service(provider=Boom())
        app = FastAPI()
        install_exception_handlers(app)
        app.include_router(build_workspace_router(svc))
        client = TestClient(app, raise_server_exceptions=False)
        r = client.get("/api/agent/marketplace/templates")
        assert r.status_code == 503
        body = r.json()
        assert "Manager 不可达" in body.get("detail", "")
