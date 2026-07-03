"""ProvisioningService 单元测试（05 F01/F02，03 §9.2）。

对端 Manager 用 fake 网关；断言流程、Operator 不持明文密码、Idempotency-Key 透传。
"""

import hashlib

import pytest

from operation_service.manager_gateway import ManagerGateway
from operation_service.repository import InMemoryEnterpriseRepository
from operation_service.schemas import ProvisionEnterpriseRequest
from operation_service.service import ProvisioningService
from shared.contracts.crosstier import EnterpriseNotifyRequest, OwnerBootstrapSync, TenantProvisionRequest
from shared.errors import Conflict, NotFound


class FakeManagerGateway(ManagerGateway):
    """记录调用与幂等键的内存 fake，不发真实网络。"""

    def __init__(self) -> None:
        self.provisioned: list[tuple[TenantProvisionRequest, str]] = []
        self.bootstraps: list[tuple[OwnerBootstrapSync, str]] = []
        self.notifications: list[tuple[EnterpriseNotifyRequest, str]] = []

    def provision_tenant(self, req, *, idempotency_key):
        self.provisioned.append((req, idempotency_key))

    def sync_owner_bootstrap(self, req, *, idempotency_key):
        self.bootstraps.append((req, idempotency_key))

    def notify_enterprise(self, req, *, idempotency_key):
        self.notifications.append((req, idempotency_key))


@pytest.fixture
def manager():
    return FakeManagerGateway()


@pytest.fixture
def service(manager):
    return ProvisioningService(InMemoryEnterpriseRepository(), manager)


def _req():
    return ProvisionEnterpriseRequest(enterprise_name="Acme", owner_phone="13800000000")


def test_new_bootstrap_secret_always_satisfies_password_policy():
    """回归：bootstrap 明文必须满足 Manager 密码策略（小写/大写/数字/符号各≥1 + 长度）。

    原 secrets.token_urlsafe 约 37% 概率无符号 → 开通随机 422（"操作失败，请重试"）。
    多轮生成实测其"必合规"，防再退化。用 Manager 的真实策略校验（跨端契约的单一真相源）。
    """
    from manager_service.auth_password_policy import validate_password_complexity
    from operation_service.service import _new_bootstrap_secret

    for _ in range(500):
        validate_password_complexity(_new_bootstrap_secret())  # 不合规则抛 ValidationProblem


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
    repo = InMemoryEnterpriseRepository()
    svc = ProvisioningService(repo, manager)
    req = ProvisionEnterpriseRequest(
        enterprise_name="Acme", owner_phone="13800000000", enterprise_code="acme"
    )
    svc.provision_enterprise(req)
    with pytest.raises(Conflict):
        svc.provision_enterprise(req)


# ---- 回归：开通后 admin 注册（issue AITEAM-292）----

def test_provision_registers_in_admin_repo(manager):
    """开通成功后 AdminRepository 应立即有该企业状态（概览/账号管理可见）。"""
    from operation_service.admin_repository import AdminRepository

    repo = InMemoryEnterpriseRepository()
    admin_repo = AdminRepository()
    svc = ProvisioningService(repo, manager, admin_repo=admin_repo)
    result = svc.provision_enterprise(_req())

    state = admin_repo.get_state(result.enterprise_id)
    assert state.enterprise_name == "Acme"
    assert state.owner_phone == "13800000000"
    assert state.operation_status == "active"


def test_provision_without_admin_repo_still_works(manager):
    """admin_repo 为 None 时（旧调用方）开通仍正常，不报错。"""
    repo = InMemoryEnterpriseRepository()
    svc = ProvisioningService(repo, manager)
    result = svc.provision_enterprise(_req())
    assert result.enterprise_name == "Acme"
