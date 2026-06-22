"""密码 hash（向后兼容 re-export，03 §9.3 / 04 §6.1）。

实现已下沉到 `shared.security`（横切工具，三端可复用，D15）。本文件保留 re-export，
manager_service 内既有 `from .security import hash_password, verify_password` 零改动。
"""

from __future__ import annotations

from shared.security import hash_password, verify_password

__all__ = ["hash_password", "verify_password"]
