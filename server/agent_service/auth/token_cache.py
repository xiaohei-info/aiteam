"""本地 token cache（A0 / 03 §9.4C "用户端缓存 token，此后本地验签"）。

缓存内容 = token 字符串 + 验签材料（生产为公钥/JWKS，骨架期为 dev 对称材料引用）。
抽象出 TokenCache 接口，A0 提供进程内实现；落盘/加密本地存储留后续工单（本地优先，不上传）。

铁律：缓存的是**验签材料**，不是签发密钥；用户端永不持可签发 token 的能力（D23）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class CachedToken:
    """缓存条目：一段 access token + 配套验签材料（JWKS dict，D23）。"""

    token: str
    verify_material: dict


class TokenCache(ABC):
    """本地 token 缓存抽象。单写者为用户端本进程；不跨端。"""

    @abstractmethod
    def store(self, token: str, jwks: dict) -> None:
        ...

    @abstractmethod
    def load(self) -> CachedToken | None:
        ...

    @abstractmethod
    def clear(self) -> None:
        ...


class InMemoryTokenCache(TokenCache):
    """进程内实现（A0 骨架）。重启即失效——重启后需重新联网登录，符合"首次在线"口径。"""

    def __init__(self) -> None:
        self._entry: CachedToken | None = None

    def store(self, token: str, jwks: dict) -> None:
        self._entry = CachedToken(token=token, verify_material=jwks)

    def load(self) -> CachedToken | None:
        return self._entry

    def clear(self) -> None:
        self._entry = None
