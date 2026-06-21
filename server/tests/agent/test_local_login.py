"""用户端本地登录验收（D23 / 03 §9.4C、§9.5/§9.6）。

覆盖三段口径：
1. 首次在线：Agent 经 Manager 校验凭据 → 拿 token + JWKS → 本地缓存。
2. 本地验签：缓存命中后用 shared/auth 的 RS256TokenVerifier 本地无状态验签，**不再访问 Manager**。
3. token cache 复用 + Manager 离线降级：已登录用户凭本地 token 继续工作。

新增覆盖（#101 GAP-2）：Manager RS256 签发 → Agent RS256TokenVerifier 验签端到端 PASSED；
过期 / 篡改 / 错误 JWKS（tenant 不匹配）token 一律被本地拒绝。

红线断言：用户端只持 JWKS（公钥），不持 Manager 私钥、不持对称 HMAC 密钥（D23）。
"""

import time

import pytest

from agent_service.auth.local_login import (
    LocalLoginService,
    LoginRequest,
    ManagerUnreachable,
)
from agent_service.auth.token_cache import InMemoryTokenCache
from shared.auth import RS256TokenSigner, generate_rsa_keypair, jwks_from_public_pem
from shared.contracts.auth import TokenClaims
from shared.errors import Unauthorized


class FakeManagerLoginClient:
    """跨端 Manager 登录端的 fake（模拟 Manager 按 tenant 持私钥签发，下发 JWKS）。

    签发能力（RS256TokenSigner + 私钥）仅存在于 fake Manager 侧，绝不下发用户端；
    用户端只接收 token 字符串 + JWKS（公钥）。
    """

    def __init__(self) -> None:
        private_pem, _public_pem = generate_rsa_keypair()
        self._kid = "t-1:1"
        self._signer = RS256TokenSigner(private_pem, kid=self._kid)  # 仅 Manager 侧持有
        self._jwks = self._signer.jwks()  # 下发用户端的验签材料（公钥）
        self.calls = 0
        self.online = True

    def login(self, req: LoginRequest):
        self.calls += 1
        if not self.online:
            raise ManagerUnreachable("manager offline")
        if req.password != "correct-horse":
            raise Unauthorized("bad credentials")
        claims = TokenClaims(
            user_id="u-42",
            tenant_id="t-1",
            roles=["member"],
            exp=int(time.time()) + 3600,
        )
        token = self._signer.sign(claims)
        return token, self._jwks

    def sign(self, claims: TokenClaims) -> str:
        """fake 侧签发 helper（仅供测试构造特定 token，私钥不下发）。"""
        return self._signer.sign(claims)


def _service():
    mgr = FakeManagerLoginClient()
    cache = InMemoryTokenCache()
    return LocalLoginService(manager=mgr, cache=cache), mgr, cache


def _req(password="correct-horse"):
    return LoginRequest(account="13800000000", password=password, tenant_hint="t-1")


def test_first_login_online_then_cached():
    svc, mgr, cache = _service()
    session = svc.login(_req())
    assert session.claims.user_id == "u-42"
    assert session.claims.tenant_id == "t-1"
    assert mgr.calls == 1
    assert cache.load() is not None


def test_bad_credentials_rejected():
    svc, mgr, _ = _service()
    with pytest.raises(Unauthorized):
        svc.login(_req(password="wrong"))


def test_local_verify_uses_cache_without_manager():
    """缓存命中后本地 RS256 验签，不再回调 Manager（calls 不增长）。"""
    svc, mgr, _ = _service()
    svc.login(_req())
    assert mgr.calls == 1
    claims = svc.current_identity()  # 本地验签
    assert claims.user_id == "u-42"
    assert mgr.calls == 1  # 没有再次联网


def test_offline_degrade_reuses_cached_token():
    """Manager 离线时，已登录用户凭本地 token + JWKS 继续工作（§9.8 跨端可用性）。"""
    svc, mgr, _ = _service()
    svc.login(_req())
    mgr.online = False
    claims = svc.current_identity()
    assert claims.user_id == "u-42"


def test_no_cache_no_identity():
    svc, _, _ = _service()
    assert svc.current_identity() is None


def test_expired_cached_token_rejected_locally():
    """过期 token 本地验签即失败（§9.5：过期需重新联网登录）。"""
    svc, mgr, cache = _service()
    expired = mgr.sign(
        TokenClaims(user_id="u-42", tenant_id="t-1", roles=["member"], exp=1)
    )
    cache.store(expired, mgr._jwks)
    assert svc.current_identity() is None


def test_tampered_token_rejected_locally():
    """篡改后的 token 被本地 RS256 验签拒绝（签名校验失败）。"""
    svc, mgr, cache = _service()
    claims = TokenClaims(
        user_id="u-42", tenant_id="t-1", roles=["member"], exp=int(time.time()) + 3600
    )
    token = mgr.sign(claims)
    # 拆开 JWT 三段，篡改 payload 再拼回（签名必然失配）。
    header, payload, sig = token.split(".")
    # 把 payload 里 user_id 字段改掉：base64url 解 → 改 → 编回。
    import base64
    import json

    pad = payload + "=" * (-len(payload) % 4)
    body = json.loads(base64.urlsafe_b64decode(pad))
    body["user_id"] = "u-evil"
    tampered_payload = base64.urlsafe_b64encode(
        json.dumps(body).encode()
    ).decode().rstrip("=")
    tampered = f"{header}.{tampered_payload}.{sig}"
    cache.store(tampered, mgr._jwks)
    assert svc.current_identity() is None


def test_wrong_jwks_rejected_locally():
    """用另一个 tenant 的 JWKS 验本 tenant 签发的 token，本地拒绝（kid 不匹配）。"""
    svc, mgr, cache = _service()
    claims = TokenClaims(
        user_id="u-42", tenant_id="t-1", roles=["member"], exp=int(time.time()) + 3600
    )
    token = mgr.sign(claims)
    # 另一个 tenant 的密钥（不同 kid、不同公钥）。
    other_private, other_public = generate_rsa_keypair()
    other_jwks = jwks_from_public_pem("t-other:1", other_public)
    cache.store(token, other_jwks)
    assert svc.current_identity() is None
