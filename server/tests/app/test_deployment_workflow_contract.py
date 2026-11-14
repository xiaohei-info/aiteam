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
    assert "_service_identity_production_env_value" in script
    assert "Generic SERVICE_* values remain a dev/test compatibility path" in script
    assert "Production service principals are deployment-specific" in script
    assert "SERVICE_IDENTITY_SINGLE_INSTANCE=true" in script
    assert "must use distinct registered signers" in script
    assert '[[ ${#SERVICE_TOKEN} -ge 32 ]]' not in script
    assert 'export SERVICE_IDENTITY_PRIVATE_KEY=' in script
    assert 'export SERVICE_IDENTITY_TRUST_JSON=' in script
    assert 'set(capabilities) != {"provision-enterprise"}' in script
    assert "Fresh F01 provisioning is the sole pre-binding exception" in script
    validator = script.split("validate_service_identity_production_env()", 1)[1].split(
        "validate_service_identity_two_sided()", 1
    )[0]
    assert 'mode="$(_service_identity_production_env_value' in validator
    assert 'mode="$(_service_identity_env_value' not in validator
    two_sided = script.split("validate_service_identity_two_sided()", 1)[1].split(
        "validate_control_plane_production_env()", 1
    )[0]
    assert 'manager_private="$(_service_identity_production_env_value' in two_sided
    assert "public_key(os.environ[\"MANAGER_PRIVATE_KEY_CHECK\"])" in two_sided


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


def test_taiyi_deploy_overrides_public_relay_url_from_repository_variable():
    workflow = (ROOT / ".github/workflows/deploy-main.yml").read_text(encoding="utf-8")
    write = workflow.index("Write .env.${{ env.DEPLOY_ENV }} from GitHub secret")
    override = workflow.index("Override NEWAPI_PUBLIC_BASE_URL from repository variable")
    persist = workflow.index("Persist taiyi TEST Manager and Operation listener configuration")
    assert write < override < persist
    block = workflow[override:persist]
    assert "NEWAPI_PUBLIC_BASE_URL_OVERRIDE: ${{ vars.NEWAPI_PUBLIC_BASE_URL_TEST }}" in block
    assert "^https://" in block and "/v1$" in block
    assert "grep -v '^NEWAPI_PUBLIC_BASE_URL='" in block
    # Only the URL itself is logged; the env file is never dumped.
    assert "cat \"${env_file}\"" not in block and "cat \"${tmp}\"" not in block


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
    assert 'git checkout -B "$BRANCH" "origin/$BRANCH"' in script.split("activate_release() {", 1)[1].split("\n}\n", 1)[0]
    assert 'source "${ENV_FILE}"' in script.split("load_release_env() {", 1)[1].split("\n}\n", 1)[0]
    assert "apply_manager_migrations" in script.split("apply_control_plane_migrations() {", 1)[1].split("\n}\n", 1)[0]
    checkout = script.index("\nactivate_release\n")
    sync = script.index('sync_venv_for_release "${VENV_PYTHON}"')
    source_env = script.index("\nload_release_env\n")
    migrations = script.index('apply_control_plane_migrations "${DEPLOY_ROOT}/server"')
    restart = script.index('systemctl restart "$UNIT_NAME" 2>&1; then')
    assert checkout < sync < source_env < migrations < restart
    assert 'sync_persistent_venv_requirements "${venv_python}"' in script
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
    sync = script.index('sync_venv_for_release "${VENV_PYTHON}"')
    source_env = script.index("\nload_release_env\n")
    deps_log = script.index("starting PostgreSQL/NewAPI dependencies while applications remain stopped")
    postgres = script.index("start_release_dependency postgres PostgreSQL")
    newapi = script.index("start_release_dependency newapi NewAPI")
    migrations = script.index('apply_control_plane_migrations "${DEPLOY_ROOT}/server"')
    restart = script.index('systemctl restart "$UNIT_NAME" 2>&1; then')
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


def _main_flow(script: str) -> str:
    return script.split("# --- end release prepare and cutover ---\n", 1)[1]


