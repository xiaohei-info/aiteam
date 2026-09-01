"""企业开通 + 负责人 bootstrap 签发/重置编排（05 F01/F02，03 §9.2，D1）。

流程（F01+F02）：
1. 生成 enterprise_id / tenant_id；生成一次性 bootstrap 明文，只在响应里返回一次。
2. 调 Manager(窄通信) 创建 tenant（F01）。
3. 调 Manager 同步负责人 bootstrap 明文（F02，TLS 服务间）；Manager 单次 scrypt 落库（单一 hash 真相源）。
4. 本端 oper 库只持 sha256 校验材料（Operator 永不持长期密码）。

红线（CLAUDE/AGENTS §8 / 03 §9.2）：Operator 不持企业长期/明文密码、不执行 Agent、不持会话、
不写 Manager 租户库（只服务调用）、不向用户机器入站。
"""

from __future__ import annotations

import hashlib
import secrets
import string
import uuid

from shared.contracts.crosstier import OwnerBootstrapSync, TenantProvisionRequest
from shared.contracts.platform_provider import PlatformModelRef

from .admin_repository import AdminRepository
from .manager_gateway import ManagerGateway
from .repository import EnterpriseAccount, EnterpriseRepository
from .schemas import (
    EnterpriseProvisioned,
    OwnerBootstrapResetResult,
    ProvisionEnterpriseRequest,
    EnterpriseModelAccessOut,
)


# bootstrap 明文用符号集：JSON/URL/展示安全（不含 " \ / 空格），供 Manager 密码策略的
# "require symbol" 满足。
_SECRET_SYMBOLS = "!@#$%^&*-_=+"


def _new_bootstrap_secret() -> str:
    """生成一次性 bootstrap 明文，保证满足 Manager 密码策略（小写/大写/数字/符号各≥1，
    长度 24 足够熵且 > 最小长度）。仅返回当次，不落库。

    原用 secrets.token_urlsafe：字符集 [A-Za-z0-9_-]，约 37% 概率整串无符号 → 过不了
    Manager 的 "require symbol" 策略，致开通/重置随机失败（"操作失败，请重试"）。
    改为按类各保证 ≥1 再随机填充、洗牌，稳定合规。
    """
    alphabet = string.ascii_lowercase + string.ascii_uppercase + string.digits + _SECRET_SYMBOLS
    picks = [
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.digits),
        secrets.choice(_SECRET_SYMBOLS),
    ]
    picks += [secrets.choice(alphabet) for _ in range(20)]
    secrets.SystemRandom().shuffle(picks)
    return "".join(picks)


def _dedupe_model_refs(refs: list[PlatformModelRef]) -> list[PlatformModelRef]:
    """Keep one current reference per provider/model pair for a stable allow-list."""
    seen: set[tuple[str, str]] = set()
    result: list[PlatformModelRef] = []
    for ref in refs:
        key = (ref.provider_id, ref.model_id)
        if key in seen:
            continue
        seen.add(key)
        result.append(ref)
    return result


def _hash_bootstrap_local(secret: str) -> str:
    """Operator 本端只存的校验材料（sha256），绝不存长期/明文密码（03 §9.2）。

    注意：本 hash 仅用于 Operator 自身的 oper 库记录，**不跨端**。
    跨端同步给 Manager 的 `bootstrap_secret` 是明文——Manager 内单次 scrypt 是 hash 单一真相源
    （修复 #100 review CRITICAL：避免 Operator sha256 + Manager scrypt 双重 hash 导致 owner 首登断链）。
    """
    return hashlib.sha256(secret.encode()).hexdigest()


