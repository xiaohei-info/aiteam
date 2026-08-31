from datetime import UTC, datetime

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
