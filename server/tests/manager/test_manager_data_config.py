import os
import shutil
import subprocess
from pathlib import Path

from shared.config import load_settings


def test_manager_data_root_keeps_local_fallback_and_compose_path(monkeypatch):
    monkeypatch.delenv("AITEAM_MANAGER_DATA_ROOT", raising=False)
    settings = load_settings("manager")
    assert settings.manager_data_root == Path.cwd() / ".data" / "manager"

    monkeypatch.setenv("AITEAM_MANAGER_DATA_ROOT", "/app/data")
    assert load_settings("manager").manager_data_root == Path("/app/data")

    root = Path(__file__).parents[3]
    compose = root / "deploy" / "docker" / "docker-compose.yml"
    text = compose.read_text(encoding="utf-8")
    assert "- managerdata:/app/data" in text
    assert "AITEAM_MANAGER_DATA_ROOT: /app/data" in text
    assert "name: ${MANAGER_DATA_VOLUME:-managerdata_${AITEAM_ENV:-dev}}" in text
    assert "KNOWLEDGE_DATA_ROOT" not in text

    local_env = (root / ".env.example").read_text(encoding="utf-8")
    assert "AITEAM_MANAGER_DATA_ROOT=/app/data" not in local_env

    ctl = (root / "scripts" / "ctl.sh").read_text(encoding="utf-8")
    assert 'export MANAGER_DATA_VOLUME="${MANAGER_DATA_VOLUME:-managerdata_${ENV_CONFIG}}"' in ctl


def test_ctl_exports_environment_specific_manager_volume(tmp_path):
    root = Path(__file__).parents[3]
    (tmp_path / "scripts").mkdir()
    shutil.copy(root / "scripts" / "ctl.sh", tmp_path / "scripts" / "ctl.sh")
    (tmp_path / "deploy" / "docker").mkdir(parents=True)
    shutil.copy(root / "deploy" / "docker" / "docker-compose.yml", tmp_path / "deploy" / "docker" / "docker-compose.yml")
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    capture = tmp_path / "volumes.txt"
    (fake_bin / "docker").write_text(
        "#!/bin/sh\n"
        'if [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi\n'
        'printf "%s|%s\\n" "$POSTGRES_VOLUME" "$MANAGER_DATA_VOLUME" > "$CAPTURE"\n',
        encoding="utf-8",
    )
    (fake_bin / "docker").chmod(0o755)
    env = os.environ | {"PATH": f"{fake_bin}:{os.environ['PATH']}", "CAPTURE": str(capture)}
    for name in ("dev", "test", "prod"):
        (tmp_path / f".env.{name}").write_text(
            "POSTGRES_USER=aiteam\nPOSTGRES_PASSWORD=test\nPOSTGRES_PORT=5432\nPOSTGRES_DB=aiteam\nAITEAM_AGENT_SANDBOX_READY=true\nAITEAM_MANAGER_URL=https://manager.example.test\nAITEAM_MANAGER_TENANT_ID=00000000-0000-0000-0000-000000000001\nAITEAM_MANAGER_ENTERPRISE_ID=00000000-0000-0000-0000-000000000002\nAITEAM_AGENT_JWT_ISSUER=https://agent.example.test\nAITEAM_AGENT_JWT_AUDIENCE=aiteam-agent\nAITEAM_PI_FAKE=false\nAITEAM_AGENT_DEV_AUTH=false\nAITEAM_AGENT_JWKS_JSON='{\"keys\":[{\"kty\":\"RSA\",\"kid\":\"test\",\"n\":\"x\",\"e\":\"AQAB\"}]}'\n",
            encoding="utf-8",
        )
        subprocess.run(
            [str(tmp_path / "scripts" / "ctl.sh"), "start", "--env", name, "--deploy", "docker", "--server", "manager"],
            cwd=tmp_path, env=env, check=True, capture_output=True, text=True,
        )
        assert capture.read_text(encoding="utf-8").strip() == f"aiteam_pg_data_{name}|managerdata_{name}"
