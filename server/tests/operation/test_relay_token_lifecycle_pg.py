"""Isolated PostgreSQL coverage for durable Relay lifecycle boundaries."""

from __future__ import annotations

import os
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from operation_service.platform_provider_repository import PlatformProviderRepository
from operation_service.repository import EnterpriseAccount, PgEnterpriseRepository, apply_migrations


ADMIN_DB_URL = os.getenv("OPERATION_ADMIN_DB_URL") or os.getenv("OPER_TEST_ADMIN_DB_URL")
APP_DB_URL = os.getenv("OPERATION_DB_URL") or os.getenv("OPER_TEST_DB_URL")
APP_RW_PASSWORD = os.getenv("OPER_TEST_APP_RW_PASSWORD") or os.getenv("APP_RW_PASSWORD", "test_password")

pytestmark = pytest.mark.integration


@pytest.fixture
def lifecycle_pg():
    if not ADMIN_DB_URL or not APP_DB_URL:
        pytest.skip(
            "Relay lifecycle PostgreSQL integration requires OPERATION_ADMIN_DB_URL/OPERATION_DB_URL "
            "(or OPER_TEST_* aliases)"
        )

    apply_migrations(ADMIN_DB_URL, APP_RW_PASSWORD)
    repo = PlatformProviderRepository(APP_DB_URL)
    code = f"relay-lifecycle-{uuid.uuid4().hex[:12]}"
    provider = repo.ensure_internal_provider(
        provider_code=code,
        display_name="Relay lifecycle test",
        relay_base_url="http://relay.test/v1",
        api_protocol="openai-completions",
        newapi_channel_id=1,
    )
    repo.upsert_discovered_models(provider.provider_id, ["relay-test-model"])
    try:
        yield repo, provider
    finally:
        # This fixture is only used with the isolated Operation database.  The
        # lifecycle receipts are intentionally not DELETE-granted to app_rw,
        # so cleanup uses the administrative DSN and never touches NewAPI.
        import psycopg

        with psycopg.connect(ADMIN_DB_URL, autocommit=True) as conn:
            conn.execute(
                "DELETE FROM platform_provider_relay_token_operation WHERE provider_id=%s::uuid",
                (provider.provider_id,),
            )
            conn.execute(
                "DELETE FROM platform_provider_tenant_access WHERE provider_id=%s::uuid",
                (provider.provider_id,),
            )
            conn.execute(
                "DELETE FROM platform_provider_relay_token WHERE provider_id=%s::uuid",
                (provider.provider_id,),
            )
            conn.execute(
                "DELETE FROM platform_model WHERE provider_id=%s::uuid",
                (provider.provider_id,),
            )
            conn.execute(
                "DELETE FROM platform_provider WHERE provider_id=%s::uuid",
                (provider.provider_id,),
            )


def test_policy_update_waits_for_the_same_tenant_lock(lifecycle_pg):
    """A policy writer cannot pass a resolver's tenant-wide lock."""
    repo, _provider = lifecycle_pg
    enterprise = PgEnterpriseRepository(APP_DB_URL)
    enterprise_id = str(uuid.uuid4())
    tenant_id = str(uuid.uuid4())
    enterprise.create(
        EnterpriseAccount(
            enterprise_id=enterprise_id,
            tenant_id=tenant_id,
            enterprise_name="Relay policy lock test",
            enterprise_code=None,
            owner_phone="13800000000",
            owner_bootstrap_hash="hash",
            allowed_model_refs=None,
        ),
    )

    release = threading.Event()
    held = threading.Event()
    finished = threading.Event()
    errors: list[BaseException] = []
    import psycopg

    def hold_policy_lock() -> None:
        try:
            with repo.relay_policy_lock(tenant_id):
                held.set()
                release.wait(5)
        except BaseException as exc:  # pragma: no cover - assertion below reports it
            errors.append(exc)
            held.set()

    def update_policy() -> None:
        try:
            enterprise.update_allowed_model_refs(
                enterprise_id,
                [{"provider_id": str(_provider.provider_id), "model_id": "relay-test-model"}],
            )
        except BaseException as exc:  # pragma: no cover - assertion below reports it
            errors.append(exc)
        finally:
            finished.set()

    holder = threading.Thread(target=hold_policy_lock, name="relay-policy-lock-holder")
    writer = threading.Thread(target=update_policy, name="relay-policy-writer")
    holder.start()
    writer_started = False
    try:
        assert held.wait(5)
        writer.start()
        writer_started = True

        waiting = False
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not finished.is_set():
            with psycopg.connect(APP_DB_URL, autocommit=True) as conn:
                waiting = bool(conn.execute(
                    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted",
                ).fetchone()[0])
            if waiting:
                break
            time.sleep(0.02)
        assert waiting, "policy writer did not wait on the shared advisory lock"
    finally:
        release.set()
        holder.join(timeout=5)
        if writer_started:
            writer.join(timeout=5)
        with psycopg.connect(ADMIN_DB_URL, autocommit=True) as conn:
            conn.execute(
                "DELETE FROM enterprise_account WHERE enterprise_id=%s::uuid",
                (enterprise_id,),
            )

    assert not holder.is_alive()
    assert not writer.is_alive()
    assert not errors
    assert finished.is_set()


