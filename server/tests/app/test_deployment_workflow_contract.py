from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_web_playwright_operation_and_job_have_explicit_environment():
    config = (ROOT / "web/playwright.config.ts").read_text(encoding="utf-8")
    workflow = (ROOT / ".github/workflows/web-ci.yml").read_text(encoding="utf-8")
    assert "AITEAM_ENV: \"test\"" in config
    assert "OPERATION_SYSTEM_PASSWORD," in config
    assert "OPERATION_SYSTEM_PASSWORD=${" not in config
    assert "      AITEAM_ENV: test" in workflow


def test_production_run_launcher_requires_loopback_host():
    script = (ROOT / "server/run.py").read_text(encoding="utf-8")
    assert "production control-plane services must bind to loopback" in script


def test_production_control_plane_requires_signed_service_identity_inputs():
    script = (ROOT / "scripts/ctl.sh").read_text(encoding="utf-8")
    assert "validate_service_identity_production_env" in script
    assert 'service auth must set SERVICE_AUTH_MODE=signed' in script
    assert "SERVICE_IDENTITY_TRUST_JSON" in script
    assert "SERVICE_IDENTITY_PEER_AUDIENCE" in script
    assert "validate_service_identity_two_sided" in script
    assert "SERVICE_IDENTITY_SINGLE_INSTANCE=true" in script
    assert '[[ ${#SERVICE_TOKEN} -ge 32 ]]' not in script
    assert 'export SERVICE_IDENTITY_PRIVATE_KEY=' in script
    assert 'export SERVICE_IDENTITY_TRUST_JSON=' in script


def test_production_service_identity_launcher_enforces_rsa_minimum():
    script = (ROOT / "scripts/ctl.sh").read_text(encoding="utf-8")
    assert "private.key_size < 2048" in script
    assert "public.key_size < 2048" in script


def test_compose_production_requires_ctl_guard():
    compose = (ROOT / "deploy/docker/docker-compose.yml").read_text(encoding="utf-8")
    assert "aiteam-compose-guard" in compose
    assert "service_completed_successfully" in compose
    assert "production control-plane Compose is unsupported" in compose
    maintenance = (ROOT / "deploy/docker/docker-compose.maintenance.yml").read_text(encoding="utf-8")
    assert "maintenance-disabled" in maintenance
    ctl = (ROOT / "scripts/ctl.sh").read_text(encoding="utf-8")
    assert 'if [[ "${action}" == "start" || "${action}" == "restart" ]]; then' in ctl
    assert 'start_service_local postgres' in ctl
    assert ctl.count("n.bit_length() < 2048") == 2
    assert "n.bit_length() < 512" not in ctl
    assert "AITEAM_TEST_ENABLE_ONBOARDING_WRITES=\"${AITEAM_TEST_ENABLE_ONBOARDING_WRITES:-true}\"" not in ctl
    deploy = (ROOT / ".github/workflows/deploy-main.yml").read_text(encoding="utf-8")
    assert "AITEAM_TEST_ENABLE_ONBOARDING_WRITES=true" in deploy


def test_deployment_checks_pin_compose_environment():
    workflow = (ROOT / ".github/workflows/deploy-ops.yml").read_text(encoding="utf-8")
    assert "env:\n  AITEAM_ENV: test" in workflow


def test_taiyi_deploy_uses_persistent_root_without_workspace_checkout():
    workflow = (ROOT / ".github/workflows/deploy-main.yml").read_text(encoding="utf-8")
    assert "Validate persistent deployment root" in workflow
    assert 'git config --global --add safe.directory "${DEPLOY_ROOT}"' in workflow
    assert "HOME: /root" in workflow
    assert "latest local backup" in workflow
    assert "actions/checkout@v4" not in workflow
    assert 'bash "${{ env.DEPLOY_ROOT }}/deploy/ci/run.sh"' in workflow
    assert "concurrency:" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "umask 077" in workflow
    assert 'chmod 600 "${env_file}"' in workflow


def test_taiyi_deploy_refreshes_run_sh_from_origin_before_exec():
    workflow = (ROOT / ".github/workflows/deploy-main.yml").read_text(encoding="utf-8")
    fetch = workflow.index('git fetch origin "${DEPLOY_BRANCH}"')
    refresh = workflow.index('git checkout "origin/${DEPLOY_BRANCH}" -- deploy/ci/run.sh')
    invoke = workflow.index('bash "${{ env.DEPLOY_ROOT }}/deploy/ci/run.sh"')
    assert fetch < refresh < invoke
    assert "actions/checkout@v4" not in workflow


def test_deploy_unit_is_rendered_for_the_selected_persistent_root():
    unit = (ROOT / "deploy/ci/aiteam-v1.service").read_text(encoding="utf-8")
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    assert "@DEPLOY_ROOT@" in unit
    assert "@ENV_TARGET@" in unit
    assert 'DEPLOY_ROOT="${DEPLOY_ROOT:-$(pwd)}"' in script
    assert 's|@DEPLOY_ROOT@|' in script


