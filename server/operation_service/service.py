"""企业开通 + 负责人 bootstrap 签发/重置编排（05 F01/F02，03 §9.2，D1）。

流程（F01+F02）：
1. 生成 enterprise_id / tenant_id；一次性 bootstrap 仅在内存 fanout/响应中使用，耐久 receipt 只存加密密文。
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
from shared.errors import Conflict, NotFound

from .admin_repository import AdminRepository
from .manager_gateway import ManagerGateway
from .onboarding_receipt import (
    build_onboarding_receipt_store,
    canonical_request_fingerprint,
    normalize_idempotency_key,
)
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
        self._onboarding_receipts = build_onboarding_receipt_store(repo)

    def provision_enterprise(
        self,
        req: ProvisionEnterpriseRequest,
        *,
        idempotency_key: str | None = None,
    ) -> EnterpriseProvisioned:
        request_body = req.model_dump(mode="json", exclude_none=False)
        request_fingerprint = canonical_request_fingerprint(
            req.model_dump(mode="json", exclude_none=True)
        )
        enterprise_id = str(uuid.uuid4())
        tenant_id = str(uuid.uuid4())
        key = normalize_idempotency_key(idempotency_key) if idempotency_key else f"provision:{enterprise_id}"
        receipt = self._onboarding_receipts.reserve(
            idempotency_key=key,
            request_fingerprint=request_fingerprint,
            request_body=request_body,
            enterprise_id=enterprise_id,
            tenant_id=tenant_id,
            enterprise_name=req.enterprise_name,
            enterprise_code=req.enterprise_code,
            owner_phone=req.owner_phone,
            bootstrap_secret=_new_bootstrap_secret(),
        )
        if receipt.state == "completed" and receipt.safe_response is not None:
            return EnterpriseProvisioned(
                **receipt.safe_response,
                owner_bootstrap_secret=receipt.bootstrap_secret,
            )

        # Resume exactly the body/IDs/secret persisted before any fanout.  This
        # makes a crash after Manager accepted F01/F02 safe to retry without a
        # second enterprise or a different one-time secret.
        original = ProvisionEnterpriseRequest.model_validate(receipt.request_body)
        allowed_model_refs = (
            None
            if original.allowed_model_refs is None
            else _dedupe_model_refs(original.allowed_model_refs)
        )
        self._validate_allowed_model_refs(allowed_model_refs)
        local_hash = _hash_bootstrap_local(receipt.bootstrap_secret)

        provision_manager_key = (
            receipt.idempotency_key
            if idempotency_key is None
            else f"provision:{receipt.idempotency_key}"
        )
        bootstrap_manager_key = (
            f"bootstrap:{receipt.enterprise_id}:0"
            if idempotency_key is None
            else f"bootstrap:{receipt.idempotency_key}"
        )
        self._manager.provision_tenant(
            TenantProvisionRequest(
                enterprise_id=receipt.enterprise_id,
                tenant_id=receipt.tenant_id,
                enterprise_name=original.enterprise_name,
                enterprise_code=original.enterprise_code,
                initial_quota_policy=original.initial_quota_policy,
                allowed_model_refs=allowed_model_refs,
            ),
            idempotency_key=provision_manager_key,
        )
        self._manager.sync_owner_bootstrap(
            OwnerBootstrapSync(
                tenant_id=receipt.tenant_id,
                owner_phone=original.owner_phone,
                bootstrap_secret=receipt.bootstrap_secret,
                must_reset=True,
            ),
            idempotency_key=bootstrap_manager_key,
        )

        account = EnterpriseAccount(
            enterprise_id=receipt.enterprise_id,
            tenant_id=receipt.tenant_id,
            enterprise_name=original.enterprise_name,
            enterprise_code=original.enterprise_code,
            owner_phone=original.owner_phone,
            owner_bootstrap_hash=local_hash,
            allowed_model_refs=(
                [ref.model_dump(mode="json") for ref in allowed_model_refs]
                if allowed_model_refs is not None else None
            ),
        )
        try:
            existing = self._repo.get(receipt.enterprise_id)
        except NotFound:
            self._repo.create(account)
        else:
            if existing != account:
                raise Conflict("enterprise receipt conflicts with the persisted Operator account")

        if self._admin is not None:
            self._admin.register_enterprise(
                enterprise_id=receipt.enterprise_id,
                enterprise_name=original.enterprise_name,
                owner_phone=original.owner_phone,
            )

        result = EnterpriseProvisioned(
            enterprise_id=receipt.enterprise_id,
            tenant_id=receipt.tenant_id,
            enterprise_name=original.enterprise_name,
            enterprise_code=original.enterprise_code,
            owner_phone=original.owner_phone,
            owner_bootstrap_secret=receipt.bootstrap_secret,
            must_reset=True,
            allowed_model_refs=allowed_model_refs,
        )
        self._onboarding_receipts.complete(
            receipt.idempotency_key,
            result.model_dump(mode="json", exclude={"owner_bootstrap_secret"}),
        )
        return result

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

    def reset_owner_bootstrap(
        self,
        enterprise_id: str,
        *,
        idempotency_key: str | None = None,
    ) -> OwnerBootstrapResetResult:
        account = self._repo.get(enterprise_id)  # NotFound -> 404
        raw_key = normalize_idempotency_key(idempotency_key)
        receipt_key = f"reset:{enterprise_id}:{raw_key}"
        receipt_body = {"enterprise_id": enterprise_id, "operation": "owner-bootstrap-reset"}
        receipt = self._onboarding_receipts.reserve(
            idempotency_key=receipt_key,
            request_fingerprint=canonical_request_fingerprint(receipt_body),
            request_body=receipt_body,
            enterprise_id=account.enterprise_id,
            tenant_id=account.tenant_id,
            enterprise_name=account.enterprise_name,
            enterprise_code=account.enterprise_code,
            owner_phone=account.owner_phone,
            bootstrap_secret=_new_bootstrap_secret(),
        )
        if receipt.state == "completed" and receipt.safe_response is not None:
            return OwnerBootstrapResetResult(
                **receipt.safe_response,
                owner_bootstrap_secret=receipt.bootstrap_secret,
            )

        self._manager.sync_owner_bootstrap(
            OwnerBootstrapSync(
                tenant_id=receipt.tenant_id,
                owner_phone=receipt.owner_phone,
                bootstrap_secret=receipt.bootstrap_secret,
                must_reset=True,
            ),
            idempotency_key=f"bootstrap:{receipt.idempotency_key}",
        )
        self._repo.update_bootstrap_hash(
            receipt.enterprise_id,
            _hash_bootstrap_local(receipt.bootstrap_secret),
        )
        result = OwnerBootstrapResetResult(
            enterprise_id=receipt.enterprise_id,
            tenant_id=receipt.tenant_id,
            owner_phone=receipt.owner_phone,
            owner_bootstrap_secret=receipt.bootstrap_secret,
            must_reset=True,
        )
        self._onboarding_receipts.complete(
            receipt.idempotency_key,
            result.model_dump(mode="json", exclude={"owner_bootstrap_secret"}),
        )
        return result
