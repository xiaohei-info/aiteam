"""Real PostgreSQL regression for legacy recharge cleanup."""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path

import pytest

from manager_service.billing_repository import BillingRepository
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter, apply_migrations

pytestmark = pytest.mark.integration


def test_legacy_cleanup_migration_is_explicitly_transactional():
    migration_path = Path(__file__).resolve().parents[2] / "manager_service" / "migrations" / "0040_recharge_legacy_method_cleanup.sql"
    migration = migration_path.read_text(encoding="utf-8")
    assert migration.lstrip().startswith("--")
    assert "BEGIN;" in migration
    assert migration.rstrip().endswith("COMMIT;")


def test_legacy_recharge_cleanup_reconciles_visible_balance(two_tenants, admin_url):
    tenant_id = two_tenants[0]
    ctx = TenantContext(tenant_id=tenant_id, user_id="00000000-0000-4000-8000-000000000001", roles=["owner"])
    repo = BillingRepository(PgTenantRouter(os.environ["DB_URL"]))
    repo.upsert_balance(ctx, balance=20, estimated_tokens=20_000)
    repo.create_recharge(
        ctx,
        amount=10,
        payment_method="mock_pay",
        status="pending",
        order_no="legacy-mock",
        token_credited=10_000,
    )

    apply_migrations(admin_url, app_rw_password=os.environ.get("APP_RW_PASSWORD"))

    balance = repo.get_balance(ctx)
    assert balance.balance == 10
    assert balance.estimated_tokens == 10_000
    history = repo.list_recharges(ctx)
    assert history[0].payment_method == "bank_transfer"
    assert history[0].status == "failed"
    assert history[0].token_credited == 0


def test_concurrent_settled_recharges_credit_balance_once(two_tenants):
    tenant_id = two_tenants[0]
    ctx = TenantContext(tenant_id=tenant_id, user_id="00000000-0000-4000-8000-000000000001", roles=["owner"])
    dsn = os.environ["DB_URL"]

    def settle(index: int):
        return BillingRepository(PgTenantRouter(dsn)).create_recharge(
            ctx,
            amount=Decimal("1"),
            payment_method="bank_transfer",
            status="success",
            order_no=f"concurrent-{index}",
            token_credited=1_000,
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(settle, range(4)))

    assert len({record.recharge_id for record in records}) == 4
    repo = BillingRepository(PgTenantRouter(dsn))
    balance = repo.get_balance(ctx)
    assert balance.balance == Decimal("4")
    assert balance.estimated_tokens == 4_000
    settled = [record for record in repo.list_recharges(ctx) if record.order_no.startswith("concurrent-")]
    assert len(settled) == 4