def test_lifecycle_rows_survive_migration_replay_and_app_rw_claim_cas(lifecycle_pg):
    repo, provider = lifecycle_pg
    tenant_id = str(uuid.uuid4())
    expires_at = datetime.now(UTC) + timedelta(days=30)

    access = repo.upsert_access(
        tenant_id=tenant_id,
        provider_id=provider.provider_id,
        encrypted_token=b"encrypted-relay",
        encrypted_management_token=b"encrypted-management",
        allowed_model_ids=["relay-test-model"],
        newapi_username="relay-test-user",
        newapi_user_id=101,
        newapi_token_id=201,
        expires_at=expires_at,
        policy_revision="policy-a",
    )
    assert access.newapi_token_id == 201
    token = repo.record_relay_token(
        tenant_id=tenant_id,
        provider_id=provider.provider_id,
        newapi_user_id=101,
        newapi_token_id=201,
        token_name="relay-v1",
        allowed_model_ids=["relay-test-model"],
        expires_at=expires_at,
        policy_revision="policy-a",
    )
    operation = repo.ensure_relay_token_operation(
        tenant_id=tenant_id,
        provider_id=provider.provider_id,
        newapi_user_id=101,
        newapi_token_id=201,
        token_name="relay-v1",
        operation_type="revoke",
        operation_key=f"test-revoke:{uuid.uuid4()}",
        desired_model_ids=[],
        desired_expires_at=expires_at,
        policy_revision="policy-b",
        expected_access_version=access.version,
        expected_access_token_id=201,
    )

    claimed = repo.claim_relay_token_operation(operation.operation_id, claim_owner="owner-a")
    assert claimed is not None
    assert claimed.claim_owner == "owner-a"
    assert repo.claim_relay_token_operation(operation.operation_id, claim_owner="owner-b") is None
    assert repo.heartbeat_relay_token_operation(
        operation.operation_id, claim_owner="owner-b",
    ) is None
    assert repo.heartbeat_relay_token_operation(
        operation.operation_id, claim_owner="owner-a",
    ) is not None
    repo.mark_relay_token_operation_failed(
        operation.operation_id,
        error="temporary upstream failure",
        next_attempt_at=datetime.now(UTC) - timedelta(seconds=1),
        claim_owner="owner-a",
    )

    # apply_migrations replays every idempotent script; lifecycle identity and
    # failed receipt must remain present and app_rw must own the runtime path.
    apply_migrations(ADMIN_DB_URL, APP_RW_PASSWORD)
    apply_migrations(ADMIN_DB_URL, APP_RW_PASSWORD)
    assert repo.get_relay_token(tenant_id, provider.provider_id, 201).lifecycle_id == token.lifecycle_id
    stored_operation = repo.get_relay_token_operation(operation.operation_key)
    assert stored_operation.last_error == "temporary upstream failure"
    assert stored_operation.expected_access_version == access.version
    assert stored_operation.expected_access_token_id == 201

    import psycopg

    with psycopg.connect(APP_DB_URL, autocommit=True) as conn:
        assert conn.execute("SELECT current_user").fetchone()[0] == "app_rw"

    # Replacement does not overwrite the old token lifecycle row.
    repo.upsert_access(
        tenant_id=tenant_id,
        provider_id=provider.provider_id,
        encrypted_token=b"encrypted-relay-2",
        encrypted_management_token=b"encrypted-management",
        allowed_model_ids=["relay-test-model"],
        newapi_username="relay-test-user",
        newapi_user_id=101,
        newapi_token_id=202,
        expires_at=expires_at,
        policy_revision="policy-b",
        expected_version=access.version,
        expected_token_id=201,
        expected_policy_revision="policy-a",
    )
    assert repo.get_relay_token(tenant_id, provider.provider_id, 201).newapi_token_id == 201
    assert repo.get_access(tenant_id, provider.provider_id).newapi_token_id == 202
    with pytest.raises(RuntimeError, match="relay access upsert returned no row"):
        repo.upsert_access(
            tenant_id=tenant_id, provider_id=provider.provider_id,
            encrypted_token=b"stale", encrypted_management_token=b"encrypted-management",
            allowed_model_ids=["relay-test-model"], newapi_username="relay-test-user",
            newapi_user_id=101, newapi_token_id=203, expires_at=expires_at,
            policy_revision="stale", expected_version=access.version,
            expected_token_id=201, expected_policy_revision="policy-a",
        )

    # A receipt without an observed upstream mutation changes status but does
    # not invent a historical revocation timestamp.
    repo.mark_relay_token_revoked(
        tenant_id=tenant_id,
        provider_id=provider.provider_id,
        newapi_token_id=201,
        observed=False,
    )
    assert repo.get_relay_token(tenant_id, provider.provider_id, 201).revoked_at is None


