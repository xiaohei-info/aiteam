"""M4 沙箱脱敏辅助单测（D18：明文凭据绝不进日志/DB/前端）。"""

from __future__ import annotations

from agent_gateway.sandbox import redact_env


def test_redact_env_masks_sensitive_keys() -> None:
    env = {
        "PATH": "/usr/bin",
        "OPENAI_API_KEY": "sk-plaintext-secret",
        "ANTHROPIC_API_KEY": "sk-ant-secret",
        "AI_RELAY_TOKEN": "relay-secret",
        "HOME": "/root",
    }
    out = redact_env(env)
    assert out["PATH"] == "/usr/bin"
    assert out["HOME"] == "/root"
    assert out["OPENAI_API_KEY"] == "[REDACTED]"
    assert out["ANTHROPIC_API_KEY"] == "[REDACTED]"
    assert out["AI_RELAY_TOKEN"] == "[REDACTED]"
    # 原 dict 不被修改
    assert env["OPENAI_API_KEY"] == "sk-plaintext-secret"


def test_redact_env_empty() -> None:
    assert redact_env({}) == {}
