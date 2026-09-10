"""HttpManagerGateway mock 单元测试。

用 mock ServiceClient 覆盖 provision_tenant + sync_owner_bootstrap 调用路径。
"""

from unittest.mock import MagicMock

from operation_service.manager_gateway import HttpManagerGateway
from shared.contracts.crosstier import EnterpriseNotifyRequest, OwnerBootstrapSync, TenantProvisionRequest


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
    assert kwargs["service_purpose"] == "enterprise:provision"
    assert kwargs["service_capability"] == "provision-enterprise"
    assert kwargs["service_enterprise_id"] == "ent-1"
    assert kwargs["service_tenant_id"] == "ten-1"


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
    assert kwargs["service_purpose"] == "owner:bootstrap"
    assert kwargs["service_tenant_id"] == "ten-1"


def test_notify_enterprise_scopes_service_assertion_to_target():
    gw, client = _make_gateway()
    req = EnterpriseNotifyRequest(
        tenant_id="ten-1",
        org_id="ent-1",
        message="maintenance",
    )
    gw.notify_enterprise(req, idempotency_key="key-3")
    args, kwargs = client.post.call_args
    assert args[0] == "/api/manager/enterprise/notify"
    assert kwargs["service_purpose"] == "notification:write"
    assert kwargs["service_enterprise_id"] == "ent-1"
    assert kwargs["service_tenant_id"] == "ten-1"
