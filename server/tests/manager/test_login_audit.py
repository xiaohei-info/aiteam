"""login_audit 单元测试（非集成；FakeRouter）。"""

from __future__ import annotations

import hmac

import pytest

from manager_service.login_audit import LoginAuditRepository, _ip_hash

from ._fake_router import FakeCursor, FakeRouter, ctx


def test_record_persists_expected_columns():
    router = FakeRouter()
    router.queue(FakeCursor())
    repo = LoginAuditRepository(router)
    tenant = ctx()
    repo.record(tenant, provider="passkey", external_id="cred:x", actor="u-1",
                ip="203.0.113.5", success=True, detail="ok")
    sql, params = router.executed[0]
    assert "INSERT INTO login_attempt" in sql
    assert params[0] == tenant.tenant_id
    assert params[1] == "u-1"                  # actor
    assert params[2] == "passkey"              # provider value
    assert params[3] == "cred:x"               # external_id
    assert params[5] is True                   # success
    assert params[6] == "ok"                   # detail

def test_record_masked_ip_is_hashed_not_plaintext():
    router = FakeRouter()
    router.queue(FakeCursor())
    repo = LoginAuditRepository(router)
    tenant = ctx()
    repo.record(tenant, provider="password", external_id="a", actor="u", ip="1.2.3.4", success=False, detail="x")
    _, params = router.executed[0]
    ip_hash = params[4]
    assert ip_hash != "1.2.3.4"
    assert len(ip_hash) == 64                     # sha-256 hex

def test_record_does_not_raise_on_router_failure():
    class BoomRouter:
        def session(self, ctx):
            raise RuntimeError("boom")
    repo = LoginAuditRepository(BoomRouter())
    # 审计写入失败必须静默，不阻塞登录主路径
    repo.record(ctx(), provider="password", external_id="a", actor="u",
                ip="1.2.3.4", success=False, detail="x")


def test_ip_hash_is_per_tenant():
    assert _ip_hash("1.2.3.4", "tenant-a") != _ip_hash("1.2.3.4", "tenant-b")
