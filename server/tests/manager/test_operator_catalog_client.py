"""Manager OperatorCatalogClient 真实客户端测试（#176）。

验证真实 HTTP 客户端正确调用 Operation 端点、处理认证、解析响应、错误处理。
"""

import httpx
import pytest

from manager_service.operator_catalog import OperatorCatalogClient
from shared.contracts.crosstier import ExpertTemplateDetail, SolutionPackage
from shared.errors import NotFound, Unauthorized


@pytest.fixture
def mock_transport():
    """Mock HTTP transport 用于测试客户端逻辑，不发起真实网络请求。"""

    class MockTransport(httpx.BaseTransport):
        def __init__(self):
            self.requests = []
            self.response_map = {}

        def handle_request(self, request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            key = (request.method, str(request.url.path))
            if key in self.response_map:
                status, content = self.response_map[key]
                return httpx.Response(status, json=content, request=request)
            # 默认 404
            return httpx.Response(
                404,
                json={"type": "not_found", "title": "Not Found", "status": 404, "code": "not_found"},
                request=request,
            )

        def seed(self, method: str, path: str, status: int, content: dict):
            """预置响应。"""
            self.response_map[(method, path)] = (status, content)

    return MockTransport()


@pytest.fixture
def client(mock_transport):
    """构造测试客户端，注入 mock transport。"""
    from shared.service_client import ServiceClient

    service_client = ServiceClient(
        "http://operator.test",
        service_identity="manager-test",
        service_token="test-token",
        transport=mock_transport,
    )
    # 直接构造 OperatorCatalogClient 并替换其 _client
    catalog_client = OperatorCatalogClient.__new__(OperatorCatalogClient)
    catalog_client._client = service_client
    return catalog_client, mock_transport


# ---- pull_expert_template ----

def test_pull_expert_template_success(client):
    """拉取专家模板详情成功。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/expert-templates/tpl-cmo",
        200,
        {
            "data": {
                "template_id": "tpl-cmo",
                "version": "1",
                "display_name": "CMO",
                "persona": "marketing leader",
                "recommended_config": {},
                "platform_model_ref": {"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1},
            }
        },
    )

    result = catalog_client.pull_expert_template(template_id="tpl-cmo")
    assert isinstance(result, ExpertTemplateDetail)
    assert result.template_id == "tpl-cmo"
    assert result.version == "1"
    assert result.display_name == "CMO"

    # 验证请求
    assert len(transport.requests) == 1
    req = transport.requests[0]
    assert req.method == "GET"
    assert str(req.url.path) == "/api/operation/catalog/pull/expert-templates/tpl-cmo"
    assert req.headers.get("X-Service-Identity") == "manager-test"
    assert req.headers.get("X-Service-Token") == "test-token"


def test_pull_expert_template_with_version(client):
    """拉取指定版本的专家模板。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/expert-templates/tpl-cmo",
        200,
        {
            "data": {
                "template_id": "tpl-cmo",
                "version": "2",
                "display_name": "CMO v2",
                "persona": "marketing leader",
                "recommended_config": {},
                "platform_model_ref": {"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1},
            }
        },
    )

    result = catalog_client.pull_expert_template(template_id="tpl-cmo", version="2")
    assert result.version == "2"

    # 验证请求带 version 参数
    req = transport.requests[0]
    assert "version=2" in str(req.url)


def test_pull_expert_template_not_found(client):
    """拉取不存在的模板 → NotFound。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/expert-templates/ghost",
        404,
        {"type": "not_found", "title": "Not Found", "status": 404, "code": "not_found"},
    )

    with pytest.raises(NotFound):
        catalog_client.pull_expert_template(template_id="ghost")


def test_pull_expert_template_unauthorized(client):
    """服务间认证失败 → Unauthorized。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/expert-templates/tpl-cmo",
        401,
        {"type": "unauthorized", "title": "Unauthorized", "status": 401, "code": "unauthorized"},
    )

    with pytest.raises(Unauthorized):
        catalog_client.pull_expert_template(template_id="tpl-cmo")


# ---- pull_solution_package ----

def test_pull_solution_package_success(client):
    """拉取方案包成功。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/solution-templates/sol-marketing",
        200,
        {
            "data": {
                "solution_id": "sol-marketing",
                "version": "1",
                "display_name": "Marketing Solution",
                "experts": [
                    {
                        "template_id": "tpl-cmo",
                        "version": "1",
                        "display_name": "CMO",
                        "persona": "marketing leader",
                        "recommended_config": {},
                        "platform_model_ref": {"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1},
                    }
                ]
            }
        },
    )

    result = catalog_client.pull_solution_package(solution_id="sol-marketing")
    assert isinstance(result, SolutionPackage)
    assert result.solution_id == "sol-marketing"
    assert result.version == "1"
    assert len(result.experts) == 1
    assert result.experts[0].template_id == "tpl-cmo"


def test_pull_solution_package_not_found(client):
    """拉取不存在的方案包 → NotFound。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/solution-templates/ghost",
        404,
        {"type": "not_found", "title": "Not Found", "status": 404, "code": "not_found"},
    )

    with pytest.raises(NotFound):
        catalog_client.pull_solution_package(solution_id="ghost")


# ---- list_expert_templates ----

def test_list_expert_templates_success(client):
    """列举专家模板成功。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/expert-templates",
        200,
        {
            "data": [
                {
                    "template_id": "tpl-cmo",
                    "version": "1",
                    "display_name": "CMO",
                    "persona": "marketing leader",
                    "recommended_config": {},
                    "platform_model_ref": {"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1},
                },
                {
                    "template_id": "tpl-cto",
                    "version": "1",
                    "display_name": "CTO",
                    "persona": "tech leader",
                    "recommended_config": {},
                    "platform_model_ref": {"provider_id": "p1", "provider_version": 1, "model_id": "m1", "model_version": 1},
                },
            ]
        },
    )

    result = catalog_client.list_expert_templates()
    assert len(result) == 2
    assert all(isinstance(item, ExpertTemplateDetail) for item in result)
    assert result[0].template_id == "tpl-cmo"
    assert result[1].template_id == "tpl-cto"


def test_list_expert_templates_empty(client):
    """列举专家模板为空。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/expert-templates",
        200,
        {"data": []},
    )

    result = catalog_client.list_expert_templates()
    assert result == []


# ---- list_solution_packages ----

def test_list_solution_packages_success(client):
    """列举方案包成功。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/solution-templates",
        200,
        {
            "data": [
                {
                    "solution_id": "sol-marketing",
                    "version": "1",
                    "display_name": "Marketing Solution",
                    "experts": [],
                }
            ]
        },
    )

    result = catalog_client.list_solution_packages()
    assert len(result) == 1
    assert isinstance(result[0], SolutionPackage)
    assert result[0].solution_id == "sol-marketing"


def test_list_solution_packages_empty(client):
    """列举方案包为空。"""
    catalog_client, transport = client
    transport.seed(
        "GET",
        "/api/operation/catalog/pull/solution-templates",
        200,
        {"data": []},
    )

    result = catalog_client.list_solution_packages()
    assert result == []
