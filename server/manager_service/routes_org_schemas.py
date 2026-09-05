"""Org 路由 Pydantic schema（P07）。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class OrgTreeNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    type: str
    name: str
    parent_id: str | None = None
    status: str | None = None
    role_title: str | None = Field(default=None, min_length=1, max_length=100, description="员工真实岗位（非账号权限角色）；部门节点或未设置时为 null。同一员工可在多个部门出现，以 employee 节点 id 调整归属。", examples=["研究分析师", None])
    children: list["OrgTreeNode"] = Field(default_factory=list)


class OrgAssignmentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    department_id: str


OrgTreeNode.model_rebuild()
