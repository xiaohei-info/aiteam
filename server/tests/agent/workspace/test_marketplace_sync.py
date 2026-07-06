"""人才市场同步 + 端点测试（AITEAM-275 / GH#331 / AITEAM-672）。

AITEAM-672 后契约变更：
- 不再有 FakeMarketplaceProvider 兜底；默认无 provider 时 WorkspaceService 构造抛 ValueError。
- ManagerMarketplaceProvider 不再假数据兜底：Manager 不可达抛 MarketplaceProviderError；
  无 token 时返回空列表（引导登录）；空 Manager 目录返回空列表（前端展示无数据）。
- GET /marketplace/templates 每次请求前执行一次实时同步。
- sync_marketplace 改为全量替换，Manager 变空时本地缓存也清空（AITEAM-672 回归）。
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


def _sequence(pages: list[list[MarketTemplate]]):
    """构造按次返回下一页的 provider（每次 list_templates 返回下一页并推进）。

    注意：WorkspaceService.__init__ 会消耗第一次调用（初始化同步），所以第一页
    对应 init 自检，后面几页对应显式调用 list_templates 的返回。
    """
    state = {"pages": list(pages), "i": 0}

    class SeqProvider:
        def list_templates(self) -> list[MarketTemplate]:
            page = state["pages"][min(state["i"], len(state["pages"]) - 1)]
            state["i"] += 1
            return list(page)

    return SeqProvider()


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


class TestSyncIsFullReplacement:
    """AITEAM-672 回归：全量替换同步语义，避免 Manager 目录变空时旧缓存残留。"""

    def test_sync_empty_clears_previous_templates(self):
        """第一次同步非空后，第二次同步空列表，本地缓存应被清空。"""
        _init = MarketTemplate(template_id="init-1", display_name="init")
        _real = MarketTemplate(template_id="real-1", display_name="专家A")
        svc = _make_service(provider=_sequence([
            [_init],
            [_real],
            [],
        ]))
        # init 自检消耗了 init-1
        assert any(t.template_id == "init-1" for t in svc.list_marketplace())
        # 第一次显式同步拉回真实模板
        assert svc.sync_marketplace_endpoint() == 1
        ids = [t.template_id for t in svc.list_marketplace()]
        assert ids == ["real-1"]
        # 第二次 Manager 返回空 -> 缓存应清空
        assert svc.sync_marketplace_endpoint() == 0
        assert svc.list_marketplace() == []

    def test_no_token_clears_stale_cache(self):
        """有 token 时同步真实数据，token 过期/为空后应拉空而非保留旧缓存。"""
        client = MagicMock()
        client.get.return_value = {"data": [
            {"template_id": "real-1", "display_name": "专家A"},
        ]}
        token_state = {"value": "ok"}
        provider = ManagerMarketplaceProvider(
            service_client=client,
            token_provider=lambda: token_state["value"],
        )
        svc = _make_service(provider=provider)
        # init 自检时 token 已有值，拿到真实数据
        assert [t.template_id for t in svc.list_marketplace()] == ["real-1"]

        # token 过期 / 为空：provider 返回空列表，不应再看到旧模板
        token_state["value"] = None
        assert svc.sync_marketplace_endpoint() == 0
        assert svc.list_marketplace() == []

    def test_http_list_endpoint_mirrors_full_replacement(self):
        """GET /marketplace/templates 全量替换：真实 -> 空 -> 真实，每次都反映最新一次 provider 视图。"""
        svc = _make_service(provider=_sequence([
            [MarketTemplate(template_id="init-1", display_name="init")],
            [MarketTemplate(template_id="real-1", display_name="专家A")],
            [],
            [MarketTemplate(template_id="real-2", display_name="专家B")],
        ]))
        from fastapi import FastAPI

        from agent_service.workspace.routes import build_workspace_router
        from shared.errors import install_exception_handlers

        app = FastAPI()
        install_exception_handlers(app)
        app.include_router(build_workspace_router(svc))
        client = TestClient(app)

        r1 = client.get("/api/agent/marketplace/templates")
        assert {t["template_id"] for t in r1.json()["data"]} == {"real-1"}

        r2 = client.get("/api/agent/marketplace/templates")
        assert r2.json()["data"] == []

        r3 = client.get("/api/agent/marketplace/templates")
        assert {t["template_id"] for t in r3.json()["data"]} == {"real-2"}