def test_deploy_script_fetches_requested_remote_branch_and_requires_enable():
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    assert 'export HOME="${HOME:-/root}"' in script
    assert "hydrate_existing_newapi_env" in script
    assert 'git checkout -B "$BRANCH" "origin/$BRANCH"' in script
    assert 'systemctl enable "$UNIT_NAME"' in script
    assert "deployment would not survive reboot" in script


def test_deploy_bootstrap_docs_use_tracked_requirements_path():
    docs = (ROOT / "deploy/ci/README.md").read_text(encoding="utf-8")
    assert ".venv/bin/python -m pip install --requirement server/requirements.txt" in docs
    assert "docker compose version" in docs
    assert "--branch main --env test" in docs
    assert "从 origin/<branch> 只刷新 deploy/ci/run.sh" in docs
    assert "无 marker、或 hash 与 checked-out 文件不一致时才 pip install；hash 相同则跳过" in docs
    assert "hash 变化才 pip install" not in docs


def test_deploy_script_syncs_checked_out_requirements_into_persistent_venv():
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    checkout = script.index('git checkout -B "$BRANCH" "origin/$BRANCH"')
    sync = script.index('sync_persistent_venv_requirements "${VENV_PYTHON}"')
    source_env = script.index('source "${ENV_FILE}"')
    migrations = script.index("apply_manager_migrations")
    restart = script.index('systemctl restart "$UNIT_NAME"')
    assert checkout < sync < source_env < migrations < restart
    assert '"${venv_python}" -m pip install --requirement "${req_file}"' in script
    assert "python3 -m pip" not in script
    assert 'command -v python3' not in script.split("sync_persistent_venv_requirements()", 1)[1]
    assert ".aiteam-requirements.sha256" in script
    assert "application writers remain stopped" in script
    assert 'never source TEST secrets into pip' in script
    assert 'if ! env -i \\' in script
    assert 'DB_URL_FOR_MIGRATION="postgresql://app_rw:' in script
    assert 'DB_URL="${DB_URL_FOR_MIGRATION}" ADMIN_DB_URL=' not in script
    assert 'AITEAM_MIGRATION_ENV_FILE=' in script
    assert 'OPERATION_DB_URL_FOR_MIGRATION=' in script
    assert 'OPERATION_ADMIN_DB_URL_FOR_MIGRATION=' in script
    assert 'createdb --if-not-exists' not in script
    assert 'SELECT 1 FROM pg_database' in script
    assert 'for attempt in $(seq 1 30); do' in script
    assert '[[ "${state}" == "healthy" ]] && break' in script
    assert '[[ "${state}" == "healthy" ]] || fail "${container} is not healthy (state=${state:-missing})"' in script
    ctl = (ROOT / "scripts/ctl.sh").read_text(encoding="utf-8")
    assert 'createdb --if-not-exists' not in ctl
    assert 'SELECT 1 FROM pg_database' in ctl


def test_deploy_script_exposes_dependency_start_failure_before_restart():
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    helper = script.split("# --- dependency start diagnostics ---\n", 1)[1].split(
        "# --- end dependency start diagnostics ---\n", 1
    )[0]
    sync = script.index('sync_persistent_venv_requirements "${VENV_PYTHON}"')
    source_env = script.index('source "${ENV_FILE}"')
    deps_log = script.index("starting PostgreSQL/NewAPI dependencies while applications remain stopped")
    postgres = script.index("start_release_dependency postgres PostgreSQL")
    newapi = script.index("start_release_dependency newapi NewAPI")
    migrations = script.index("apply_manager_migrations")
    restart = script.index('systemctl restart "$UNIT_NAME"')
    assert sync < source_env < deps_log < postgres < newapi < migrations < restart
    assert 'scripts/ctl.sh start --env "${ENV_TARGET}" --deploy docker --server postgres >/dev/null 2>&1' not in script
    assert 'scripts/ctl.sh start --env "${ENV_TARGET}" --deploy docker --server newapi >/dev/null 2>&1' not in script
    assert 'start --env "${ENV_TARGET}" --deploy docker --server "${server}"' in helper
    assert "docker compose \"${compose_files[@]}\" --profile newapi ps --all" in helper
    assert "docker compose config" not in helper
    assert "for attempt" not in helper
    assert "up -d" not in helper
    assert "docker start aiteam-pg" in helper
    assert "docker rm" not in helper
    assert "compose down" not in helper
    assert "volume rm" not in helper
    assert '"${server}" == "postgres"' in helper
    assert "postgres_container_name_conflict" in helper
    assert ".HostConfig.PortBindings" in helper
    assert "host binding is not loopback-only" in helper
