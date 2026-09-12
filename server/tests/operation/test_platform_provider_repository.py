from datetime import UTC, datetime
from inspect import getsource
from pathlib import Path

from operation_service import platform_provider_repository as repository_module
from operation_service.platform_provider_repository import PlatformProviderRepository


NOW = datetime.now(UTC)
PROVIDER_ROW = {
    "provider_id": "p1",
    "provider_code": "newapi",
    "display_name": "LLM 网关",
    "relay_base_url": "http://relay/v1",
    "api_protocol": "openai-completions",
    "newapi_channel_id": 1,
    "status": "published",
    "version": 1,
    "updated_at": NOW,
}
MODEL_ROW = {
    "provider_id": "p1",
    "model_id": "minimax-m3",
    "display_name": "MiniMax M3",
    "capabilities": {},
    "status": "draft",
    "source": "discovery",
    "version": 1,
    "updated_at": NOW,
}


class _Result:
    def __init__(self, *, one=None, many=None):
        self._one = one
        self._many = many or []

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._many


class _Transaction:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _Connection:
    def __init__(self):
        self.executed: list[tuple[str, tuple | None]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def transaction(self):
        return _Transaction()

    def execute(self, sql, params=None):
        sql = str(sql)
        self.executed.append((sql, params))
        if "capabilities = %s::jsonb" in sql:
            return _Result(one={**MODEL_ROW, "display_name": "MiniMax M3", "capabilities": {"reasoning": True}})
        if "RETURNING provider_id::text" in sql:
            return _Result(one=PROVIDER_ROW)
        if "SELECT provider_id::text,model_id" in sql:
            return _Result(many=[MODEL_ROW])
        return _Result()


def test_update_model_metadata_fills_empty_capabilities(monkeypatch):
    conn = _Connection()
    monkeypatch.setattr(repository_module.psycopg, "connect", lambda *_args, **_kwargs: conn)
    repo = PlatformProviderRepository("postgresql://test")

    result = repo.update_model_metadata(
        "p1", "minimax-m3", display_name="MiniMax M3", capabilities={"reasoning": True},
    )

    assert result is not None
    assert result.capabilities == {"reasoning": True}
    sql, params = next((sql, params) for sql, params in conn.executed if "capabilities = %s::jsonb" in sql)
    assert "COALESCE(capabilities, '{}'::jsonb) = '{}'::jsonb" in sql
    assert params[:2] == ("MiniMax M3", '{"reasoning": true}')
    assert repo.update_model_metadata("p1", "minimax-m3", display_name=None, capabilities={}) is None


def test_relay_lifecycle_migration_is_replay_safe_and_uses_app_rw_grants():
    migration = (Path(__file__).parents[2] / "operation_service/migrations/0015_relay_token_lifecycle.sql").read_text(encoding="utf-8")

    assert "ADD COLUMN IF NOT EXISTS policy_revision" in migration
    assert "ADD COLUMN IF NOT EXISTS encrypted_bootstrap_password" in migration
    assert "CREATE TABLE IF NOT EXISTS platform_provider_relay_token" in migration
    assert "CREATE TABLE IF NOT EXISTS platform_provider_relay_token_operation" in migration
    assert "ON CONFLICT (tenant_id, provider_id, newapi_token_id) DO NOTHING" in migration
    assert "REVOKE DELETE ON platform_provider_relay_token FROM app_rw" in migration
    assert "REVOKE DELETE ON platform_provider_relay_token_operation FROM app_rw" in migration
    assert "GRANT SELECT, INSERT, UPDATE ON platform_provider_relay_token TO app_rw" in migration
    assert "GRANT SELECT, INSERT, UPDATE ON platform_provider_relay_token_operation TO app_rw" in migration
    assert "GRANT SELECT, INSERT, UPDATE, DELETE ON platform_provider_relay_token" not in migration
    assert "GRANT SELECT, INSERT, UPDATE, DELETE ON platform_provider_relay_token_operation" not in migration
    assert "lease_until" in migration and "attempt_count" in migration and "claim_owner" in migration
    assert "bootstrap" in migration
    assert "expected_access_version" in migration and "expected_access_token_id" in migration
    assert "quota_before" in migration and "quota_delta" in migration
    assert "create_attempt_state" in migration and "user_create_state" in migration
    assert "status='running' AND lease_until IS NULL" in migration
    assert "operation_id=%s::uuid{owner_clause}" in getsource(PlatformProviderRepository.mark_relay_token_operation_succeeded)
    for method in (
        PlatformProviderRepository.mark_relay_token_operation_succeeded,
        PlatformProviderRepository.mark_relay_token_operation_failed,
        PlatformProviderRepository.bind_relay_token_operation,
        PlatformProviderRepository.update_relay_token_create_state,
        PlatformProviderRepository.update_relay_user_create_state,
        PlatformProviderRepository.update_relay_bootstrap_progress,
        PlatformProviderRepository.heartbeat_relay_token_operation,
    ):
        assert "lease_until IS NOT NULL AND lease_until > now()" in getsource(method)
    assert "prepare_unidentified_relay_token_revocation" in getsource(PlatformProviderRepository)
    assert "gen_random_uuid()::text" in getsource(PlatformProviderRepository.claim_relay_token_operations)
    assert "DROP CONSTRAINT IF EXISTS platform_provider_relay_token_operation_operation_type_check" in migration
    assert "platform_provider_relay_token_operation_bootstrap_state_check" in migration
    assert "pg_advisory_xact_lock" in getsource(PlatformProviderRepository.relay_access_lock)
    assert "pg_advisory_xact_lock" in getsource(PlatformProviderRepository.relay_policy_lock)
    assert "relay_policy_lock_key" in getsource(PlatformProviderRepository.relay_policy_lock)
    assert "FOR UPDATE SKIP LOCKED" in getsource(PlatformProviderRepository.claim_relay_token_operations)
    # No lifecycle receipt is allowed to persist an opaque token value.
    assert "encrypted_token" not in migration.split("CREATE TABLE IF NOT EXISTS platform_provider_relay_token", 1)[1]


def test_relay_policy_lock_uses_the_shared_tenant_key_and_transaction(monkeypatch):
    from operation_service.repository import relay_policy_lock_key

    conn = _Connection()
    monkeypatch.setattr(repository_module.psycopg, "connect", lambda *_args, **_kwargs: conn)
    repo = PlatformProviderRepository("postgresql://test")

    with repo.relay_policy_lock("tenant-1"):
        pass

    assert conn.executed == [
        (
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (relay_policy_lock_key("tenant-1"),),
        ),
    ]


def test_internal_provider_upsert_reconciles_discovered_models(monkeypatch):
    conn = _Connection()
    monkeypatch.setattr(repository_module.psycopg, "connect", lambda *_args, **_kwargs: conn)
    repo = PlatformProviderRepository("postgresql://test")

    provider = repo.ensure_internal_provider(
        provider_code="newapi",
        display_name="LLM 网关",
        relay_base_url="http://relay/v1",
        api_protocol="openai-completions",
        newapi_channel_id=1,
    )
    models = repo.upsert_discovered_models("p1", ["minimax-m3"])
    repo.publish_priced_models("p1")
    repo.list_models("p1")
    repo.list_models("p1", published_only=True)

    assert provider.status == "published"
    assert models[0].model_id == "minimax-m3"
    ensure_sql = next(sql for sql, _ in conn.executed if "INSERT INTO platform_provider" in sql)
    stale_update = next(sql for sql, _ in conn.executed if "UPDATE platform_model SET" in sql)
    assert "display_name IS DISTINCT FROM" not in ensure_sql
    publish_update = next(sql for sql, _ in conn.executed if "UPDATE platform_model AS m" in sql)
    assert "ANY" in stale_update
    assert "m.status NOT IN ('published','disabled')" in publish_update
    assert ("p1", ["minimax-m3"]) in [params for sql, params in conn.executed if "status='disabled'" in sql]
    model_queries = [sql for sql, _ in conn.executed if "FROM platform_model WHERE provider_id" in sql]
    assert "status <> 'disabled'" in model_queries[-2]
    assert "status='published'" in model_queries[-1]