def test_batch_claims_have_distinct_owners_and_expiry_cas(lifecycle_pg):
    repo, provider = lifecycle_pg
    tenant_id = str(uuid.uuid4())
    expires_at = datetime.now(UTC) + timedelta(days=1)
    operations = [
        repo.ensure_relay_token_operation(
            tenant_id=tenant_id,
            provider_id=provider.provider_id,
            newapi_user_id=101,
            newapi_token_id=300 + index,
            token_name=f"relay-{index}",
            operation_type="revoke",
            operation_key=f"batch-revoke:{uuid.uuid4()}",
            desired_model_ids=[],
            desired_expires_at=expires_at,
            policy_revision="policy",
        )
        for index in (1, 2)
    ]

    claimed = repo.claim_relay_token_operations(
        tenant_id=tenant_id,
        provider_id=provider.provider_id,
        limit=2,
        claim_owner="ignored-shared-owner",
    )
    assert {item.operation_id for item in claimed} == {item.operation_id for item in operations}
    owners = {item.claim_owner for item in claimed}
    assert len(owners) == 2 and None not in owners
    first, second = claimed
    assert repo.heartbeat_relay_token_operation(
        first.operation_id, claim_owner=second.claim_owner,
    ) is None
    assert repo.mark_relay_token_operation_succeeded(
        first.operation_id, claim_owner=second.claim_owner,
    ) is None
    assert repo.mark_relay_token_operation_succeeded(
        first.operation_id, claim_owner=first.claim_owner,
    ) is not None


def test_adoption_cancels_pending_revoke_and_blocks_live_revoke(lifecycle_pg):
    repo, provider = lifecycle_pg
    tenant_id = str(uuid.uuid4())
    expires_at = datetime.now(UTC) + timedelta(days=1)
    access = repo.upsert_access(
        tenant_id=tenant_id, provider_id=provider.provider_id,
        encrypted_token=b"old-relay", encrypted_management_token=b"management",
        allowed_model_ids=["relay-test-model"], newapi_username="relay-user",
        newapi_user_id=101, newapi_token_id=501, expires_at=expires_at,
        policy_revision="policy-a",
    )
    pending = repo.ensure_relay_token_operation(
        tenant_id=tenant_id, provider_id=provider.provider_id,
        newapi_user_id=101, newapi_token_id=502, token_name="replacement",
        operation_type="revoke", operation_key=f"adopt-pending:{uuid.uuid4()}",
        desired_model_ids=[], desired_expires_at=expires_at, policy_revision="policy-a",
    )

    repo.upsert_access_with_relay_token(
        tenant_id=tenant_id, provider_id=provider.provider_id,
        encrypted_token=b"replacement", encrypted_management_token=b"management",
        allowed_model_ids=["relay-test-model"], newapi_username="relay-user",
        newapi_user_id=101, newapi_token_id=502, expires_at=expires_at,
        policy_revision="policy-b", token_name="replacement",
        expected_version=access.version, expected_token_id=501,
        expected_policy_revision="policy-a",
    )
    assert repo.get_access(tenant_id, provider.provider_id).newapi_token_id == 502
    assert repo.get_relay_token_operation(pending.operation_key).status == "succeeded"

    live_tenant = str(uuid.uuid4())
    live_access = repo.upsert_access(
        tenant_id=live_tenant, provider_id=provider.provider_id,
        encrypted_token=b"live-old", encrypted_management_token=b"management",
        allowed_model_ids=["relay-test-model"], newapi_username="live-user",
        newapi_user_id=101, newapi_token_id=601, expires_at=expires_at,
        policy_revision="policy-a",
    )
    live = repo.ensure_relay_token_operation(
        tenant_id=live_tenant, provider_id=provider.provider_id,
        newapi_user_id=101, newapi_token_id=602, token_name="live-replacement",
        operation_type="revoke", operation_key=f"adopt-live:{uuid.uuid4()}",
        desired_model_ids=[], desired_expires_at=expires_at, policy_revision="policy-a",
    )
    claimed = repo.claim_relay_token_operation(live.operation_id, claim_owner="live-owner")
    assert claimed is not None
    with pytest.raises(RuntimeError, match="live safety revoke"):
        repo.upsert_access_with_relay_token(
            tenant_id=live_tenant, provider_id=provider.provider_id,
            encrypted_token=b"live-replacement", encrypted_management_token=b"management",
            allowed_model_ids=["relay-test-model"], newapi_username="live-user",
            newapi_user_id=101, newapi_token_id=602, expires_at=expires_at,
            policy_revision="policy-b", token_name="live-replacement",
            expected_version=live_access.version, expected_token_id=601,
            expected_policy_revision="policy-a",
        )
    assert repo.get_access(live_tenant, provider.provider_id).newapi_token_id == 601


