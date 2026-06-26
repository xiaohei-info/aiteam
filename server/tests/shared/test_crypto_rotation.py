"""Tests for shared/crypto/rotation.py (KeyRotationService + CLI commands).

Covers all branches: check_rotation_status, rotate_credentials, plan_rotation,
generate_key_command, status_command, rotate_command, and main() argparse branches.
"""

import json
import sys
import pytest
from cryptography.fernet import Fernet

from shared.crypto.key_manager import KeyManager, KeyRotationError
from shared.crypto.credential_encryptor import CredentialEncryptor
from shared.crypto.rotation import (
    KeyRotationService,
    generate_key_command,
    status_command,
    rotate_command,
    main,
)


# --- Fixtures --------------------------------------------------------------


@pytest.fixture
def two_version_env(monkeypatch):
    """Set up env with two versioned keys; primary = version 2."""
    key1 = KeyManager.generate_key()
    key2 = KeyManager.generate_key()
    monkeypatch.setenv("AITEAM_ENCRYPTION_KEYS", json.dumps({"1": key1, "2": key2}))
    monkeypatch.setenv("AITEAM_ENCRYPTION_KEY_VERSION", "2")
    return {"1": key1, "2": key2}


@pytest.fixture
def key_manager(two_version_env):
    return KeyManager()


@pytest.fixture
def rotation_service(key_manager):
    return KeyRotationService(key_manager)


@pytest.fixture
def encryptor(key_manager):
    return CredentialEncryptor(key_manager)


# --- KeyRotationService ----------------------------------------------------


class TestKeyRotationServiceInit:
    def test_init_creates_encryptor(self, key_manager):
        svc = KeyRotationService(key_manager)
        assert svc._key_manager is key_manager
        assert isinstance(svc._encryptor, CredentialEncryptor)


class TestCheckRotationStatus:
    def test_empty_list(self, rotation_service):
        status = rotation_service.check_rotation_status([])
        assert status["total_credentials"] == 0
        assert status["needs_rotation"] == 0
        assert status["version_distribution"] == {}
        assert status["rotation_candidates"] == []
        assert status["primary_version"] == 2

    def test_all_current_version(self, rotation_service, encryptor):
        values = [encryptor.encrypt(f"key-{i}") for i in range(3)]
        status = rotation_service.check_rotation_status(values)
        assert status["total_credentials"] == 3
        assert status["needs_rotation"] == 0
        assert status["version_distribution"] == {2: 3}
        assert status["rotation_candidates"] == []

    def test_some_need_rotation(self, rotation_service, key_manager, encryptor):
        # Encrypt one with version 1 (old)
        key_manager.promote_version(1)
        old_encryptor = CredentialEncryptor(key_manager)
        old_val = old_encryptor.encrypt("old-secret")

        # Encrypt one with version 2 (current primary)
        key_manager.promote_version(2)
        current_val = encryptor.encrypt("new-secret")

        status = rotation_service.check_rotation_status([old_val, current_val])
        assert status["total_credentials"] == 2
        assert status["needs_rotation"] == 1
        assert status["version_distribution"] == {1: 1, 2: 1}
        assert len(status["rotation_candidates"]) == 1
        candidate = status["rotation_candidates"][0]
        assert candidate["current_version"] == 1
        assert candidate["target_version"] == 2

    def test_invalid_format_skipped(self, rotation_service, encryptor):
        valid = encryptor.encrypt("good")
        invalid = "not-a-valid-format"
        status = rotation_service.check_rotation_status([valid, invalid])
        assert status["total_credentials"] == 2
        # Invalid format is skipped (version=None -> continue), only valid counted
        assert status["version_distribution"] == {2: 1}
        assert status["needs_rotation"] == 0


class TestRotateCredentials:
    def test_all_need_rotation_success(self, rotation_service, key_manager, encryptor):
        # Encrypt with old version
        key_manager.promote_version(1)
        old_enc = CredentialEncryptor(key_manager)
        vals = [old_enc.encrypt(f"secret-{i}") for i in range(3)]

        # Switch to new primary
        key_manager.promote_version(2)
        result = rotation_service.rotate_credentials(vals)
        assert result["rotated"] == 3
        assert result["unchanged"] == 0
        assert result["failed"] == 0
        assert len(result["details"]["success"]) == 3

    def test_some_unchanged(self, rotation_service, key_manager, encryptor):
        # One old version, one current version
        key_manager.promote_version(1)
        old_enc = CredentialEncryptor(key_manager)
        old_val = old_enc.encrypt("old")

        key_manager.promote_version(2)
        current_val = encryptor.encrypt("current")

        result = rotation_service.rotate_credentials([old_val, current_val])
        assert result["rotated"] == 1
        assert result["unchanged"] == 1
        assert result["failed"] == 0

    def test_decrypt_failure(self, rotation_service, key_manager):
        # Create a value that has valid version prefix but corrupted ciphertext
        # version 1 key exists but the ciphertext is garbage -> InvalidToken
        corrupt_val = "v1:gAAAAABhcorrupteddata"
        result = rotation_service.rotate_credentials([corrupt_val])
        assert result["rotated"] == 0
        assert result["failed"] == 1
        assert "error" in result["details"]["failed"][0]


