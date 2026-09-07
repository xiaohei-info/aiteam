from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


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


def test_taiyi_deploy_refreshes_run_sh_from_origin_before_exec():
    workflow = (ROOT / ".github/workflows/deploy-main.yml").read_text(encoding="utf-8")
    fetch = workflow.index('git fetch origin "${DEPLOY_BRANCH}"')
    refresh = workflow.index('git checkout "origin/${DEPLOY_BRANCH}" -- deploy/ci/run.sh')
    invoke = workflow.index('bash "${{ env.DEPLOY_ROOT }}/deploy/ci/run.sh"')
    assert fetch < refresh < invoke
    assert "actions/checkout@v4" not in workflow


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
