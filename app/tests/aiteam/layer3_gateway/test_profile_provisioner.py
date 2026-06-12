"""Tests for profile_provisioner and credential_resolver (L3-S01 T01-T05)."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from agent_gateway.profile_provisioner import ensure_profile, profile_exists, resolve_profile_path
from agent_gateway.credential_resolver import resolve_credentials


# ── T01: Idempotency for existing profile ──────────────────────────────

def test_provision_idempotent_for_existing_profile(tmp_path, monkeypatch):
    # Arrange: mock subprocess.run so we can detect if it gets called
    mock_run = MagicMock()
    monkeypatch.setattr("agent_gateway.profile_provisioner.subprocess.run", mock_run)

    profile_dir = tmp_path / "profiles" / "test-profile"
    profile_dir.mkdir(parents=True)
    (profile_dir / "config.yaml").write_text("dummy")

    # Act
    result = ensure_profile("test-profile", tmp_path)

    # Assert
    assert result is False
    mock_run.assert_not_called()


# ── T02: Provision creates new profile ─────────────────────────────────

def test_provision_creates_new_profile(tmp_path, monkeypatch):
    mock_run = MagicMock(return_value=MagicMock(returncode=0))
    monkeypatch.setattr("agent_gateway.profile_provisioner.subprocess.run", mock_run)

    result = ensure_profile("new-profile", tmp_path)

    assert result is True
    # `hermes profile create` does NOT accept a --home flag (argparse rejects it);
    # HERMES_HOME is passed via the subprocess environment instead.
    mock_run.assert_called_once()
    call_args, call_kwargs = mock_run.call_args
    cmd = call_args[0]
    assert cmd[-3:] == ["profile", "create", "new-profile"]
    assert "--home" not in cmd
    assert call_kwargs["capture_output"] is True
    assert call_kwargs["text"] is True
    assert call_kwargs["env"]["HERMES_HOME"] == str(tmp_path)


# ── T03: CLI failure raises RuntimeError ───────────────────────────────

def test_provision_raises_on_cli_failure(tmp_path, monkeypatch):
    mock_run = MagicMock(return_value=MagicMock(returncode=1, stderr="some error"))
    monkeypatch.setattr("agent_gateway.profile_provisioner.subprocess.run", mock_run)

    with pytest.raises(RuntimeError, match="Profile create failed"):
        ensure_profile("bad-profile", tmp_path)


# ── T04: Credential resolver finds connector ───────────────────────────

def test_resolve_credentials_finds_connector():
    caps = {"connectors": [{"type": "openai", "credentials": {"api_key": "sk-123"}}]}
    result = resolve_credentials("emp_001", "openai", caps)
    assert result == {"api_key": "sk-123"}


# ── T05: Credential resolver raises on missing connector type ──────────

def test_resolve_credentials_raises_when_connector_type_missing():
    caps = {"connectors": [{"type": "openai", "credentials": {"api_key": "sk-123"}}]}
    with pytest.raises(ValueError, match="emp_001.*anthropic"):
        resolve_credentials("emp_001", "anthropic", caps)


# ── Auxiliary unit tests: resolve_profile_path / profile_exists ─────────

def test_resolve_profile_path():
    path = resolve_profile_path("/home/user/.hermes", "my-profile")
    assert path == Path("/home/user/.hermes/profiles/my-profile")


def test_profile_exists(tmp_path):
    assert not profile_exists(tmp_path, "missing")
    (tmp_path / "profiles" / "exists").mkdir(parents=True)
    assert profile_exists(tmp_path, "exists")
