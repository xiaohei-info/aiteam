"""operation_service auth_service / system_repository 构建器分支测试。

覆盖 build_operation_auth_service 的 env 固定密钥路径（line 85）和
build_system_account_repository 的 ValueError 分支（lines 60, 64）。
"""

import pytest

from operation_service.auth_service import build_operation_auth_service
from operation_service.system_repository import build_system_account_repository


def test_build_system_account_repository_missing_username(monkeypatch):
    monkeypatch.setenv("OPERATION_SYSTEM_PASSWORD", "pw")
    monkeypatch.delenv("OPERATION_SYSTEM_USERNAME", raising=False)
    with pytest.raises(ValueError, match="OPERATION_SYSTEM_USERNAME"):
        build_system_account_repository()


def test_build_system_account_repository_missing_password(monkeypatch):
    monkeypatch.setenv("OPERATION_SYSTEM_USERNAME", "admin")
    monkeypatch.delenv("OPERATION_SYSTEM_PASSWORD", raising=False)
    with pytest.raises(ValueError, match="OPERATION_SYSTEM_PASSWORD"):
        build_system_account_repository()


def test_build_operation_auth_service_with_env_keys(monkeypatch):
    """OPERATION_SIGNING_PRIVATE_KEY/PUBLIC_KEY both set -> 用固定密钥（line 85）。"""
    from shared.auth import generate_rsa_keypair

    priv_pem, pub_pem = generate_rsa_keypair()
    monkeypatch.setenv("OPERATION_SYSTEM_USERNAME", "sysadmin")
    monkeypatch.setenv("OPERATION_SYSTEM_PASSWORD", "changeme")
    monkeypatch.setenv("OPERATION_SIGNING_PRIVATE_KEY", priv_pem)
    monkeypatch.setenv("OPERATION_SIGNING_PUBLIC_KEY", pub_pem)

    svc = build_operation_auth_service()
    assert svc.kid == "operation:1"
    # signer 应使用注入的固定密钥（可签发有效 token）
    from shared.contracts.auth import TokenClaims

    token = svc.signer.sign(TokenClaims(user_id="op1", roles=["system_admin"], exp=9999999999))
    assert token.count(".") == 2  # JWT 三段式


def test_build_operation_auth_service_generated_keys(monkeypatch):
    """无 env 密钥 -> 启动生成（line 88 分支）。"""
    monkeypatch.setenv("OPERATION_SYSTEM_USERNAME", "sysadmin")
    monkeypatch.setenv("OPERATION_SYSTEM_PASSWORD", "changeme")
    monkeypatch.delenv("OPERATION_SIGNING_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("OPERATION_SIGNING_PUBLIC_KEY", raising=False)

    svc = build_operation_auth_service()
    assert svc.kid == "operation:1"
