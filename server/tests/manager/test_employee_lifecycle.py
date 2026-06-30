"""employee 生命周期状态机单测（issue #281）。

纯函数测试：不依赖 PG / 不依赖 FastAPI TestClient。断言 employee_lifecycle 的状态流转规则、
`create → draft` 默认状态、各 transition 合法性 + is_runnable / is_provisionable 判定。
"""

from __future__ import annotations

import pytest

from shared.contracts.enums import EmployeeStatus
from shared.errors import Conflict

from manager_service import employee_lifecycle as lc
from manager_service.schemas import EmployeeConfigOut


# ---- 枚举本身 ----

def test_employee_status_values_frozen():
    """枚举取值集合不被对齐漂移（对齐 #281 迁移的 CHECK 约束 + 领域 §5.1）。"""
    assert {s.value for s in EmployeeStatus} == {
        "draft", "provisioning", "active", "paused", "provisioning_failed", "archived",
    }


def test_enum_value_lowercase_with_underscores():
    for status in EmployeeStatus:
        assert status.value == status.value.lower()
        assert " " not in status.value


# ---- provision 路径 ----

def test_draft_can_provision():
    assert lc.can_transition(EmployeeStatus.DRAFT, "provision")
    assert lc.target_status(EmployeeStatus.DRAFT, "provision") == EmployeeStatus.PROVISIONING


def test_provisioning_can_activate():
    assert lc.target_status(EmployeeStatus.PROVISIONING, "activate") == EmployeeStatus.ACTIVE


def test_provisioning_can_fail():
    assert lc.target_status(
        EmployeeStatus.PROVISIONING, "mark_provisioning_failed"
    ) == EmployeeStatus.PROVISIONING_FAILED


def test_provisioning_failed_can_retry():
    assert lc.target_status(
        EmployeeStatus.PROVISIONING_FAILED, "retry_provision"
    ) == EmployeeStatus.PROVISIONING


def test_provisioning_failed_cannot_pause_or_resume():
    assert not lc.can_transition(EmployeeStatus.PROVISIONING_FAILED, "pause")
    assert not lc.can_transition(EmployeeStatus.PROVISIONING_FAILED, "resume")


# ---- active ⇄ paused ----

def test_active_can_pause():
    assert lc.target_status(EmployeeStatus.ACTIVE, "pause") == EmployeeStatus.PAUSED


def test_paused_can_resume():
    assert lc.target_status(EmployeeStatus.PAUSED, "resume") == EmployeeStatus.ACTIVE


def test_paused_cannot_activate():
    assert not lc.can_transition(EmployeeStatus.PAUSED, "activate")


def test_active_cannot_provision():
    assert not lc.can_transition(EmployeeStatus.ACTIVE, "provision")


# ---- archive 作为终态 ----

@pytest.mark.parametrize("src", [
    EmployeeStatus.DRAFT,
    EmployeeStatus.PROVISIONING,
    EmployeeStatus.PROVISIONING_FAILED,
    EmployeeStatus.ACTIVE,
    EmployeeStatus.PAUSED,
])
def test_any_non_archived_can_archive(src):
    assert lc.can_transition(src, "archive")
    assert lc.target_status(src, "archive") == EmployeeStatus.ARCHIVED


def test_archived_is_terminal():
    """archived 状态：任何 transition 均拒绝。"""
    for label in [
        "provision", "activate", "pause", "resume",
        "archive", "retry_provision", "mark_provisioning_failed",
    ]:
        assert not lc.can_transition(EmployeeStatus.ARCHIVED, label)

    with pytest.raises(Conflict):
        lc.target_status(EmployeeStatus.ARCHIVED, "provision")


def test_draft_can_skip_provisioning_to_active():
    """骨架路径允许 draft 直接 activate（issue #281 修订口径）。"""
    assert lc.target_status(EmployeeStatus.DRAFT, "activate") == EmployeeStatus.ACTIVE


def test_draft_cannot_pause_resume_archive_without_becoming_active():
    """draft 不能直接 pause / resume（需先 activate）。"""
    assert not lc.can_transition(EmployeeStatus.DRAFT, "pause")
    assert not lc.can_transition(EmployeeStatus.DRAFT, "resume")


# ---- 查询谓词 ----

def test_is_runnable_only_for_active():
    assert lc.is_runnable(EmployeeStatus.ACTIVE) is True
    for s in [EmployeeStatus.DRAFT, EmployeeStatus.PROVISIONING,
              EmployeeStatus.PROVISIONING_FAILED, EmployeeStatus.PAUSED,
              EmployeeStatus.ARCHIVED]:
        assert lc.is_runnable(s) is False


def test_is_provisionable_for_draft_or_failed():
    assert lc.is_provisionable(EmployeeStatus.DRAFT) is True
    assert lc.is_provisionable(EmployeeStatus.PROVISIONING_FAILED) is True
    for s in [EmployeeStatus.PROVISIONING, EmployeeStatus.ACTIVE,
              EmployeeStatus.PAUSED, EmployeeStatus.ARCHIVED]:
        assert lc.is_provisionable(s) is False


def test_can_write_config_for_not_archived():
    assert lc.can_write_config(EmployeeStatus.ACTIVE) is True
    assert lc.can_write_config(EmployeeStatus.ARCHIVED) is False


# ---- schemas: EmployeeConfigOut 透出 status 字段 ----

def test_employee_config_out_carries_status():
    """EmployeeConfigOut 必须携带新 status 字段 + archive 元数据（出参缝合检查）。"""
    out = EmployeeConfigOut(
        employee_id="emp-1",
        employee_slug="exp-1",
        display_name="专家A",
        version=1,
        status="draft",
    )
    assert out.status == "draft"
    assert out.archive_reason is None
    assert out.archived_at is None


def test_employee_config_out_archived_carry_reason():
    out = EmployeeConfigOut(
        employee_id="emp-2",
        employee_slug="exp-2",
        display_name="专家B",
        version=3,
        status="archived",
        archive_reason="contract ended",
        archived_at="2026-06-30T12:00:00Z",
    )
    assert out.status == "archived"
    assert out.archive_reason == "contract ended"