def test_claim_fenced_access_commit_rejects_takeover(lifecycle_pg):
    repo, provider = lifecycle_pg
    tenant_id = str(uuid.uuid4())
    expires_at = datetime.now(UTC) + timedelta(days=1)
    access = repo.upsert_access(
        tenant_id=tenant_id, provider_id=provider.provider_id,
        encrypted_token=b"old-relay", encrypted_management_token=b"management",
        allowed_model_ids=["relay-test-model"], newapi_username="relay-user",
        newapi_user_id=101, newapi_token_id=701, expires_at=expires_at,
        policy_revision="policy-a",
    )
    operation = repo.ensure_relay_token_operation(
        tenant_id=tenant_id, provider_id=provider.provider_id,
        newapi_user_id=101, newapi_token_id=None, token_name="relay-v2",
        operation_type="issue", operation_key=f"claim-fence:{uuid.uuid4()}",
        desired_model_ids=["relay-test-model"], desired_expires_at=expires_at,
        policy_revision="policy-a", expected_access_version=access.version,
        expected_access_token_id=access.newapi_token_id,
    )
    claimed = repo.claim_relay_token_operation(operation.operation_id, claim_owner="owner-a")
    assert claimed is not None

    import psycopg

    # Simulate a worker pause past its lease, then a real second claim.  The
    # stale worker still has owner-a and must fail the commit's PostgreSQL-now
    # owner/lease check even though its access CAS is otherwise current.
    with psycopg.connect(APP_DB_URL, autocommit=True) as conn:
        conn.execute(
            """UPDATE platform_provider_relay_token_operation
                  SET lease_until=now()-interval '1 second'
                WHERE operation_id=%s::uuid""",
            (operation.operation_id,),
        )
    takeover = repo.claim_relay_token_operation(operation.operation_id, claim_owner="owner-b")
    assert takeover is not None and takeover.claim_owner == "owner-b"

    with pytest.raises(RuntimeError, match="claim is stale"):
        repo.upsert_access_with_relay_token(
            tenant_id=tenant_id, provider_id=provider.provider_id,
            encrypted_token=b"stale-relay", encrypted_management_token=b"management",
            allowed_model_ids=["relay-test-model"], newapi_username="relay-user",
            newapi_user_id=101, newapi_token_id=702, expires_at=expires_at,
            policy_revision="policy-a", token_name="relay-v2",
            expected_version=access.version, expected_token_id=access.newapi_token_id,
            expected_policy_revision="policy-a", operation_id=operation.operation_id,
            claim_owner="owner-a",
        )
    assert repo.get_access(tenant_id, provider.provider_id).newapi_token_id == 701


