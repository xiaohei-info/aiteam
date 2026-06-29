"""Manager 企业端组织架构路由（P07 配置态 / B01 部门分配）。

边界：Manager 管理组织树（配置态），Agent 端只做本地投影展示。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import require_claims, tenant_context_from
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope


class OrgTreeNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: str  # department | employee
    name: str
    parent_id: str | None = None
    status: str | None = None
    children: list["OrgTreeNode"] = Field(default_factory=list)


class OrgAssignmentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    department_id: str


OrgTreeNode.model_rebuild()


def build_org_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/manager/org", tags=["manager", "org"])
    require = require_claims(verifier)

    @router.get("/tree", summary="获取组织树", operation_id="manager_org_tree")
    async def get_org_tree(claims: TokenClaims = Depends(require)) -> Envelope[OrgTreeNode]:
        ctx = tenant_context_from(claims)
        # 重构阶段返回空树；真实数据由 department + member + employee 构建
        root = OrgTreeNode(id="root", type="department", name="企业", parent_id=None)
        return Envelope(data=root)

    @router.patch("/assignments/{assignment_id}", summary="调整员工部门", operation_id="manager_org_assignment_patch")
    async def patch_assignment(
        assignment_id: str,
        body: OrgAssignmentPatch,
        claims: TokenClaims = Depends(require),
    ) -> dict:
        tenant_context_from(claims)
        return {"assignment_id": assignment_id, "department_id": body.department_id, "updated": True}

    return router
