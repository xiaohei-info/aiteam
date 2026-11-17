"""行业文档生成：提交审核闸门（纯函数，无 I/O，可在草稿行锁内调用）。

闸门有两类：敏感项全部处理；以及运营对「群主 / 群聊编排规则」的显式确认。
skill / MCP 属于 Agent 能力，只作推荐提示，不进闸门。
确认记录里存的是被确认内容的摘要（digest），闸门拿它与当前正文比对：相关内容一旦被编辑，确认自动失效，
不需要在每个编辑入口去手动清除，也不会因为改了无关文字（描述、提示词）而误作废。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

CONFIRM_ITEMS = ("coordinator", "rules")


@dataclass(frozen=True)
class Gate:
    key: str
    ok: bool
    message: str = ""


def _mode(package: Mapping[str, Any]) -> str:
    # 旧草稿没有 mode：按专家数推断，与 `GeneratedSolution` 的兼容规则一致。
    return str(package.get("mode") or ("solo" if len(package.get("experts", [])) == 1 else "group"))


def _subject(package: Mapping[str, Any], item: str) -> Any:
    if item == "coordinator":
        return [_mode(package), package.get("coordinator_key", "")]
    return str(package.get("orchestration_rules", "")).strip()


def confirm_digest(package: Mapping[str, Any], item: str) -> str:
    canonical = json.dumps(_subject(package, item), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(f"{item}\x00{canonical}".encode()).hexdigest()[:16]


def required_confirmations(package: Mapping[str, Any]) -> list[str]:
    """需要运营确认的项：组群要确认群主与规则；单人方案没有。"""
    return ["coordinator", "rules"] if _mode(package) == "group" else []


def _confirmation_gate(package: Mapping[str, Any], confirmations: Mapping[str, Any], item: str) -> Gate:
    if item == "rules" and not str(package.get("orchestration_rules", "")).strip():
        return Gate(item, False, "orchestration rules are required for a group solution")
    record = confirmations.get(item)
    if not record:
        return Gate(item, False, f"{item} has not been confirmed")
    if record.get("digest") != confirm_digest(package, item):
        return Gate(item, False, f"{item} changed after it was confirmed; confirm it again")
    return Gate(item, True)


def evaluate_gates(package: Mapping[str, Any], confirmations: Mapping[str, Any], *, open_findings: int) -> list[Gate]:
    gates = [Gate("findings", open_findings == 0, f"{open_findings} open finding(s) must be resolved" if open_findings else "")]
    gates.extend(_confirmation_gate(package, confirmations, item) for item in required_confirmations(package))
    return gates