def test_taiyi_prepares_independent_node_packages_before_stopping():
    # Agent 与行业文档生成 worker 都是独立包、从源码运行；Operation 缺 worker 的
    # node_modules/tsx 时生成会报 worker_unavailable。联网安装必须发生在停应用之前。
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    assert "NODE_PACKAGES=(server/agent_service server/solution_authoring_worker)" in script
    prepare = script.split("prepare_release() {", 1)[1].split("\n}\n", 1)[0]
    assert '(cd "${STAGE_DIR}/${pkg}" && pnpm install --frozen-lockfile 2>&1)' in prepare
    assert prepare.index('setup_pinned_pnpm "${STAGE_DIR}"') < prepare.index("pnpm install --frozen-lockfile")
    assert "src/http/auth.test.ts src/http/manager-jwks.test.ts" in prepare
    assert '(cd "${STAGE_DIR}/web" && pnpm build 2>&1)' in prepare
    assert "systemctl" not in prepare and "${DEPLOY_ROOT}/web" not in prepare
    for name in ("server/agent_service", "server/solution_authoring_worker", "web"):
        assert (ROOT / name / "pnpm-lock.yaml").is_file()


def test_taiyi_stops_the_application_only_after_the_release_is_prepared():
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    flow = _main_flow(script)
    trap = flow.index("trap on_deploy_exit EXIT")
    prepare = flow.index("\nprepare_release\n")
    stop = flow.index('systemctl stop "$UNIT_NAME"')
    activate = flow.index("\nactivate_release\n")
    data = flow.index('DEPLOY_PHASE="data"')
    migrations = flow.index('apply_control_plane_migrations "${DEPLOY_ROOT}/server"')
    online = flow.index("\nif online_migration_eligible; then\n")
    assert prepare < online < stop
    start = flow.index('DEPLOY_PHASE="start"')
    restart = flow.index('systemctl restart "$UNIT_NAME" 2>&1; then')
    done = flow.index('DEPLOY_PHASE="done"')
    assert trap < prepare < stop < activate < data < migrations < start < restart < done
    # 停机窗口内不再联网拉代码；运行时依赖先离线安装。
    assert "git fetch" not in flow and "git pull" not in flow
    activate_body = script.split("activate_release() {", 1)[1].split("\n}\n", 1)[0]
    assert "git fetch" not in activate_body and "git pull" not in activate_body
    assert "pnpm install --frozen-lockfile --offline" in script
    assert "PIP_NO_INDEX=1" in script and "pip wheel --requirement" in script


def test_taiyi_rollback_is_limited_to_switch_and_start_phases():
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    handler = script.split("on_deploy_exit() {", 1)[1].split("\n}\n", 1)[0]
    data_branch = handler.split("      data)", 1)[1].split(";;", 1)[0]
    assert "rollback_release" not in data_branch
    assert "no automatic rollback" in data_branch
    assert "switch|start)" in handler
    assert "CONTRACT_MIGRATION_MARKER='-- deploy-compat: contract'" in script
    rollback = script.split("rollback_release() {", 1)[1].split("\n}\n", 1)[0]
    assert "--offline" in rollback and "apply_" not in rollback and "pip" not in rollback


# 第 2 层：迁移必须向后兼容（只扩展）。收缩型语句只能出现在带标记的迁移里，
# run.sh 据此把该次发布的迁移留到停机窗口内执行，并禁止自动回滚到旧版本。
_MIGRATION_BASELINE = {"operation_service": 18, "manager_service": 50}
_CONTRACT_SQL = (
    r"\bDROP\s+(TABLE|COLUMN|INDEX|TYPE|SCHEMA|VIEW)\b",
    r"\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b",
    r"\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b",
    r"\bSET\s+NOT\s+NULL\b",
    r"\bTRUNCATE\b",
    # 删除 jsonb 键（`payload = payload - 'key'` / `#- '{path}'`）：旧版本仍读取该键时等同于删列。
    r"=\s*[\w.]+\s*(#-|-)\s*'",
)


def test_new_migrations_are_expand_only_unless_marked_contract():
    import re

    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    marker = "-- deploy-compat: contract"
    assert f"CONTRACT_MIGRATION_MARKER='{marker}'" in script
    offenders = []
    for service, baseline in _MIGRATION_BASELINE.items():
        for path in sorted((ROOT / "server" / service / "migrations").glob("*.sql")):
            if int(path.name.split("_", 1)[0]) <= baseline:
                continue
            text = path.read_text(encoding="utf-8")
            body = "\n".join(line.split("--", 1)[0] for line in text.splitlines())
            if marker not in text and any(re.search(p, body, re.IGNORECASE) for p in _CONTRACT_SQL):
                offenders.append(f"{service}/{path.name}")
    assert not offenders, (
        f"收缩型迁移必须带一行 `{marker}`，并拆成两次发布（先扩展、后收缩），见 deploy/ci/README.md：{offenders}"
    )
