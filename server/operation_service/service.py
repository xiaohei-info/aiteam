"""企业开通 + 负责人 bootstrap 签发/重置编排（05 F01/F02，03 §9.2，D1）。

流程（F01+F02）：
1. 生成 enterprise_id / tenant_id；生成一次性 bootstrap 明文，只在响应里返回一次。
2. 调 Manager(窄通信) 创建 tenant（F01）。
3. 调 Manager 同步负责人 bootstrap 的 **hash**（F02）；Operator 自身只持 hash。
4. 本端 oper 库落企业账号 + bootstrap hash。

红线（CLAUDE/AGENTS §8 / 03 §9.2）：Operator 不持企业长期/明文密码、不执行 Agent、不持会话、
不写 Manager 租户库（只服务调用）、不向用户机器入站。
"""

from __future__ import annotations

import hashlib
import secrets
import uuid

from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest

from .manager_gateway import ManagerGateway
from .repository import EnterpriseAccount, EnterpriseRepository
from .schemas import (
    EnterpriseProvisioned,
    OwnerBootstrapResetResult,
    ProvisionEnterpriseRequest,
)


def _new_bootstrap_secret() -> str:
    """生成一次性 bootstrap 明文（URL-safe，足够熵）。仅返回当次，不落库。"""
    return secrets.token_urlsafe(24)


def _hash_bootstrap(secret: str) -> str:
    """对 bootstrap 明文做不可逆 hash（骨架用 sha256；详设接 argon2/bcrypt + salt，03 §9.5）。"""
    return hashlib.sha256(secret.encode()).hexdigest()


class ProvisioningService:
    """无状态编排器；依赖注入 repository 与 Manager 网关（对端可 mock）。"""

    def __init__(self, repo: EnterpriseRepository, manager: ManagerGateway):
        self._repo = repo
        self._manager = manager

    def provision_enterprise(self, req: ProvisionEnterpriseRequest) -> EnterpriseProvisioned:
        enterprise_id = str(uuid.uuid4())
        tenant_id = str(uuid.uuid4())
        secret = _new_bootstrap_secret()
        bootstrap_hash = _hash_bootstrap(secret)

        # F01：请求 Manager 建 tenant（写调用带 Idempotency-Key）。
        self._manager.provision_tenant(
            TenantProvisionRequest(
                enterprise_id=enterprise_id,
                tenant_id=tenant_id,
                enterprise_name=req.enterprise_name,
                enterprise_code=req.enterprise_code,
                initial_quota_policy=req.initial_quota_policy,
                visible_catalog_policy=req.visible_catalog_policy,
            ),
            idempotency_key=f"provision:{enterprise_id}",
        )

        # F02：同步负责人 bootstrap（只传 hash，首登强制重置）。
        self._manager.sync_owner_bootstrap(
            OwnerBootstrapSync(
                tenant_id=tenant_id,
                owner_phone=req.owner_phone,
                bootstrap_secret_hash=bootstrap_hash,
                must_reset=True,
            ),
            idempotency_key=f"bootstrap:{enterprise_id}:0",
        )

        # 本端只在跨端写成功后落账，避免悬挂账号（最终一致：失败由上层重试同 key）。
        self._repo.create(
            EnterpriseAccount(
                enterprise_id=enterprise_id,
                tenant_id=tenant_id,
                enterprise_name=req.enterprise_name,
                enterprise_code=req.enterprise_code,
                owner_phone=req.owner_phone,
                owner_bootstrap_hash=bootstrap_hash,
            )
        )

        return EnterpriseProvisioned(
            enterprise_id=enterprise_id,
            tenant_id=tenant_id,
            enterprise_name=req.enterprise_name,
            enterprise_code=req.enterprise_code,
            owner_phone=req.owner_phone,
            owner_bootstrap_secret=secret,
            must_reset=True,
        )

    def reset_owner_bootstrap(self, enterprise_id: str) -> OwnerBootstrapResetResult:
        account = self._repo.get(enterprise_id)  # NotFound -> 404
        secret = _new_bootstrap_secret()
        bootstrap_hash = _hash_bootstrap(secret)

        # 用唯一 reset id 派生 Idempotency-Key：每次重置是一次新的写。
        reset_id = uuid.uuid4().hex
        self._manager.sync_owner_bootstrap(
            OwnerBootstrapSync(
                tenant_id=account.tenant_id,
                owner_phone=account.owner_phone,
                bootstrap_secret_hash=bootstrap_hash,
                must_reset=True,
            ),
            idempotency_key=f"bootstrap:{enterprise_id}:reset:{reset_id}",
        )
        self._repo.update_bootstrap_hash(enterprise_id, bootstrap_hash)

        return OwnerBootstrapResetResult(
            enterprise_id=enterprise_id,
            tenant_id=account.tenant_id,
            owner_phone=account.owner_phone,
            owner_bootstrap_secret=secret,
            must_reset=True,
        )
