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
    children: list["OrgTreeNode"] = Field(default_factory=list)


class OrgAssignmentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    department_id: str


OrgTreeNode.model_rebuild()
