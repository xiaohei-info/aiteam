"""M4 provider_resolver 单测（04 §6.7，D18）。"""

from __future__ import annotations

import os
from unittest import mock

import pytest

from agent_gateway.provider_resolver import (
    ProviderResolutionError,
    resolve_provider_env,
    is_provider_configured,
)


def _clear_provider_env() -> None:
    for k in (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "AI_RELAY_TOKEN",
        "AI_RELAY_ENDPOINT",
    ):
        os.environ.pop(k, None)


def test_none_provider_ref_returns_empty() -> None:
    _clear_provider_env()
    assert resolve_provider_env(None) == {}


def test_empty_provider_ref_returns_empty() -> None:
    _clear_provider_env()
    assert resolve_provider_env("") == {}


def test_unknown_provider_ref_fails_fast() -> None:
    _clear_provider_env()
    with pytest.raises(ProviderResolutionError) as exc:
        resolve_provider_env("nonexistent-provider")
    # 错误信息里不应包含任何明文凭据（此处无凭据可泄，但断言错误可解析）
    assert "nonexistent-provider" in str(exc.value)


def test_known_provider_missing_env_fails_fast() -> None:
    _clear_provider_env()
    with pytest.raises(ProviderResolutionError) as exc:
        resolve_provider_env("openai")
    assert "OPENAI_API_KEY" in str(exc.value)


def test_known_provider_with_env_resolves() -> None:
    _clear_provider_env()
    with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test-123"}):
        env = resolve_provider_env("openai")
    assert env == {"OPENAI_API_KEY": "sk-test-123"}


def test_known_provider_endpoint_optional() -> None:
    _clear_provider_env()
    with mock.patch.dict(os.environ, {"AI_RELAY_TOKEN": "relay-tok"}):
        env = resolve_provider_env("ai-relay")
    assert env == {"AI_RELAY_TOKEN": "relay-tok"}


def test_known_provider_endpoint_included_when_set() -> None:
    _clear_provider_env()
    with mock.patch.dict(
        os.environ,
        {"AI_RELAY_TOKEN": "relay-tok", "AI_RELAY_ENDPOINT": "https://relay.example"},
    ):
        env = resolve_provider_env("ai-relay")
    assert env == {"AI_RELAY_TOKEN": "relay-tok", "AI_RELAY_ENDPOINT": "https://relay.example"}


def test_google_accepts_either_key() -> None:
    _clear_provider_env()
    with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "gemini-tok"}):
        env = resolve_provider_env("google")
    assert env == {"GEMINI_API_KEY": "gemini-tok"}


def test_error_message_never_contains_secret_value() -> None:
    _clear_provider_env()
    secret = "sk-super-secret-value"
    with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": secret}):
        # 正常路径不抛错，但断言返回值包含 secret（注入用）
        env = resolve_provider_env("anthropic")
    assert env["ANTHROPIC_API_KEY"] == secret

    # 缺失路径抛错，错误信息不含任何 env 值
    _clear_provider_env()
    with pytest.raises(ProviderResolutionError) as exc:
        resolve_provider_env("anthropic")
    assert secret not in str(exc.value)


def test_is_provider_configured_true_and_false() -> None:
    _clear_provider_env()
    assert is_provider_configured(None) is True
    assert is_provider_configured("openai") is False
    with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "sk"}):
        assert is_provider_configured("openai") is True
    assert is_provider_configured("nonexistent") is False
