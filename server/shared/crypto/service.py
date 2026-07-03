"""对称加密工具（04 §6.7 provider 凭据入库前加密，D18）。

用途：provider_credential.encrypted_secret 的明文凭据（AI Relay 企业级令牌或直连 provider
API key）在入库前以 Fernet 对称加密包裹。**密钥不入库、不日志、不进错误体**（02 §11.2）。

密钥来源（优先级递减）：
1. 构造 CryptoService 时显式注入的 Fernet 实例（测试/依赖注入）。
2. 环境变量 MANAGER_CREDENTIAL_KEY（Fernet-compatible urlsafe base64 key）。

> 说明：历史上 `_DEV_KEY` 在 `MANAGER_CREDENTIAL_KEY` 未配置时作为静默 fallback，这等同
> 于在生产环境用同一份源码可见的固定密钥加密凭据——任意持有源码者即可解密全部凭据。本模块
> 现已 fail-closed：缺 `MANAGER_CREDENTIAL_KEY` 时直接 `RuntimeError` 拒绝构造默认 Fernet，
> 启动失败；生产部署必须显式设置该环境变量（`Fernet.generate_key()` 产出的 urlsafe base64）。
> `_DEV_KEY` 仅保留作为测试中显式注入的固定 key，不再被任何隐式 fallback 路径使用。

> 说明：本模块原为 `shared/crypto.py`，因与 `shared/crypto/` 包同名遮蔽导致 Manager 端
> ImportError（见 issue #214），迁入包内 `service.py` 并由包 `__init__` 重新导出，
> 公共 API（CryptoService / build_crypto_service）保持不变。
"""

from __future__ import annotations

import os
from functools import lru_cache

# 测试用固定 key：仅供测试/依赖注入场景显式传入 CryptoService(fernet=Fernet(_DEV_KEY))，
# 不再作为任何隐式 fallback 使用。缺 MANAGER_CREDENTIAL_KEY 的生产环境必须在构造
# 默认 Fernet 之前 RuntimeError（fail-closed，AITEAM-331 B1）。
_DEV_KEY = b"dZm0m7vQf0eXb6m9k1nQ2rT5uW8xYzAaBcDdEeFfGgI="  # noqa: S105（测试占位，非生产）


def _load_key() -> bytes:
    """从 env 取 Fernet key。

    缺 `MANAGER_CREDENTIAL_KEY` 时 **fail-closed**：直接 RuntimeError 拒绝构造默认 Fernet，
    防止生产环境在未配置密钥的情况下静默使用源码可见的固定 key 加密凭据（AITEAM-331 B1）。
    """
    env_key = os.getenv("MANAGER_CREDENTIAL_KEY")
    if not env_key:
        raise RuntimeError(
            "MANAGER_CREDENTIAL_KEY is not configured. "
            "Credential encryption requires a Fernet-compatible key "
            "(generate one with `from cryptography.fernet import Fernet; Fernet.generate_key()`). "
            "Refusing to fall back to a hardcoded dev key in production."
        )
    return env_key.encode("utf-8")


@lru_cache(maxsize=1)
def _default_fernet():
    """进程级默认 Fernet（来自 env key）。lru_cache 保证单进程单实例。

    缺 `MANAGER_CREDENTIAL_KEY` 时 fail-closed（AITEAM-331 B1）。
    """
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
