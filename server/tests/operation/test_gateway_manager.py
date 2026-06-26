"""HttpManagerGateway mock 单元测试。

用 mock ServiceClient 覆盖 provision_tenant + sync_owner_bootstrap 调用路径。
"""

from unittest.mock import MagicMock

from operation_service.manager_gateway import HttpManagerGateway
from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest


def _make_gateway():
    client = MagicMock()
    gw = HttpManagerGateway(client)
    return gw, client


def test_provision_tenant_calls_post():
    gw, client = _make_gateway()
    req = TenantProvisionRequest(
        enterprise_id="ent-1",
        tenant_id="ten-1",
        enterprise_name="Test Corp",
    )
    gw.provision_tenant(req, idempotency_key="key-1")
    client.post.assert_called_once()
    args, kwargs = client.post.call_args
    assert args[0] == "/api/manager/tenants"
    assert kwargs["idempotency_key"] == "key-1"
    body = kwargs["json"]
    assert body["enterprise_id"] == "ent-1"
    assert body["tenant_id"] == "ten-1"


def test_sync_owner_bootstrap_calls_post():
    gw, client = _make_gateway()
    req = OwnerBootstrapSync(
        tenant_id="ten-1",
        owner_phone="13800000000",
        bootstrap_secret="secret123",
    )
    gw.sync_owner_bootstrap(req, idempotency_key="key-2")
    client.post.assert_called_once()
    args, kwargs = client.post.call_args
    assert args[0] == "/api/manager/owner-bootstrap"
    assert kwargs["idempotency_key"] == "key-2"
    body = kwargs["json"]
    assert body["tenant_id"] == "ten-1"
    assert body["bootstrap_secret"] == "secret123"
    assert body["must_reset"] is True
