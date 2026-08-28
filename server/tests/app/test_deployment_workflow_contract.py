from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_deployment_checks_pin_compose_environment():
    workflow = (ROOT / ".github/workflows/deploy-ops.yml").read_text(encoding="utf-8")
    assert "env:\n  AITEAM_ENV: test" in workflow


def test_taiyi_deploy_uses_persistent_root_without_workspace_checkout():
    workflow = (ROOT / ".github/workflows/deploy-main.yml").read_text(encoding="utf-8")
    assert "Validate persistent deployment root" in workflow
    assert "actions/checkout@v4" not in workflow
    assert 'bash "${{ env.DEPLOY_ROOT }}/deploy/ci/run.sh"' in workflow
    assert "concurrency:" in workflow
    assert "cancel-in-progress: false" in workflow


def test_deploy_script_fetches_requested_remote_branch_and_requires_enable():
    script = (ROOT / "deploy/ci/run.sh").read_text(encoding="utf-8")
    assert 'git checkout -B "$BRANCH" "origin/$BRANCH"' in script
    assert 'systemctl enable "$UNIT_NAME"' in script
    assert "deployment would not survive reboot" in script


def test_deploy_bootstrap_docs_use_tracked_requirements_path():
    docs = (ROOT / "deploy/ci/README.md").read_text(encoding="utf-8")
    assert ".venv/bin/pip install -r server/requirements.txt" in docs
    assert "docker compose version" in docs
    assert "--branch main --env test" in docs
