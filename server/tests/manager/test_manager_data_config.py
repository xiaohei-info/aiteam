import os
import shutil
import subprocess
import sys
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
    assert "OPERATION_DB_URL: postgresql://app_rw:" in text
    assert "OPERATION_ADMIN_DB_URL:" in text
    assert "name: ${MANAGER_DATA_VOLUME:-managerdata_${AITEAM_ENV:?AITEAM_ENV must be explicitly set}}" in text
    assert "KNOWLEDGE_DATA_ROOT" not in text

    local_env = (root / ".env.example").read_text(encoding="utf-8")
    assert "AITEAM_MANAGER_DATA_ROOT=/app/data" not in local_env

    ctl = (root / "scripts" / "ctl.sh").read_text(encoding="utf-8")
    assert 'export MANAGER_DATA_VOLUME="${MANAGER_DATA_VOLUME:-managerdata_${ENV_CONFIG}}"' in ctl


def test_ctl_exports_environment_specific_manager_volume(tmp_path):
    root = Path(__file__).parents[3]
    (tmp_path / "scripts").mkdir()
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "python").symlink_to(sys.executable)
    shutil.copy(root / "scripts" / "ctl.sh", tmp_path / "scripts" / "ctl.sh")
    shutil.copy(root / "scripts" / "validate-lightrag-env.sh", tmp_path / "scripts" / "validate-lightrag-env.sh")
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
        env_text = "POSTGRES_USER=app_rw\nPOSTGRES_SUPER_USER=aiteam\nPOSTGRES_PORT=5432\nPOSTGRES_DB=aiteam\n"
        if name == "prod":
            env_text += (
                "POSTGRES_PASSWORD=" + "p" * 32 + "\n"
                + "POSTGRES_SUPER_PASSWORD=" + "q" * 32 + "\n"
                + "APP_RW_PASSWORD=" + "r" * 32 + "\n"
                + "SERVICE_TOKEN=" + "s" * 32 + "\n"
                + "MANAGER_CREDENTIAL_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"
                + "AITEAM_JWT_ISSUER=https://manager.example.test\nAITEAM_JWT_AUDIENCE=aiteam-agent\nEXPOSE_PUBLIC_DOCS=false\n"
            )
        else:
            env_text += "POSTGRES_PASSWORD=test\n"
        (tmp_path / f".env.{name}").write_text(env_text, encoding="utf-8")
        result = subprocess.run(
            [str(tmp_path / "scripts" / "ctl.sh"), "start", "--env", name, "--deploy", "docker", "--server", "manager"],
            cwd=tmp_path, env=env, check=False, capture_output=True, text=True,
        )
        if name == "prod":
            assert result.returncode != 0
            assert "production control-plane Docker Compose is unsupported" in result.stderr
            continue
        assert result.returncode == 0
        assert capture.read_text(encoding="utf-8").strip() == f"aiteam_pg_data_{name}|managerdata_{name}"

    # Stop/status/logs must remain usable even when production Agent launch is
    # intentionally disabled for Docker; validation belongs to start/restart.
    subprocess.run(
        [str(tmp_path / "scripts" / "ctl.sh"), "stop", "--env", "prod", "--deploy", "docker", "--server", "all"],
        cwd=tmp_path, env=env, check=True, capture_output=True, text=True,
    )

    # NewAPI is bootstrapped before Operation credentials/public relay config
    # exist; standalone production start must require only its own material.
    (tmp_path / ".env.prod").write_text(
        (tmp_path / ".env.prod").read_text(encoding="utf-8")
        + "NEWAPI_IMAGE=calciumion/new-api:v1.0.0\n"
        + "NEWAPI_DB_PASSWORD=" + "d" * 32 + "\n"
        + "NEWAPI_REDIS_PASSWORD=" + "r" * 32 + "\n"
        + "NEWAPI_SESSION_SECRET=" + "s" * 32 + "\n"
        + "NEWAPI_CRYPTO_SECRET=" + "c" * 32 + "\n",
        encoding="utf-8",
    )
    subprocess.run(
        [str(tmp_path / "scripts" / "ctl.sh"), "start", "--env", "prod", "--deploy", "docker", "--server", "newapi"],
        cwd=tmp_path, env=env, check=True, capture_output=True, text=True,
    )

    # A standalone bootstrap env need not contain any control-plane PG fields.
    (tmp_path / ".env.prod").write_text(
        "NEWAPI_IMAGE=calciumion/new-api:v1.0.0\n"
        + "NEWAPI_DB_PASSWORD=" + "d" * 32 + "\n"
        + "NEWAPI_REDIS_PASSWORD=" + "r" * 32 + "\n"
        + "NEWAPI_SESSION_SECRET=" + "s" * 32 + "\n"
        + "NEWAPI_CRYPTO_SECRET=" + "c" * 32 + "\n",
        encoding="utf-8",
    )
    subprocess.run(
        [str(tmp_path / "scripts" / "ctl.sh"), "start", "--env", "prod", "--deploy", "docker", "--server", "newapi"],
        cwd=tmp_path, env=env, check=True, capture_output=True, text=True,
    )
    subprocess.run(
        [str(tmp_path / "scripts" / "ctl.sh"), "stop", "--env", "prod", "--deploy", "docker", "--server", "all"],
        cwd=tmp_path, env=env, check=True, capture_output=True, text=True,
    )

    # Remote legacy URL/key mode is valid without a local LightRAG image/DB.
    (tmp_path / ".env.prod").write_text(
        "POSTGRES_USER=app_rw\nPOSTGRES_SUPER_USER=aiteam\nPOSTGRES_PASSWORD=" + "p" * 32 + "\n"
        + "POSTGRES_SUPER_PASSWORD=" + "q" * 32 + "\n"
        + "POSTGRES_PORT=5432\nPOSTGRES_DB=aiteam\n"
        + "APP_RW_PASSWORD=" + "r" * 32 + "\nSERVICE_TOKEN=" + "s" * 32 + "\n"
        + "MANAGER_CREDENTIAL_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n"
        + "AITEAM_JWT_ISSUER=https://manager.example.test\nAITEAM_JWT_AUDIENCE=aiteam-agent\nEXPOSE_PUBLIC_DOCS=false\n"
        + "LIGHTRAG_URL=https://example.com\nLIGHTRAG_API_KEY=probe\n",
        encoding="utf-8",
    )
    result = subprocess.run(
        [str(tmp_path / "scripts" / "ctl.sh"), "start", "--env", "prod", "--deploy", "docker", "--server", "manager"],
        cwd=tmp_path, env=env, check=False, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "production control-plane Docker Compose is unsupported" in result.stderr

    # Agent-only Docker/dev startup has no control-plane PG prerequisite.
    (tmp_path / ".env.dev").write_text("AITEAM_PI_FAKE=true\n", encoding="utf-8")
    subprocess.run(
        [str(tmp_path / "scripts" / "ctl.sh"), "start", "--env", "dev", "--deploy", "docker", "--server", "agent"],
        cwd=tmp_path, env=env, check=True, capture_output=True, text=True,
    )
