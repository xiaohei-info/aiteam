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
    def set_tenant_status(self, tenant_id, status, *, reason=None, idempotency_key): pass
    def purge_tenant(self, tenant_id, *, idempotency_key): pass
    """记录调用与幂等键的内存 fake，不发真实网络。"""

    def __init__(self) -> None:
        self.provisioned: list[tuple[TenantProvisionRequest, str]] = []
        self.bootstraps: list[tuple[OwnerBootstrapSync, str]] = []
        self.notifications: list[tuple[EnterpriseNotifyRequest, str]] = []

    def provision_tenant(self, req, *, idempotency_key):
        self.provisioned.append((req, idempotency_key))

    def sync_owner_bootstrap(self, req, *, idempotency_key) -> dict | None:
        self.bootstraps.append((req, idempotency_key))
        return None

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

    reset = service.reset_owner_bootstrap(created.enterprise_id, idempotency_key="reset-legacy-test")

    assert reset.tenant_id == created.tenant_id
    assert reset.owner_phone == created.owner_phone
    assert len(manager.bootstraps) == 2  # 重置再同步一次
    new_secret = manager.bootstraps[1][0].bootstrap_secret
    assert new_secret == reset.owner_bootstrap_secret  # 跨端传明文，和返回值一致
    assert new_secret != first_secret  # 凭据轮换
    # 重置幂等键与开通键不同（每次重置是新写）。
    assert manager.bootstraps[1][1] != manager.bootstraps[0][1]


def test_reset_same_key_replays_original_secret_without_second_manager_write(service, manager):
    created = service.provision_enterprise(_req())
    before = len(manager.bootstraps)
    first = service.reset_owner_bootstrap(created.enterprise_id, idempotency_key="reset-replay")
    second = service.reset_owner_bootstrap(created.enterprise_id, idempotency_key="reset-replay")
    assert second == first
    assert len(manager.bootstraps) == before + 1


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


# ---- 重置负责人凭据：审计与回执 24 小时过期 ----

from datetime import UTC, datetime, timedelta  # noqa: E402

from operation_service.admin_repository import AdminRepository  # noqa: E402
from operation_service.onboarding_receipt import BootstrapReceiptExpired, SECRET_RETENTION  # noqa: E402


class _Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 13, 8, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now


class _CountingManager(FakeManagerGateway):
    """像真实 Manager 一样在重置时回传清除数量。"""

    def sync_owner_bootstrap(self, req, *, idempotency_key):
        super().sync_owner_bootstrap(req, idempotency_key=idempotency_key)
        return {"tenant_id": req.tenant_id, "user_id": "owner-1", "cleared": {"sessions": 2, "passkeys": 1, "oauth": 1}}


@pytest.fixture
def clock():
    return _Clock()


@pytest.fixture
def audited(clock):
    repo = InMemoryEnterpriseRepository()
    admin = AdminRepository()
    svc = ProvisioningService(repo, _CountingManager(), admin_repo=admin)
    svc._onboarding_receipts.clock = clock
    return svc, admin


def test_reset_writes_an_audit_event_with_the_actor_and_cleared_counts(audited):
    svc, admin = audited
    created = svc.provision_enterprise(_req())
    svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1", actor_id="op1", actor_name="运营甲")
    events = [e for e in admin.list_enriched_audits(enterprise_id=created.enterprise_id)[0] if e.action == "owner_bootstrap_reset"]
    assert len(events) == 1
    assert (events[0].actor_id, events[0].actor_name) == ("op1", "运营甲")
    assert "sessions=2" in events[0].detail and "passkeys=1" in events[0].detail and "oauth=1" in events[0].detail
    assert created.tenant_id not in events[0].detail


def test_replaying_a_reset_does_not_write_a_second_audit_event(audited):
    svc, admin = audited
    created = svc.provision_enterprise(_req())
    svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1", actor_id="op1")
    svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1", actor_id="op1")
    events = [e for e in admin.list_enriched_audits(enterprise_id=created.enterprise_id)[0] if e.action == "owner_bootstrap_reset"]
    assert len(events) == 1


def test_a_completed_receipt_replays_the_secret_within_24_hours_then_expires(audited, clock):
    svc, _ = audited
    created = svc.provision_enterprise(_req())
    first = svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1", actor_id="op1")
    clock.now += SECRET_RETENTION - timedelta(minutes=1)
    assert svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1").owner_bootstrap_secret == first.owner_bootstrap_secret
    clock.now += timedelta(minutes=2)
    with pytest.raises(BootstrapReceiptExpired) as raised:
        svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1")
    assert (raised.value.status, raised.value.code) == (409, "bootstrap_receipt_expired")
    # 密文已被清掉：再次重放仍是 409，而不是解密失败。
    receipt = svc._onboarding_receipts._rows["reset:" + created.enterprise_id + ":r1"]
    assert receipt.bootstrap_secret_ciphertext is None
    with pytest.raises(BootstrapReceiptExpired):
        svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1")


def test_a_new_idempotency_key_after_expiry_issues_a_fresh_secret(audited, clock):
    svc, _ = audited
    created = svc.provision_enterprise(_req())
    first = svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r1")
    clock.now += SECRET_RETENTION + timedelta(hours=1)
    second = svc.reset_owner_bootstrap(created.enterprise_id, idempotency_key="r2")
    assert second.owner_bootstrap_secret != first.owner_bootstrap_secret


def test_provisioning_replay_also_stops_returning_the_secret_after_24_hours(audited, clock):
    svc, _ = audited
    first = svc.provision_enterprise(_req(), idempotency_key="p1")
    assert svc.provision_enterprise(_req(), idempotency_key="p1").owner_bootstrap_secret == first.owner_bootstrap_secret
    clock.now += SECRET_RETENTION + timedelta(seconds=1)
    with pytest.raises(BootstrapReceiptExpired):
        svc.provision_enterprise(_req(), idempotency_key="p1")


def test_a_prepared_receipt_never_expires_so_a_lost_fanout_can_resume(audited, clock):
    svc, _ = audited
    receipt = svc._onboarding_receipts.reserve(
        idempotency_key="k", request_fingerprint="f", request_body={}, enterprise_id="e", tenant_id="t",
        enterprise_name="A", enterprise_code=None, owner_phone="13800000000", bootstrap_secret="s",
    )
    clock.now += timedelta(days=30)
    assert receipt.state == "prepared" and not receipt.secret_expired(clock.now)
    assert receipt.bootstrap_secret == "s"
