"""敏感信息规则扫描与草稿内容替换。"""

from __future__ import annotations

import pytest

from shared.solution_authoring.sensitive_scan import (
    REDACTION_PLACEHOLDER,
    fields_containing,
    fingerprint,
    mask,
    redact_solution,
    scan_solution,
    scan_text,
)


def _luhn_complete(prefix: str) -> str:
    for digit in "0123456789":
        candidate = prefix + digit
        total = 0
        for index, char in enumerate(reversed(candidate)):
            value = int(char)
            if index % 2 == 1:
                value = value * 2 - 9 if value * 2 > 9 else value * 2
            total += value
        if total % 10 == 0:
            return candidate
    raise AssertionError("unreachable")


VALID_CARD = _luhn_complete("622202123456789012")


def _kinds(text: str) -> list[tuple[str, str]]:
    return [(match.kind, match.excerpt) for match in scan_text("f", text)]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("联系电话 13800138000。", [("phone", "13800138000")]),
        ("座机 010-62345678", [("phone", "010-62345678")]),
        ("发邮件到 zhang.san@example.com.cn 咨询", [("email", "zhang.san@example.com.cn")]),
        ("身份证 110101199003074514 已登记", [("id_card", "110101199003074514")]),
        (f"卡号 {VALID_CARD}", [("bank_card", VALID_CARD)]),
        ("合同金额 ¥1,200,000 元", [("amount", "¥1,200,000 元")]),
        ("预算约 350万元", [("amount", "350万元")]),
        ("api_key = sk-abcdefghijklmnop1234", [("secret", "api_key = sk-abcdefghijklmnop1234")]),
        ("密码：Passw0rd!x", [("secret", "密码：Passw0rd!x")]),
        ("供应商为华东精密制造有限公司", [("company", "供应商为华东精密制造有限公司")]),
    ],
)
def test_rules_detect_each_kind(text, expected):
    assert _kinds(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "订单号 1234567890123456",  # 16 位但 Luhn 不通过，不当银行卡
        "共 12 个步骤，耗时 3 天",
        "版本 2024.10.01",
        "来料检验专家负责外观与尺寸检验",
    ],
)
def test_rules_ignore_ordinary_text(text):
    assert _kinds(text) == []


def test_overlapping_matches_keep_the_higher_priority_rule():
    # 18 位身份证号不应再被银行卡 / 电话规则重复命中。
    assert [kind for kind, _ in _kinds("证件 110101199003074514")] == ["id_card"]


def test_matches_are_sorted_and_carry_mask_and_fingerprint():
    matches = scan_text("description", "邮箱 a@b.com，电话 13800138000")
    assert [match.kind for match in matches] == ["email", "phone"]
    phone = matches[1]
    assert phone.field_path == "description"
    assert phone.masked == "1********0" and "3800" not in phone.masked
    assert phone.fingerprint == fingerprint("phone", "13800138000")
    assert "邮箱 a@b.com，电话 13800138000"[phone.start:phone.end] == "13800138000"


def test_mask_hides_short_values_entirely():
    assert mask("ab") == "**" and mask("") == ""
    assert mask("abc") == "a*c"


def _solution() -> dict:
    return {
        "display_name": "质检方案",
        "description": "联系 13800138000",
        "tags": ["质检", "13800138000"],
        "coordinator_key": "lead",
        "coordinator_instructions": "",
        "output_requirements": "报告发 qa@example.com",
        "experts": [
            {"key": "lead", "display_name": "质检主管", "category": "质量", "description": "统筹", "system_prompt": "有问题打 13800138000"},
        ],
    }


def test_scan_solution_covers_every_published_text_field():
    found = {(match.field_path, match.kind) for match in scan_solution(_solution())}
    assert found == {
        ("description", "phone"),
        ("tags[1]", "phone"),
        ("output_requirements", "email"),
        ("experts[0].system_prompt", "phone"),
    }


def test_fields_containing_and_redact_replace_every_occurrence():
    solution = _solution()
    assert fields_containing(solution, "13800138000") == ["description", "tags[1]", "experts[0].system_prompt"]
    assert redact_solution(solution, "13800138000") == 3
    assert solution["description"] == f"联系 {REDACTION_PLACEHOLDER}"
    assert solution["tags"][1] == REDACTION_PLACEHOLDER
    assert solution["experts"][0]["system_prompt"] == f"有问题打 {REDACTION_PLACEHOLDER}"
    assert fields_containing(solution, "13800138000") == []
    assert solution["coordinator_key"] == "lead"  # 标识字段不参与替换
    assert [match.kind for match in scan_solution(solution)] == ["email"]


def test_redact_with_custom_replacement_and_empty_excerpt():
    solution = _solution()
    assert redact_solution(solution, "") == 0 and fields_containing(solution, "") == []
    assert redact_solution(solution, "qa@example.com", "") == 1
    assert solution["output_requirements"] == "报告发 "


def test_scan_tolerates_malformed_solution_shapes():
    assert scan_solution({"experts": ["oops", {"system_prompt": 3}], "tags": "x", "description": None}) == []
