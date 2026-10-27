"""Real PostgreSQL claim/retry and tenant isolation contract."""
from concurrent.futures import ThreadPoolExecutor
import uuid

import pytest

from manager_service.recruit_order_repository import RecruitOrderRepository
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter
from shared.errors import Conflict

pytestmark = pytest.mark.integration


def test_order_retry_and_concurrent_claim(migrated_db, two_tenants):
    repo = RecruitOrderRepository(PgTenantRouter(migrated_db))
    ctx = TenantContext(tenant_id=two_tenants[0], user_id=str(uuid.uuid4()), roles=["owner"])
    other = TenantContext(tenant_id=two_tenants[1], user_id=str(uuid.uuid4()), roles=["owner"])
    args = dict(idempotency_key="retry:" + uuid.uuid4().hex, action="recruit_expert", template_id="retry-template")

    first = repo.claim_provisioning(ctx, **args)
    repo.update(ctx, first.mark_failed("conflict", "provider unavailable"))

    def claim():
        try:
            return repo.claim_provisioning(ctx, **args)
        except Conflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: claim(), range(2)))
    winners = [row for row in results if row is not None]
    assert len(winners) == 1
    retry = winners[0]
    assert retry.id == first.id and retry.created_at == first.created_at
    assert retry.status == "provisioning"
    assert retry.error_code is None and retry.error_message is None
    assert retry.created_employee_id is None

    # The same key is independent in another tenant; neither can read the other's row.
    independent = repo.claim_provisioning(other, **args)
    assert independent.id != first.id
    assert repo.get(other, order_id=first.id) is None
    assert repo.get(ctx, order_id=independent.id) is None

    repo.update(ctx, retry.mark_succeeded(str(uuid.uuid4())))
    with pytest.raises(Conflict):
        repo.claim_provisioning(ctx, **args)


@pytest.mark.parametrize("status", ["pending", "cancelled"])
def test_order_claim_resumes_unfinished_order(migrated_db, two_tenants, status):
    repo = RecruitOrderRepository(PgTenantRouter(migrated_db))
    ctx = TenantContext(tenant_id=two_tenants[0], user_id=str(uuid.uuid4()), roles=["owner"])
    args = dict(idempotency_key="resume:" + uuid.uuid4().hex, action="recruit_expert", template_id="retry-template")
    old = repo.create(ctx, **args, status=status)
    current = repo.claim_provisioning(ctx, **args)
    assert current.id == old.id and current.status == "provisioning"