class TestPlanRotation:
    def test_plan_fields(self, rotation_service, key_manager):
        plan = rotation_service.plan_rotation(
            current_primary=1, new_primary=3, grace_period_days=45
        )
        assert plan["current_state"]["primary_version"] == 1
        assert plan["current_state"]["available_versions"] == key_manager.list_versions()
        assert plan["target_state"]["primary_version"] == 3

        timeline = plan["timeline"]
        assert "preparation" in timeline
        assert "cutover" in timeline
        assert "deprecation" in timeline

        steps = plan["steps"]
        assert len(steps) == 5
        phases = [s["phase"] for s in steps]
        assert phases == ["preparation", "cutover", "migration", "grace_period", "cleanup"]
        # Grace period in action text
        grace_step = [s for s in steps if s["phase"] == "grace_period"][0]
        assert "45" in grace_step["action"]
        assert "1" in grace_step["action"]

    def test_plan_default_grace_period(self, rotation_service):
        plan = rotation_service.plan_rotation(1, 2)
        grace_step = [s for s in plan["steps"] if s["phase"] == "grace_period"][0]
        assert "30" in grace_step["action"]


# --- CLI commands ----------------------------------------------------------


class TestGenerateKeyCommand:
    def test_prints_key(self, capsys):
        generate_key_command()
        out = capsys.readouterr().out
        assert "Generated new Fernet encryption key" in out
        assert "export AITEAM_ENCRYPTION_KEY=" in out
        assert "Store this key securely" in out


class TestStatusCommand:
    def test_without_database_url(self, monkeypatch, capsys, two_version_env):
        status_command(database_url=None)
        out = capsys.readouterr().out
        assert "Current primary key version: 2" in out
        assert "No database URL provided" in out

    def test_with_database_url(self, monkeypatch, capsys, two_version_env):
        status_command(database_url="postgresql://localhost/test")
        out = capsys.readouterr().out
        assert "Current primary key version: 2" in out
        assert "Database integration not yet implemented" in out

    def test_key_rotation_error_exits(self, monkeypatch, capsys):
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEY", raising=False)
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEYS", raising=False)
        with pytest.raises(SystemExit) as exc_info:
            status_command(database_url=None)
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert "Error:" in err


class TestRotateCommand:
    def test_dry_run(self, monkeypatch, capsys, two_version_env):
        rotate_command(database_url="postgresql://localhost/test", dry_run=True)
        out = capsys.readouterr().out
        assert "Starting key rotation (dry_run=True)" in out
        assert "Primary key version: 2" in out
        assert "Database integration not yet implemented" in out

    def test_no_database_url_exits(self, monkeypatch, capsys, two_version_env):
        with pytest.raises(SystemExit) as exc_info:
            rotate_command(database_url="", dry_run=False)
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert "Error: --database-url required" in err

    def test_key_rotation_error_exits(self, monkeypatch, capsys):
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEY", raising=False)
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEYS", raising=False)
        with pytest.raises(SystemExit) as exc_info:
            rotate_command(database_url="postgresql://localhost/test", dry_run=False)
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert "Error:" in err


class TestMain:
    def test_generate(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["rotation", "generate"])
        main()
        out = capsys.readouterr().out
        assert "Generated new Fernet encryption key" in out

    def test_status(self, monkeypatch, capsys, two_version_env):
        monkeypatch.setattr(sys, "argv", ["rotation", "status"])
        main()
        out = capsys.readouterr().out
        assert "Current primary key version: 2" in out

    def test_status_with_database_url(self, monkeypatch, capsys, two_version_env):
        monkeypatch.setattr(sys, "argv", ["rotation", "status", "--database-url", "postgresql://x"])
        main()
        out = capsys.readouterr().out
        assert "Database integration not yet implemented" in out

    def test_rotate(self, monkeypatch, capsys, two_version_env):
        monkeypatch.setattr(sys, "argv", ["rotation", "rotate", "--database-url", "postgresql://x"])
        main()
        out = capsys.readouterr().out
        assert "Starting key rotation (dry_run=False)" in out

    def test_rotate_dry_run(self, monkeypatch, capsys, two_version_env):
        monkeypatch.setattr(sys, "argv", ["rotation", "rotate", "--database-url", "postgresql://x", "--dry-run"])
        main()
        out = capsys.readouterr().out
        assert "dry_run=True" in out

    def test_no_command_exits(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["rotation"])
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1
        out = capsys.readouterr().out
        assert "usage:" in out.lower()

    def test_status_error_exits(self, monkeypatch, capsys):
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEY", raising=False)
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEYS", raising=False)
        monkeypatch.setattr(sys, "argv", ["rotation", "status"])
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1

    def test_rotate_error_exits(self, monkeypatch, capsys):
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEY", raising=False)
        monkeypatch.delenv("AITEAM_ENCRYPTION_KEYS", raising=False)
        monkeypatch.setattr(sys, "argv", ["rotation", "rotate", "--database-url", "postgresql://x"])
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 1
