"""密码 hash（不可逆，不存明文；03 §9.3 / 04 §6.1 owner_credential 不存可逆密码）。

横切工具，归 shared（三端均可复用，D15 源码隔离：operation 禁 import manager）。
用 stdlib hashlib.scrypt（无需新依赖），格式 `scrypt$<n>$<r>$<p>$<salt_b64>$<hash_b64>`。
校验用 hmac.compare_digest 常量时间比较，防时序侧信道。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os

_N = 2**14
_R = 8
_P = 1
_DKLEN = 32
_SALT_BYTES = 16


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def hash_password(password: str) -> str:
    salt = os.urandom(_SALT_BYTES)
    derived = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"scrypt${_N}${_R}${_P}${_b64(salt)}${_b64(derived)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        derived = hashlib.scrypt(
            password.encode(), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(derived, expected)