def test_operation_key_rejects_identity_and_observed_id_conflicts_but_allows_same_intent_retry(lifecycle_pg):
    repo, provider = lifecycle_pg
    tenant_id = str(uuid.uuid4())
    operation_key = f"intent-conflict:{uuid.uuid4()}"
    expires_at = datetime.now(UTC) + timedelta(days=1)
    operation = repo.ensure_relay_token_operation(
        tenant_id=tenant_id, provider_id=provider.provider_id,
        newapi_user_id=None, newapi_token_id=None, token_name="relay-v1",
        operation_type="issue", operation_key=operation_key,
        desired_model_ids=["relay-test-model"], desired_expires_at=expires_at,
        policy_revision="policy-a",
    )
    retry = repo.ensure_relay_token_operation(
        tenant_id=tenant_id, provider_id=provider.provider_id,
        newapi_user_id=101, newapi_token_id=701, token_name="relay-v1",
        operation_type="issue", operation_key=operation_key,
        desired_model_ids=["relay-test-model"], desired_expires_at=expires_at + timedelta(hours=1),
        policy_revision="policy-a",
    )
    assert retry.operation_id == operation.operation_id
    assert retry.newapi_user_id == 101
    assert retry.newapi_token_id == 701
    with pytest.raises(RuntimeError, match="conflicts with existing identity"):
        repo.ensure_relay_token_operation(
            tenant_id=tenant_id, provider_id=provider.provider_id,
            newapi_user_id=101, newapi_token_id=701, token_name="relay-v1",
            operation_type="revoke", operation_key=operation_key,
            desired_model_ids=[], desired_expires_at=expires_at,
            policy_revision="policy-a",
        )
    with pytest.raises(RuntimeError, match="conflicts with existing identity"):
        repo.ensure_relay_token_operation(
            tenant_id=str(uuid.uuid4()), provider_id=provider.provider_id,
            newapi_user_id=101, newapi_token_id=701, token_name="relay-v1",
            operation_type="issue", operation_key=operation_key,
            desired_model_ids=["relay-test-model"], desired_expires_at=expires_at,
            policy_revision="policy-a",
        )
    with pytest.raises(RuntimeError, match="conflicts with existing identity"):
        repo.ensure_relay_token_operation(
            tenant_id=tenant_id, provider_id=provider.provider_id,
            newapi_user_id=102, newapi_token_id=701, token_name="relay-v1",
            operation_type="issue", operation_key=operation_key,
            desired_model_ids=["relay-test-model"], desired_expires_at=expires_at,
            policy_revision="policy-a",
        )

    import psycopg

    provider_two = repo.ensure_internal_provider(
        provider_code=f"relay-conflict-{uuid.uuid4().hex[:10]}",
        display_name="Relay conflict provider",
        relay_base_url="http://relay.test/v1",
        api_protocol="openai-completions",
        newapi_channel_id=1,
    )
    try:
        with pytest.raises(RuntimeError, match="conflicts with existing identity"):
            repo.ensure_relay_token_operation(
                tenant_id=tenant_id, provider_id=provider_two.provider_id,
                newapi_user_id=101, newapi_token_id=701, token_name="relay-v1",
                operation_type="issue", operation_key=operation_key,
                desired_model_ids=["relay-test-model"], desired_expires_at=expires_at,
                policy_revision="policy-a",
            )
    finally:
        with psycopg.connect(ADMIN_DB_URL, autocommit=True) as conn:
            conn.execute(
                "DELETE FROM platform_provider WHERE provider_id=%s::uuid",
                (provider_two.provider_id,),
            )


def test_migration_reclaims_running_receipt_without_lease(lifecycle_pg):
    repo, provider = lifecycle_pg
    operation = repo.ensure_relay_token_operation(
        tenant_id=str(uuid.uuid4()),
        provider_id=provider.provider_id,
        newapi_user_id=101,
        newapi_token_id=401,
        token_name="relay-migration",
        operation_type="revoke",
        operation_key=f"migration-reclaim:{uuid.uuid4()}",
        desired_model_ids=[],
        desired_expires_at=datetime.now(UTC) + timedelta(days=1),
        policy_revision="policy",
    )

    import psycopg

    with psycopg.connect(APP_DB_URL, autocommit=True) as conn:
        conn.execute(
            """UPDATE platform_provider_relay_token_operation
                  SET status='running',lease_until=NULL,claim_owner='stale-owner',
                      next_attempt_at=now()+interval '1 day'
                WHERE operation_id=%s::uuid""",
            (operation.operation_id,),
        )
    apply_migrations(ADMIN_DB_URL, APP_RW_PASSWORD)

    recovered = repo.get_relay_token_operation(operation.operation_key)
    assert recovered.status == "failed"
    assert recovered.lease_until is None
    assert recovered.claim_owner is None
    assert recovered.next_attempt_at <= datetime.now(UTC)
    assert "without a lease" in (recovered.last_error or "")
