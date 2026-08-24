from pathlib import Path


ROOT = Path(__file__).parents[3]
COMPOSE = (ROOT / "deploy/docker/docker-compose.yml").read_text(encoding="utf-8")


def service_block(name: str, next_name: str) -> str:
    return COMPOSE.split(f"  {name}:\n", 1)[1].split(f"  {next_name}:\n", 1)[0]


def test_internal_newapi_is_pinned_private_and_persistent():
    postgres = service_block("newapi-postgres", "newapi-redis")
    redis = service_block("newapi-redis", "newapi")
    relay = service_block("newapi", "operation")

    assert "profiles: [newapi]" in relay
    assert "${NEWAPI_IMAGE:-calciumion/new-api:v0.13.2}" in relay
    assert "latest" not in relay
    assert '"127.0.0.1:${NEWAPI_PORT:-9300}:3000"' in relay
    assert "newapi-postgres:" in relay and "newapi-redis:" in relay
    assert "ports:" not in postgres
    assert "ports:" not in redis
    assert "networks: [newapi-internal]" in postgres
    assert "networks: [newapi-internal]" in redis
    assert "networks: [default, newapi-internal]" in relay
    assert "newapi-internal:\n    internal: true" in COMPOSE
    assert "/var/lib/postgresql/data" in postgres
    assert "- newapi_redisdata:/data" in redis
    assert "- newapi_data:/data" in relay


def test_newapi_admin_secrets_only_enter_operation_process():
    operation = service_block("operation", "manager")
    manager = service_block("manager", "agent")
    agent = COMPOSE.split("  agent:\n", 1)[1].split("\nvolumes:\n", 1)[0]
    assert "NEWAPI_ADMIN_TOKEN:" in operation
    assert "NEWAPI_ADMIN_TOKEN:" not in manager
    assert "NEWAPI_ADMIN_TOKEN:" not in agent

    ctl = (ROOT / "scripts/ctl.sh").read_text(encoding="utf-8")
    assert "-u NEWAPI_ADMIN_TOKEN" in ctl
    assert 'NEWAPI_ADMIN_TOKEN="${NEWAPI_ADMIN_TOKEN:-}"' in ctl
    assert "chmod 600 \"${ENV_FILE}\"" in ctl
    assert "dc --profile newapi up -d newapi" in ctl


def test_release_gate_and_deployer_cover_newapi_backup_and_health():
    gate = (ROOT / "scripts/check-deploy.sh").read_text(encoding="utf-8")
    deploy = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    assert "--profile lightrag --profile newapi config --images" in gate
    assert "scripts/newapi-ops.sh --dry-run backup" in gate
    assert 'scripts/newapi-ops.sh --env-file "${ENV_FILE}" backup' in deploy
    assert "/api/status" in deploy
    for container in ("aiteam-newapi-pg", "aiteam-newapi-redis", "aiteam-newapi"):
        assert container in deploy


def test_newapi_examples_never_contain_real_credentials():
    for name in (".env.example", ".env.test.example"):
        text = (ROOT / name).read_text(encoding="utf-8")
        assert "NEWAPI_IMAGE=calciumion/new-api:v0.13.2" in text
        assert "NEWAPI_ADMIN_TOKEN=" in text
        assert "newapi.xiaohei.tech" not in text