class ProvisioningService:
    """无状态编排器；依赖注入 repository 与 Manager 网关（对端可 mock）。"""

    def __init__(
        self,
        repo: EnterpriseRepository,
        manager: ManagerGateway,
        admin_repo: AdminRepository | None = None,
        platform_provider_service=None,
    ):
        self._repo = repo
        self._manager = manager
        self._admin = admin_repo
        self._platform_providers = platform_provider_service

    def provision_enterprise(self, req: ProvisionEnterpriseRequest) -> EnterpriseProvisioned:
        allowed_model_refs = None if req.allowed_model_refs is None else _dedupe_model_refs(req.allowed_model_refs)
        self._validate_allowed_model_refs(allowed_model_refs)
        enterprise_id = str(uuid.uuid4())
        tenant_id = str(uuid.uuid4())
        secret = _new_bootstrap_secret()
        local_hash = _hash_bootstrap_local(secret)  # Operator 本端只持 sha256 校验材料

        # F01：请求 Manager 建 tenant（写调用带 Idempotency-Key）。
        self._manager.provision_tenant(
            TenantProvisionRequest(
                enterprise_id=enterprise_id,
                tenant_id=tenant_id,
                enterprise_name=req.enterprise_name,
                enterprise_code=req.enterprise_code,
                initial_quota_policy=req.initial_quota_policy,
                visible_catalog_policy=req.visible_catalog_policy,
                allowed_model_refs=allowed_model_refs,
            ),
            idempotency_key=f"provision:{enterprise_id}",
        )

        # F02：同步负责人 bootstrap 明文（TLS 服务间；Manager 单次 scrypt，单一 hash 真相源）。
        self._manager.sync_owner_bootstrap(
            OwnerBootstrapSync(
                tenant_id=tenant_id,
                owner_phone=req.owner_phone,
                bootstrap_secret=secret,
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
                owner_bootstrap_hash=local_hash,
                allowed_model_refs=(
                    [ref.model_dump(mode="json") for ref in allowed_model_refs]
                    if allowed_model_refs is not None else None
                ),
            )
        )

        # 同步注册 admin 状态（概览/账号管理/财务管理等 admin 页面查询 AdminRepository；
        # 不注册则开通后这些页面看不到新企业）。
        if self._admin is not None:
            self._admin.register_enterprise(
                enterprise_id=enterprise_id,
                enterprise_name=req.enterprise_name,
                owner_phone=req.owner_phone,
            )

        return EnterpriseProvisioned(
            enterprise_id=enterprise_id,
            tenant_id=tenant_id,
            enterprise_name=req.enterprise_name,
            enterprise_code=req.enterprise_code,
            owner_phone=req.owner_phone,
            owner_bootstrap_secret=secret,
            must_reset=True,
            allowed_model_refs=allowed_model_refs,
        )

    def get_model_access(self, enterprise_id: str) -> EnterpriseModelAccessOut:
        account = self._repo.get(enterprise_id)
        return EnterpriseModelAccessOut(
            enterprise_id=account.enterprise_id,
            tenant_id=account.tenant_id,
            allowed_model_refs=(
                [PlatformModelRef.model_validate(ref) for ref in account.allowed_model_refs]
                if account.allowed_model_refs is not None else None
            ),
        )

    def set_model_access(
        self, enterprise_id: str, allowed_model_refs: list[PlatformModelRef] | None
    ) -> EnterpriseModelAccessOut:
        self._validate_allowed_model_refs(allowed_model_refs)
        # Keep first occurrence order while rejecting duplicate model refs only by
        # canonical provider/model identity; versions are refreshed on the next edit.
        refs = None if allowed_model_refs is None else _dedupe_model_refs(allowed_model_refs)
        account = self._repo.update_allowed_model_refs(
            enterprise_id,
            [ref.model_dump(mode="json") for ref in refs] if refs is not None else None,
        )
        return EnterpriseModelAccessOut(
            enterprise_id=account.enterprise_id,
            tenant_id=account.tenant_id,
            allowed_model_refs=(
                [PlatformModelRef.model_validate(ref) for ref in account.allowed_model_refs]
                if account.allowed_model_refs is not None else None
            ),
        )

    def _validate_allowed_model_refs(self, refs: list[PlatformModelRef] | None) -> None:
        if refs is None or self._platform_providers is None:
            return
        for ref in refs:
            self._platform_providers.validate_model_ref(ref, require_published=True)

    def reset_owner_bootstrap(self, enterprise_id: str) -> OwnerBootstrapResetResult:
        account = self._repo.get(enterprise_id)  # NotFound -> 404
        secret = _new_bootstrap_secret()
        local_hash = _hash_bootstrap_local(secret)

        # 用唯一 reset id 派生 Idempotency-Key：每次重置是一次新的写。
        reset_id = uuid.uuid4().hex
        self._manager.sync_owner_bootstrap(
            OwnerBootstrapSync(
                tenant_id=account.tenant_id,
                owner_phone=account.owner_phone,
                bootstrap_secret=secret,
                must_reset=True,
            ),
            idempotency_key=f"bootstrap:{enterprise_id}:reset:{reset_id}",
        )
        self._repo.update_bootstrap_hash(enterprise_id, local_hash)

        return OwnerBootstrapResetResult(
            enterprise_id=enterprise_id,
            tenant_id=account.tenant_id,
            owner_phone=account.owner_phone,
            owner_bootstrap_secret=secret,
            must_reset=True,
        )
