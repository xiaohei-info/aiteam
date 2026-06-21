"""ProvisioningService 单元测试（05 F01/F02，03 §9.2）。

对端 Manager 用 fake 网关；断言流程、Operator 不持明文密码、Idempotency-Key 透传。
"""

import hashlib

import pytest

from operation_service.manager_gateway import ManagerGateway
from operation_service.repository import EnterpriseRepository
from operation_service.schemas import ProvisionEnterpriseRequest
from operation_service.service import ProvisioningService
from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest
from shared.errors import Conflict, NotFound


class FakeManagerGateway(ManagerGateway):
    """记录调用与幂等键的内存 fake，不发真实网络。"""

    def __init__(self) -> None:
        self.provisioned: list[tuple[TenantProvisionRequest, str]] = []
        self.bootstraps: list[tuple[OwnerBootstrapSync, str]] = []

    def provision_tenant(self, req, *, idempotency_key):
        self.provisioned.append((req, idempotency_key))

    def sync_owner_bootstrap(self, req, *, idempotency_key):
        self.bootstraps.append((req, idempotency_key))


@pytest.fixture
def manager():
    return FakeManagerGateway()


@pytest.fixture
def service(manager):
    return ProvisioningService(EnterpriseRepository(), manager)


def _req():
    return ProvisionEnterpriseRequest(enterprise_name="Acme", owner_phone="13800000000")


def test_provision_calls_manager_then_stores(service, manager):
    result = service.provision_enterprise(_req())

    # F01：调 Manager 建 tenant，参数对齐。
    assert len(manager.provisioned) == 1
    prov_req, prov_key = manager.provisioned[0]
    assert prov_req.tenant_id == result.tenant_id
    assert prov_req.enterprise_id == result.enterprise_id
    assert prov_req.enterprise_name == "Acme"
    assert prov_key == f"provision:{result.enterprise_id}"

    # F02：同步 bootstrap（跨端传明文，首登强制重置）。
    assert len(manager.bootstraps) == 1
    bs_req, bs_key = manager.bootstraps[0]
    assert bs_req.tenant_id == result.tenant_id
    assert bs_req.owner_phone == "13800000000"
    assert bs_req.must_reset is True
    assert bs_key.startswith(f"bootstrap:{result.enterprise_id}")


def test_operator_never_holds_plaintext(service, manager):
    """红线：Operator 只持本端 sha256 校验材料；同步给 Manager 的是明文（TLS 服务间），Manager 单次 scrypt hash 落库。"""
    result = service.provision_enterprise(_req())
    secret = result.owner_bootstrap_secret
    expected_local_hash = hashlib.sha256(secret.encode()).hexdigest()

    bs_req, _ = manager.bootstraps[0]
    # 跨端传明文（Manager 单一 hash 真相源）
    assert bs_req.bootstrap_secret == secret
    # Operator 本端仍存 sha256（不持长期密码）
    account = service._repo.get(result.enterprise_id)
    assert account.owner_bootstrap_hash == expected_local_hash


def test_bootstrap_secret_is_one_time_and_random(service):
    a = service.provision_enterprise(_req()).owner_bootstrap_secret
    b = service.provision_enterprise(_req()).owner_bootstrap_secret
    assert a and b and a != b  # 每次新随机，且非空


def test_reset_resyncs_and_rotates_hash(service, manager):
    created = service.provision_enterprise(_req())
    first_secret = manager.bootstraps[0][0].bootstrap_secret

    reset = service.reset_owner_bootstrap(created.enterprise_id)

    assert reset.tenant_id == created.tenant_id
    assert reset.owner_phone == created.owner_phone
    assert len(manager.bootstraps) == 2  # 重置再同步一次
    new_secret = manager.bootstraps[1][0].bootstrap_secret
    assert new_secret == reset.owner_bootstrap_secret  # 跨端传明文，和返回值一致
    assert new_secret != first_secret  # 凭据轮换
    # 重置幂等键与开通键不同（每次重置是新写）。
    assert manager.bootstraps[1][1] != manager.bootstraps[0][1]


def test_reset_unknown_enterprise_404(service):
    with pytest.raises(NotFound):
        service.reset_owner_bootstrap("does-not-exist")


def test_duplicate_enterprise_code_conflict(manager):
    repo = EnterpriseRepository()
    svc = ProvisioningService(repo, manager)
    req = ProvisionEnterpriseRequest(
        enterprise_name="Acme", owner_phone="13800000000", enterprise_code="acme"
    )
    svc.provision_enterprise(req)
    with pytest.raises(Conflict):
        svc.provision_enterprise(req)
