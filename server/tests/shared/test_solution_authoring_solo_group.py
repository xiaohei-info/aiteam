"""方案类型（单人 / 组群）、编排规则成员引用与专家能力声明。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from shared.solution_authoring.orchestration import (
    OrchestrationRefError,
    referenced_members,
    rewrite_member_refs,
)
from shared.solution_authoring.schemas import GeneratedSolution


def _expert(key: str, **extra) -> dict:
    return {
        "key": key, "display_name": f"专家{key}", "category": "质量管理", "description": "负责检验。",
        "system_prompt": "你是专家。", "evidence": [], **extra,
    }


def _solution(keys: list[str], **extra) -> dict:
    return {
        "display_name": "方案", "description": "描述。", "coordinator_key": keys[0],
        "experts": [_expert(key) for key in keys], **extra,
    }


# ---- 类型 ----

def test_mode_is_inferred_for_drafts_generated_before_modes_existed():
    assert GeneratedSolution.model_validate(_solution(["lead"])).mode == "solo"
    assert GeneratedSolution.model_validate(_solution(["lead", "worker"])).mode == "group"
    # 旧草稿没有规则：能读、能编辑；是否允许提交审核由宿主闸门决定。
    assert GeneratedSolution.model_validate(_solution(["lead", "worker"])).orchestration_rules == ""


def test_solo_has_exactly_one_expert_and_no_rules():
    assert GeneratedSolution.model_validate(_solution(["lead"], mode="solo")).coordinator_key == "lead"
    with pytest.raises(ValidationError, match="exactly one expert"):
        GeneratedSolution.model_validate(_solution(["lead", "worker"], mode="solo"))
    with pytest.raises(ValidationError, match="orchestration_rules"):
        GeneratedSolution.model_validate(_solution(["lead"], mode="solo", orchestration_rules="@{lead} 先发言"))


def test_group_needs_at_least_two_experts():
    with pytest.raises(ValidationError, match="at least two experts"):
        GeneratedSolution.model_validate(_solution(["lead"], mode="group"))


def test_rules_may_only_reference_experts_of_the_solution():
    rules = "1. @{lead} 先拆解\n2. @{worker} 执行"
    assert GeneratedSolution.model_validate(_solution(["lead", "worker"], orchestration_rules=rules)).orchestration_rules == rules
    with pytest.raises(ValidationError, match="outside this solution"):
        GeneratedSolution.model_validate(_solution(["lead", "worker"], orchestration_rules="@{ghost} 发言"))
    with pytest.raises(ValidationError, match="Malformed"):
        GeneratedSolution.model_validate(_solution(["lead", "worker"], orchestration_rules="@{lead 发言"))


# ---- 能力声明 ----

def test_skill_and_mcp_declarations_are_validated():
    solution = GeneratedSolution.model_validate(_solution(["lead"], mode="solo") | {
        "experts": [_expert(
            "lead",
            skills=[{"skill_id": "s-1", "version": "1.0.0", "content_hash": "sha256:a", "reason": "检验规程"}],
            mcps=[{"key": "mes", "display_name": "MES 连接器", "purpose": "读取工单", "required": True}],
        )],
    })
    expert = solution.experts[0]
    assert expert.skills[0].skill_id == "s-1"
    assert expert.mcps[0].required is True


@pytest.mark.parametrize("key", ["MES", "1mes", "has space", "x" * 65, ""])
def test_mcp_key_must_be_a_connector_id(key):
    with pytest.raises(ValidationError):
        GeneratedSolution.model_validate(_solution(["lead"], mode="solo") | {
            "experts": [_expert("lead", mcps=[{"key": key, "display_name": "x", "purpose": "y", "required": False}])],
        })


def test_duplicate_skill_or_mcp_within_an_expert_is_rejected():
    skill = {"skill_id": "s-1", "version": "1", "content_hash": "h", "reason": "r"}
    with pytest.raises(ValidationError, match="duplicate skill"):
        GeneratedSolution.model_validate(_solution(["lead"], mode="solo") | {"experts": [_expert("lead", skills=[skill, skill])]})
    mcp = {"key": "mes", "display_name": "x", "purpose": "y", "required": False}
    with pytest.raises(ValidationError, match="duplicate mcp"):
        GeneratedSolution.model_validate(_solution(["lead"], mode="solo") | {"experts": [_expert("lead", mcps=[mcp, mcp])]})


# ---- 成员引用 ----

def test_referenced_members_lists_each_reference_once():
    assert referenced_members("@{a} 先 @{b}，再 @{a}") == ["a", "b"]
    assert referenced_members("没有引用") == []


def test_rewrite_member_refs_swaps_every_reference():
    assert rewrite_member_refs("@{lead} 派给 @{worker}；@{lead} 汇总", {"lead": "t-1", "worker": "t-2"}) == "@{t-1} 派给 @{t-2}；@{t-1} 汇总"


def test_rewrite_does_not_cascade_when_ids_collide_with_keys():
    # 换算是一次性的：key `a` → `b`、key `b` → `c` 不能被连续换成 `c`。
    assert rewrite_member_refs("@{a} @{b}", {"a": "b", "b": "c"}) == "@{b} @{c}"


def test_rewrite_fails_loudly_on_unmapped_or_malformed_references():
    with pytest.raises(OrchestrationRefError, match="ghost"):
        rewrite_member_refs("@{ghost} 发言", {"lead": "t-1"})
    with pytest.raises(OrchestrationRefError, match="Malformed"):
        rewrite_member_refs("@{lead 发言", {"lead": "t-1"})
