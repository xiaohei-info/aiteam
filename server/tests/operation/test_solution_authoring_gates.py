"""提交审核闸门：敏感项 + 群主 / 编排规则的确认（纯函数）。"""

from __future__ import annotations

import pytest

from operation_service.solution_authoring_gates import (
    confirm_digest,
    evaluate_gates,
    required_confirmations,
)


def _expert(key: str, **extra) -> dict:
    return {"key": key, "skills": [], "mcps": [], **extra}


def _group(**extra) -> dict:
    return {
        "mode": "group", "coordinator_key": "lead", "orchestration_rules": "@{lead} 先拆解，@{worker} 执行",
        "experts": [_expert("lead"), _expert("worker")], **extra,
    }


def _solo(**extra) -> dict:
    return {"mode": "solo", "coordinator_key": "lead", "orchestration_rules": "", "experts": [_expert("lead")], **extra}


def _confirmed(package: dict, *items: str) -> dict:
    return {item: {"by": "op1", "at": "2026-11-17T00:00:00+00:00", "digest": confirm_digest(package, item)} for item in items}


def _by_key(gates) -> dict[str, tuple[bool, str]]:
    return {gate.key: (gate.ok, gate.message) for gate in gates}


def test_group_requires_coordinator_and_rules_and_solo_requires_neither():
    assert required_confirmations(_group()) == ["coordinator", "rules"]
    assert required_confirmations(_solo()) == []


def test_declared_skills_and_mcps_never_add_a_gate():
    package = _group()
    package["experts"][0]["skills"] = [{"skill_id": "s-1", "version": "1", "content_hash": "h", "reason": ""}]
    package["experts"][1]["mcps"] = [{"key": "mes", "display_name": "MES", "purpose": "", "required": True}]
    assert required_confirmations(package) == ["coordinator", "rules"]
    solo = _solo()
    solo["experts"][0]["mcps"] = package["experts"][1]["mcps"]
    assert required_confirmations(solo) == []


def test_legacy_package_without_mode_is_treated_by_expert_count():
    legacy = {"coordinator_key": "lead", "experts": [_expert("lead"), _expert("worker")]}
    assert required_confirmations(legacy) == ["coordinator", "rules"]
    assert required_confirmations({"coordinator_key": "lead", "experts": [_expert("lead")]}) == []


def test_everything_ok_when_confirmed_and_no_open_findings():
    package = _group()
    gates = evaluate_gates(package, _confirmed(package, "coordinator", "rules"), open_findings=0)
    assert all(gate.ok for gate in gates)
    assert [gate.key for gate in gates] == ["findings", "coordinator", "rules"]


def test_open_findings_block_with_a_count():
    package = _solo()
    gate = evaluate_gates(package, {}, open_findings=2)[0]
    assert (gate.key, gate.ok) == ("findings", False) and "2" in gate.message


def test_unconfirmed_items_block():
    result = _by_key(evaluate_gates(_group(), {}, open_findings=0))
    assert result["coordinator"][0] is False and "not been confirmed" in result["coordinator"][1]
    assert result["rules"][0] is False


def test_empty_rules_cannot_be_satisfied_by_a_confirmation():
    package = _group(orchestration_rules="")
    result = _by_key(evaluate_gates(package, _confirmed(package, "coordinator", "rules"), open_findings=0))
    assert result["rules"] == (False, "orchestration rules are required for a group solution")


@pytest.mark.parametrize(
    ("item", "edit"),
    [
        ("coordinator", lambda p: p.update(coordinator_key="worker")),
        ("rules", lambda p: p.update(orchestration_rules="@{worker} 先发言，@{lead} 汇总")),
    ],
)
def test_editing_the_confirmed_content_invalidates_the_confirmation(item, edit):
    package = _group()
    confirmations = _confirmed(package, "coordinator", "rules")
    edit(package)
    result = _by_key(evaluate_gates(package, confirmations, open_findings=0))
    assert result[item][0] is False and "changed" in result[item][1]
    other = "rules" if item == "coordinator" else "coordinator"
    assert result[other][0] is True


def test_editing_unrelated_text_keeps_confirmations():
    package = _group()
    confirmations = _confirmed(package, "coordinator", "rules")
    package["description"] = "改了描述"
    package["experts"][0]["system_prompt"] = "改了提示词"
    assert all(gate.ok for gate in evaluate_gates(package, confirmations, open_findings=0))
