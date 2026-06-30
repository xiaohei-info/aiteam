"""AuthProvider enum value guard (issue AITEAM-253).

Design rule (03 9.3): adding a login method = one new enum value + one Authenticator.
These must be additive — the original {password, phone, wechat} values are frozen by existing
code/tests; PASSKEY/OAUTH are the only additions.
"""

from __future__ import annotations

from shared.contracts.enums import AuthProvider


def test_core_provider_values_frozen():
    """Original provider values must not drift (used as external_id/auth_identity keys)."""
    values = {p.value for p in AuthProvider}
    assert {"password", "phone", "wechat"} <= values


def test_mfa_providers_added_additively():
    """PASSKEY and OAUTH added; total count grew by exactly 2 vs the original 3."""
    assert {p.value for p in AuthProvider} >= {"password", "phone", "wechat", "passkey", "oauth"}
    assert len(AuthProvider) == 5


def test_provider_values_are_unique_strings():
    values = [p.value for p in AuthProvider]
    assert len(values) == len(set(values))
    for p in AuthProvider:
        assert isinstance(p.value, str) and p.value == p.value.lower()
