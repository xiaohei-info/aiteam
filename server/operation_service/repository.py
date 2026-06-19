"""运营端企业账号仓储（oper 库的最小骨架）。

只持「企业账号 + 负责人 bootstrap 校验材料(hash/一次性)」——03 §9.2：Operator 永不持企业
长期密码。骨架期用进程内存实现；详设接 PostgreSQL（oper 库），接口形状不变。

单写者：企业账号表唯一写端是 Operator（CLAUDE/AGENTS §3.2）。
"""

from __future__ import annotations

from dataclasses import dataclass

from shared.errors import Conflict, NotFound


@dataclass(frozen=True)
class EnterpriseAccount:
    """运营端企业账号记录。owner_bootstrap_hash 只存校验材料，绝不存长期/明文密码。"""

    enterprise_id: str
    tenant_id: str
    enterprise_name: str
    enterprise_code: str | None
    owner_phone: str
    owner_bootstrap_hash: str


class EnterpriseRepository:
    """企业账号的进程内仓储。线程隔离留详设；骨架满足单端测试与流程闭环。"""

    def __init__(self) -> None:
        self._by_id: dict[str, EnterpriseAccount] = {}
        self._codes: set[str] = set()

    def create(self, account: EnterpriseAccount) -> EnterpriseAccount:
        if account.enterprise_id in self._by_id:
            raise Conflict(f"enterprise already exists: {account.enterprise_id}")
        if account.enterprise_code and account.enterprise_code in self._codes:
            raise Conflict(f"enterprise_code already taken: {account.enterprise_code}")
        self._by_id[account.enterprise_id] = account
        if account.enterprise_code:
            self._codes.add(account.enterprise_code)
        return account

    def get(self, enterprise_id: str) -> EnterpriseAccount:
        account = self._by_id.get(enterprise_id)
        if account is None:
            raise NotFound(f"enterprise not found: {enterprise_id}")
        return account

    def update_bootstrap_hash(self, enterprise_id: str, bootstrap_hash: str) -> EnterpriseAccount:
        account = self.get(enterprise_id)
        updated = EnterpriseAccount(
            enterprise_id=account.enterprise_id,
            tenant_id=account.tenant_id,
            enterprise_name=account.enterprise_name,
            enterprise_code=account.enterprise_code,
            owner_phone=account.owner_phone,
            owner_bootstrap_hash=bootstrap_hash,
        )
        self._by_id[enterprise_id] = updated
        return updated
