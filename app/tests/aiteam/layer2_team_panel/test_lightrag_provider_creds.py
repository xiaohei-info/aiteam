"""Task 1 — lightrag_service 凭据从 provider dict 解析。"""

from __future__ import annotations

from team_panel.integration import lightrag_service as ls


def test_provider_creds_resolved():
    creds = ls._llm_credentials_from_provider({
        "provider_key": "openrouter",
        "base_url": "https://x.ai/api/v1",
        "api_key": "sk-abc",
        "default_model": "openai/gpt-4o-mini",
    })
    assert creds == ("sk-abc", "https://x.ai/api/v1", "openai/gpt-4o-mini")


def test_provider_creds_none_when_no_key():
    assert ls._llm_credentials_from_provider({"base_url": "x", "api_key": ""}) is None
    assert ls._llm_credentials_from_provider(None) is None


def test_provider_creds_defaults():
    creds = ls._llm_credentials_from_provider({"api_key": "k"})
    assert creds[0] == "k"
    assert creds[1].startswith("http")
    assert creds[2]


def test_build_llm_func_accepts_explicit_creds():
    # No credential -> noop func returns "" (vector-only, behavior preserved).
    import asyncio
    fn = ls._build_llm_func(None)
    assert asyncio.get_event_loop().run_until_complete(fn("hi")) == ""
