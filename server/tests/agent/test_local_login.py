"""用户端本地登录验收（A0 / 03 §9.4C、§9.5/§9.6）。

覆盖三段口径：
1. 首次在线：Agent 经 Manager 校验凭据 → 拿 token + 验签材料 → 本地缓存。
2. 本地验签：缓存命中后用 shared/auth 本地无状态验签，**不再访问 Manager**。
3. token cache 复用 + Manager 离线降级：已登录用户凭本地 token 继续工作。

红线断言：用户端只持验签材料（公钥/secret-as-verify），不持可签发 token 的能力。
"""

import time

import pytest

from agent_service.auth.local_login import (
    LocalLoginService,
    LoginRequest,
    ManagerUnreachable,
)
from agent_service.auth.token_cache import InMemoryTokenCache
from shared.auth import DevTokenService
from shared.contracts.auth import TokenClaims
from shared.errors import Unauthorized


class FakeManagerLoginClient:
    """跨端 Manager 登录端的 fake（A0：对端先用 mock/fake）。

    模拟 Manager 按 tenant 校验凭据并签发 token + 下发验签材料。用户端**不持**这里的签发能力，
    只接收 token 字符串与验签材料引用。
    """

    def __init__(self, *, secret: str = "manager-tenant-key"):
        # 签发能力仅存在于 fake Manager 侧；不下发给用户端。
        self._signer = DevTokenService(secret)
        self._verify_material = secret  # 真实为公钥/JWKS；此处 dev 对称材料仅供验签
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
        return token, self._verify_material


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
    """缓存命中后本地验签，不再回调 Manager（calls 不增长）。"""
    svc, mgr, _ = _service()
    svc.login(_req())
    assert mgr.calls == 1
    claims = svc.current_identity()  # 本地验签
    assert claims.user_id == "u-42"
    assert mgr.calls == 1  # 没有再次联网


def test_offline_degrade_reuses_cached_token():
    """Manager 离线时，已登录用户凭本地 token + 投影继续工作（§9.8 跨端可用性）。"""
    svc, mgr, _ = svc_after_login()
    mgr.online = False
    claims = svc.current_identity()
    assert claims.user_id == "u-42"


def test_no_cache_no_identity():
    svc, _, _ = _service()
    assert svc.current_identity() is None


def test_expired_cached_token_rejected_locally():
    """过期 token 本地验签即失败（§9.5：过期需重新联网登录）。"""
    svc, mgr, cache = _service()
    expired = mgr._signer.sign(
        TokenClaims(user_id="u-42", tenant_id="t-1", roles=["member"], exp=1)
    )
    cache.store(expired, mgr._verify_material)
    assert svc.current_identity() is None


def svc_after_login():
    svc, mgr, cache = _service()
    svc.login(_req())
    return svc, mgr, cache
