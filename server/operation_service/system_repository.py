"""运营端系统账号内存仓储（§9.2 系统账号→运营端本地校验）。

Operation 是纯内存端（无 PG/无 migrations），系统账号（system_admin/system_operator）用进程内
dict 持有。构造时按 env（OPERATION_SYSTEM_USERNAME/OPERATION_SYSTEM_PASSWORD，无默认值）
seed 一个 system_admin；未配置则启动失败。

生产可演进为 oper 库持久化，接口形状不变。密码用 shared.security scrypt hash（D15：operation
禁 import manager，hash 工具已下沉 shared）。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from shared.contracts.enums import PlatformRole
from shared.security import hash_password

_logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SystemAccount:
    """系统账号（运营端本地校验，§9.2）。tenant_id=None（平台级，非租户）。"""

    username: str
    password_hash: str
    roles: list[str] = field(default_factory=list)


class SystemAccountRepository:
    """系统账号进程内仓储（骨架内存实现，详设接 oper 库，接口不变）。"""

    def __init__(self) -> None:
        self._by_username: dict[str, SystemAccount] = {}

    def find(self, username: str) -> SystemAccount | None:
        return self._by_username.get(username)

    def seed(self, account: SystemAccount) -> None:
        """幂等 seed（同 username 覆盖）。"""
        self._by_username[account.username] = account


def build_system_account_repository() -> SystemAccountRepository:
    """构造并 seed system_admin（从 env 读取，无默认值）。

    必需 env：
    - OPERATION_SYSTEM_USERNAME：系统管理员用户名
    - OPERATION_SYSTEM_PASSWORD：系统管理员密码

    未配置则启动失败（确保开发者明确感知需要设置账号）。
    """
    repo = SystemAccountRepository()
    username = os.getenv("OPERATION_SYSTEM_USERNAME")
    password = os.getenv("OPERATION_SYSTEM_PASSWORD")

    if not username:
        raise ValueError(
            "OPERATION_SYSTEM_USERNAME 未设置。请在 .env.* 文件中配置运营端系统管理员用户名。"
        )
    if not password:
        raise ValueError(
            "OPERATION_SYSTEM_PASSWORD 未设置。请在 .env.* 文件中配置运营端系统管理员密码。"
        )

    _logger.info("初始化运营端系统账号：username=%s", username)
    repo.seed(SystemAccount(
        username=username,
        password_hash=hash_password(password),
        roles=[PlatformRole.SYSTEM_ADMIN.value],
    ))
    return repo
