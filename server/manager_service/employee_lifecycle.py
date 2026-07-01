"""employee 生命周期状态机（issue #281，领域 §5.1）。

纯函数式状态校验：给定当前状态，判定某个 transition 是否允许、落地后的目标状态。
持久化与 tenant 隔离在 repository/service 层；本文件只负责流转规则，便于单测。

流转口径：
    draft → provisioning → active ⇄ paused → archived
                    ↓
            provisioning_failed（可 retry_provision 回 provisioning）
    active / paused / provisioning / provisioning_failed 均可 archive（终态）。
"""

from __future__ import annotations

from shared.contracts.enums import EmployeeStatus
from shared.errors import Conflict


# 单源真值：允许的 (from_status, transition) → to_status 映射。
_TRANSITIONS: dict[tuple[EmployeeStatus, str], EmployeeStatus] = {
    # 创建后 initial 推进
    (EmployeeStatus.DRAFT, "provision"): EmployeeStatus.PROVISIONING,
    # 配置齐全可以直接激活（跳过 provisioning 的骨架路径）
    (EmployeeStatus.DRAFT, "activate"): EmployeeStatus.ACTIVE,
    # provisioning 成功；或失败落入 provisioning_failed
    (EmployeeStatus.PROVISIONING, "activate"): EmployeeStatus.ACTIVE,
    (EmployeeStatus.PROVISIONING, "mark_provisioning_failed"): EmployeeStatus.PROVISIONING_FAILED,
    # provisioning_failed 可重试回 provisioning
    (EmployeeStatus.PROVISIONING_FAILED, "retry_provision"): EmployeeStatus.PROVISIONING,
    # active ⇄ paused
    (EmployeeStatus.ACTIVE, "pause"): EmployeeStatus.PAUSED,
    (EmployeeStatus.PAUSED, "resume"): EmployeeStatus.ACTIVE,
    # archive 为终态：任意非 archived 状态均可归档
    (EmployeeStatus.DRAFT, "archive"): EmployeeStatus.ARCHIVED,
    (EmployeeStatus.PROVISIONING, "archive"): EmployeeStatus.ARCHIVED,
    (EmployeeStatus.PROVISIONING_FAILED, "archive"): EmployeeStatus.ARCHIVED,
    (EmployeeStatus.ACTIVE, "archive"): EmployeeStatus.ARCHIVED,
    (EmployeeStatus.PAUSED, "archive"): EmployeeStatus.ARCHIVED,
}

# archive 操作的来源状态集合（便于 service 层判定 + 测试断言）。
# 对外暴露的人类可读 transition 列表（UI 展示 + 可用 transitions API）。
# 顺序即推荐UI排序。
ALLOWED_TRANSITION_LABELS = [
    "provision",
    "activate",
    "pause",
    "resume",
    "archive",
    "retry_provision",
    "mark_provisioning_failed",
]

ARCHIVE_FROM_STATUSES = {
    EmployeeStatus.DRAFT,
    EmployeeStatus.PROVISIONING,
    EmployeeStatus.PROVISIONING_FAILED,
    EmployeeStatus.ACTIVE,
    EmployeeStatus.PAUSED,
}


def can_transition(from_status: EmployeeStatus, transition: str) -> bool:
    """whether `transition` is allowed from `from_status`."""
    if from_status == EmployeeStatus.ARCHIVED:
        return False  # archived is terminal
    if transition == "archive":
        return from_status in ARCHIVE_FROM_STATUSES
    return (from_status, transition) in _TRANSITIONS


def target_status(from_status: EmployeeStatus, transition: str) -> EmployeeStatus:
    """return the post-transition status, or raise Conflict if disallowed."""
    if from_status == EmployeeStatus.ARCHIVED:
        raise Conflict(f"employee is archived; no further transitions allowed")
    if transition == "archive":
        if from_status not in ARCHIVE_FROM_STATUSES:
            raise Conflict(f"cannot archive from status={from_status.value}")
        return EmployeeStatus.ARCHIVED
    key = (from_status, transition)
    if key not in _TRANSITIONS:
        raise Conflict(
            f"transition '{transition}' not allowed from status={from_status.value}"
        )
    return _TRANSITIONS[key]


def is_runnable(status: EmployeeStatus) -> bool:
    """是否可接新 run（仅 active 可运行）。"""
    return status == EmployeeStatus.ACTIVE


def is_provisionable(status: EmployeeStatus) -> bool:
    """是否允许发起 provision（draft 或 provisioning_failed 可重试）。"""
    return status in (EmployeeStatus.DRAFT, EmployeeStatus.PROVISIONING_FAILED)


def can_write_config(status: EmployeeStatus) -> bool:
    """配置可改写状态（archived 落地后不可改；可由 service 另行 enforce）。"""
    return status != EmployeeStatus.ARCHIVED
