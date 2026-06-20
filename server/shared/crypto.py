"""对称加密工具（04 §6.7 provider 凭据入库前加密，D18）。

用途：provider_credential.encrypted_secret 的明文凭据（AI Relay 企业级令牌或直连 provider
API key）在入库前以 Fernet 对称加密包裹。**密钥不入库、不日志、不进错误体**（02 §11.2）。

密钥来源（优先级递减）：
1. 构造 CryptoService 时显式注入的 Fernet 实例（测试/依赖注入）。
2. 环境变量 MANAGER_CREDENTIAL_KEY（Fernet-compatible urlsafe base64 key）。
3. 进程内派生的开发默认 key（仅 dev/测试，绝不用于生产）。

红线：
- 加密 key 绝不落库（DB 只存密文）。
- 加密 key 绝不写日志/错误体/响应（02 §11.2）。
- 解密只在受控面（Manager 内部编排 / 用户端 Driver 最小注入，04 §6.7）发生，本模块不负责调用面。
"""

from __future__ import annotations

import os
from functools import lru_cache

# 开发默认 key：固定值，仅用于 dev/测试（无 MANAGER_CREDENTIAL_KEY 时）。
# 生产必须设置 MANAGER_CREDENTIAL_KEY（Fernet.generate_key() 产出，base64 urlsafe）。
_DEV_KEY = b"dZm0m7vQf0eXb6m9k1nQ2rT5uW8xYzAaBcDdEeFfGgI="  # noqa: S105（开发占位，非生产）


def _load_key() -> bytes:
    """从 env 取 Fernet key；未设置则回退开发 key（仅 dev/测试，日志绝不打印 key 本身）。"""
    env_key = os.getenv("MANAGER_CREDENTIAL_KEY")
    if env_key:
        return env_key.encode("utf-8")
    return _DEV_KEY


@lru_cache(maxsize=1)
def _default_fernet():
    """进程级默认 Fernet（来自 env key）。lru_cache 保证单进程单实例。"""
    from cryptography.fernet import Fernet

    return Fernet(_load_key())


class CryptoService:
    """明文凭据对称加密/解密封装（04 §6.7，D18）。

    默认使用 env key 派生的 Fernet；测试/编排可注入显式 Fernet 实例。
    """

    def __init__(self, fernet=None):
        self._fernet = fernet  # 延迟导入 cryptography，默认门不依赖

    def _get(self):
        return self._fernet or _default_fernet()

    def encrypt(self, plaintext: str) -> bytes:
        """加密明文 → 返回 Fernet token（bytes，落 bytea 列）。

        明文不在本方法内存外泄漏：不日志、不缓存原文。
        """
        if plaintext is None:
            raise ValueError("plaintext secret must not be None")
        return self._get().encrypt(plaintext.encode("utf-8"))

    def decrypt(self, token: bytes) -> str:
        """解密 Fernet token → 返回明文（仅在受控编排面调用）。"""
        if token is None:
            raise ValueError("encrypted token must not be None")
        return self._get().decrypt(token).decode("utf-8")


def build_crypto_service() -> CryptoService:
    """构造默认 CryptoService（env key）。供 app.state 缓存复用。"""
    return CryptoService()
