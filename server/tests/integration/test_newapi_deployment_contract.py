from pathlib import Path


ROOT = Path(__file__).parents[3]
COMPOSE = (ROOT / "deploy/docker/docker-compose.yml").read_text(encoding="utf-8")


def service_block(name: str, next_name: str) -> str:
    return COMPOSE.split(f"  {name}:\n", 1)[1].split(f"  {next_name}:\n", 1)[0]


def test_internal_newapi_is_pinned_private_and_persistent():
    # Keep the client network first: taiyi's Docker backend attaches the host
    # publish to the primary endpoint while NewAPI also needs its DB/Redis net.
    postgres = service_block("newapi-postgres", "newapi-redis")
    redis = service_block("newapi-redis", "newapi")
    relay = service_block("newapi", "operation")

    assert "profiles: [newapi]" in relay
    assert "networks: [operation-newapi, newapi-internal]" in relay
    assert "${NEWAPI_IMAGE:-calciumion/new-api:v1.0.0-rc.25@sha256:54a0b10924aa75fa5b5947208b820ced66b6ef4b445b35f122b31d80676aba2b}" in relay
    assert "latest" not in relay
    assert '"127.0.0.1:${NEWAPI_PORT:-9300}:3000"' in relay
    assert "newapi-postgres:" in relay and "newapi-redis:" in relay
    assert "ports:" not in postgres
    assert "ports:" not in redis
    assert "networks: [newapi-internal]" in postgres
    assert "networks: [newapi-internal]" in redis
    assert "operation-newapi" in relay
    assert "newapi-internal:\n    internal: true" in COMPOSE
    assert "operation-newapi:\n    internal: true" in COMPOSE
    assert "/var/lib/postgresql/data" in postgres
    assert "- newapi_redisdata:/data" in redis
    assert "- newapi_data:/data" in relay


def test_newapi_admin_secrets_only_enter_operation_process():
    operation = service_block("operation", "manager")
    manager = service_block("manager", "agent")
    agent = COMPOSE.split("  agent:\n", 1)[1].split("\nnetworks:\n", 1)[0]
    assert "NEWAPI_ADMIN_TOKEN:" in operation
    assert "OPERATION_SYSTEM_USERNAME:" in operation
    assert "OPERATION_SYSTEM_PASSWORD:" in operation
    assert "OPERATION_DB_URL: postgresql://app_rw:" in operation
    assert "OPERATION_ADMIN_DB_URL:" in operation
    assert "NEWAPI_ADMIN_TOKEN:" not in manager
    assert "NEWAPI_ADMIN_TOKEN:" not in agent
    assert "MANAGER_CREDENTIAL_KEY:" in manager
    assert "aiteam-compose-guard:" in agent
    assert "postgres:" not in agent
    assert "newapi-internal" not in agent and "operation-newapi" not in agent
    assert "networks: [control-plane]" in agent

    ctl = (ROOT / "scripts/ctl.sh").read_text(encoding="utf-8")
    assert "-u NEWAPI_ADMIN_TOKEN" in ctl
    assert "-u NEWAPI_ADMIN_PASSWORD" in ctl
    assert "-u LIGHTRAG_ADMIN_PASSWORD" in ctl
    assert "-u AUTH_ACCOUNTS" in ctl
    assert "-u TOKEN_SECRET" in ctl
    assert 'NEWAPI_ADMIN_TOKEN="${NEWAPI_ADMIN_TOKEN:-}"' in ctl
    assert "OPERATION_SYSTEM_USERNAME" in ctl
    assert "MANAGER_CREDENTIAL_KEY" in ctl
    assert 'local operation_needs_relay=1' in ctl
    assert '[[ "${SERVER}" == "newapi" ]] && operation_needs_relay=0' in ctl
    assert '-u NEWAPI_URL' in ctl
    assert "chmod 600 \"${ENV_FILE}\"" in ctl
    assert "dc --profile newapi up -d newapi" in ctl
    assert 'elif [[ "${SERVER}" == "agent" ]]; then' in ctl
    assert "dc up -d agent" in ctl
    assert 'elif [[ "${SERVER}" == "operation" ]]; then' in ctl
    assert 'dc --profile newapi up -d newapi' in ctl


def test_release_gate_and_deployer_cover_newapi_backup_and_health():
    gate = (ROOT / "scripts/check-deploy.sh").read_text(encoding="utf-8")
    deploy = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    assert "--profile lightrag --profile newapi config --images" in gate
    assert "scripts/newapi-ops.sh --dry-run backup" in gate
    assert 'scripts/newapi-ops.sh --env-file "${ENV_FILE}" backup' in deploy
    assert "/api/status" in deploy
    for container in ("aiteam-newapi-pg", "aiteam-newapi-redis", "aiteam-newapi"):
        assert container in deploy


def test_console_credentials_bootstrap_is_local_and_reused():
    script = (ROOT / "scripts/bootstrap-console-credentials.sh").read_text(encoding="utf-8")
    ctl = (ROOT / "scripts/ctl.sh").read_text(encoding="utf-8")
    docs = (ROOT / "docs/部署运维/组件管理员凭据初始化.md").read_text(encoding="utf-8")

    assert "umask 077" in script
    assert "first run generates; later runs reuse existing values" in script
    assert "mode-600" in script
    assert "NEWAPI_ADMIN_PASSWORD" in script
    assert "LIGHTRAG_AUTH_ACCOUNTS" in script
    assert "HINDSIGHT_CP_ACCESS_KEY" in script
    assert "AUTH_ACCOUNTS" in script
    assert "TOKEN_SECRET" in script
    assert 'source "${AITEAM_CONSOLE_CREDENTIALS_FILE}"' in ctl
    assert "scripts/bootstrap-console-credentials.sh" in docs
    assert "不要提交 Git" in docs


def test_newapi_examples_never_contain_real_credentials():
    for name in (".env.example", ".env.test.example"):
        text = (ROOT / name).read_text(encoding="utf-8")
        assert "NEWAPI_IMAGE=calciumion/new-api:v1.0.0-rc.25@sha256:54a0b10924aa75fa5b5947208b820ced66b6ef4b445b35f122b31d80676aba2b" in text
        assert "NEWAPI_URL=" in text
        assert "NEWAPI_ADMIN_TOKEN=" in text
        assert "MODEL_PRICING_URL=" in text
        assert "newapi.xiaohei.tech" not in text
