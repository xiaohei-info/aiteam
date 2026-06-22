"""shared.security scrypt hash 验收（从 manager_service 平移后行为一致）。

确认 hash_password/verify_password 往返、错误格式拒绝、常量时间比较（不深测时序，验功能）。
"""

from shared.security import hash_password, verify_password


def test_hash_and_verify_roundtrip():
    h = hash_password("s3cret-pass")
    assert h.startswith("scrypt$")
    assert verify_password("s3cret-pass", h) is True


def test_verify_wrong_password():
    h = hash_password("correct")
    assert verify_password("wrong", h) is False


def test_hash_unique_per_call():
    # 随机 salt → 同密码两次 hash 不同
    assert hash_password("same") != hash_password("same")


def test_verify_rejects_malformed_stored():
    assert verify_password("x", "not-a-valid-format") is False
    assert verify_password("x", "bcrypt$wrong$scheme") is False
