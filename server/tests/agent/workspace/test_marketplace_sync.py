"""人才市场自动同步 + sync 端点测试（AITEAM-275 / GH#331）。

验证：
- WorkspaceService 初始化即自动从 provider 拉取模板（marketplace 永不为空）
- FakeMarketplaceProvider 提供离线兜底
- ManagerMarketplaceProvider 在 token/manager 缺失时降级到 fake
- POST /api/agent/marketplace/sync 端点可手动触发同步
"""

from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from agent_service.workspace.marketplace_provider import (
    FakeMarketplaceProvider,
    ManagerMarketplaceProvider,
    MarketplaceProvider,
)
from agent_service.workspace.service import MarketTemplate, WorkspaceService
from agent_service.workspace.store import (
    InMemoryKnowledgeBaseRepository,
    InMemoryKnowledgeDocumentRepository,
    InMemoryUploadAssetRepository,
    InMemoryWorkbenchStateRepository,
)
from agent_service.grants.store import InMemoryProjectionRepository


def _make_service(*, provider: MarketplaceProvider | None = None):
    return WorkspaceService(
        projections=InMemoryProjectionRepository(),
        workbench_store=InMemoryWorkbenchStateRepository(),
        kb_store=InMemoryKnowledgeBaseRepository(),
        doc_store=InMemoryKnowledgeDocumentRepository(),
        upload_store=InMemoryUploadAssetRepository(),
        upload_dir=None,
        marketplace_provider=provider,
    )


class TestAutoSyncOnInit:
    def test_service_auto_syncs_from_provider_on_init(self):
        """初始化即自动拉取模板，marketplace 不再为空。"""
        svc = _make_service()  # 默认 FakeMarketplaceProvider
        templates = svc.list_marketplace()
        assert len(templates) > 0, "marketplace 初始化后不应为空"

    def test_default_provider_is_fake(self):
        """未注入 provider 时默认使用 FakeMarketPlaceProvider。"""
        svc = _make_service()
        templates = svc.list_marketplace()
        ids = {t.template_id for t in templates}
        assert "tpl-coder" in ids
        assert "tpl-researcher" in ids

    def test_custom_provider_overrides_default(self):
        """注入自定义 provider 时使用自定义模板。"""
        custom = [
            MarketTemplate(template_id="custom-1", display_name="定制专家"),
        ]
        class Stub:
            def list_templates(self):
                return custom
        svc = _make_service(provider=Stub())
        templates = svc.list_marketplace()
        assert len(templates) == 1
        assert templates[0].template_id == "custom-1"


class TestFakeMarketplaceProvider:
    def test_returns_builtin_templates(self):
        provider = FakeMarketplaceProvider()
        templates = provider.list_templates()
        assert len(templates) >= 3
        ids = {t.template_id for t in templates}
        assert "tpl-coder" in ids

    def test_returns_copies_not_originals(self):
        """返回副本，改写不影响内置模板。"""
        provider = FakeMarketplaceProvider()
        t1 = provider.list_templates()
        t1[0].display_name = "被改了"
        t2 = provider.list_templates()
        assert t2[0].display_name != "被改了"


class TestManagerMarketplaceProvider:
    def test_no_client_falls_back_to_fake(self):
        provider = ManagerMarketplaceProvider(service_client=None)
        templates = provider.list_templates()
        assert len(templates) >= 3
        ids = {t.template_id for t in templates}
        assert "tpl-coder" in ids

    def test_no_token_falls_back_to_fake(self):
        client = MagicMock()
        provider = ManagerMarketplaceProvider(service_client=client, token_provider=lambda: None)
        templates = provider.list_templates()
        assert len(templates) >= 3
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

    def test_manager_failure_falls_back_to_fake(self):
        """Manager 调用异常时降级到 fake。"""
        client = MagicMock()
        client.get.side_effect = RuntimeError("connection refused")
        provider = ManagerMarketplaceProvider(
            service_client=client,
            token_provider=lambda: "fake-token",
        )
        templates = provider.list_templates()
        assert len(templates) >= 3

    def test_empty_manager_response_falls_back_to_fake(self):
        """Manager 返回空列表时降级到 fake。"""
        client = MagicMock()
        client.get.return_value = {"data": []}
        provider = ManagerMarketplaceProvider(
            service_client=client,
            token_provider=lambda: "fake-token",
        )
        templates = provider.list_templates()
        assert len(templates) >= 3


class TestSyncEndpoint:
    def test_manual_sync_returns_count(self):
        """sync_marketplace_endpoint 返回同步数量。"""
        svc = _make_service()
        count = svc.sync_marketplace_endpoint()
        assert count > 0

    def test_sync_endpoint_via_http(self):
        """POST /api/agent/marketplace/sync 返回 Envelope[synced]。"""
        from fastapi import FastAPI

        from agent_service.workspace.routes import build_workspace_router

        svc = _make_service()
        app = FastAPI()
        app.include_router(build_workspace_router(svc))
        client = TestClient(app)
        r = client.post("/api/agent/marketplace/sync")
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["synced"] > 0
        assert body["data"]["source"] == "provider"
