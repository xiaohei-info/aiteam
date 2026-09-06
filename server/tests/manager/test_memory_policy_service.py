import pytest
from manager_service.memory_policy_service import normalize_policy, merge_policy, require_retention_ready, MemoryRetentionUnverified
from shared.errors import ValidationProblem


def test_presence_empty_operations_and_explicit_auto_consent():
    assert normalize_policy(None)["allowed_operations"] == ["recall"]
    assert normalize_policy({"enabled": True})["explicit_auto_retain"] is False
    assert normalize_policy({"allowed_operations": []})["allowed_operations"] == []
    assert normalize_policy({"allowed_operations": ["retain"]})["explicit_auto_retain"] is False
    assert normalize_policy({"allowed_operations": ["retain"], "explicit_auto_retain": True})["explicit_auto_retain"] is True
    assert normalize_policy({"enabled": False, "explicit_auto_retain": True})["allowed_operations"] == []


def test_field_patch_preserves_retention_and_requires_explicit_reset():
    current = normalize_policy({"allowed_operations": ["recall", "retain"], "retention_days": 7})
    changed = merge_policy(current, {"allowed_operations": []})
    assert changed["retention_days"] == 7 and changed["allowed_operations"] == []
    assert merge_policy(changed, {}) == changed
    assert merge_policy(changed, {"retention_days": None})["retention_days"] is None
    assert merge_policy(changed, {"operations": ["recall"]})["allowed_operations"] == ["recall"]


@pytest.mark.parametrize("patch", [{"allowed_operations": ["delete"]}, {"scope": "tenant"}, {"enabled": "true"}, {"retention_days": 0}, {"bank": "other"}])
def test_invalid_policy_never_grants(patch):
    with pytest.raises(ValidationProblem):
        merge_policy(normalize_policy(None), patch)


@pytest.mark.parametrize("retention", [1, 365, "unknown", -1])
def test_unverified_finite_retention_is_never_unlimited(retention):
    value = normalize_policy({"retention_days": retention})
    with pytest.raises(MemoryRetentionUnverified):
        require_retention_ready(value)
