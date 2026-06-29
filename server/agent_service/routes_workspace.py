"""Agent 用户端工作台 + 人才市场 + 办公室 + 知识库 + 文件上传路由。

边界：Agent 端全部本地执行；人才市场从 Manager pull 模板数据。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, Query, Request, UploadFile, File
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope


# ---- P02 工作台 ----

class WorkbenchEmployee(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    display_name: str
    status: str = "offline"  # online | busy | idle | offline
    last_msg_preview: str = ""
    unread_count: int = 0
    last_active_at: datetime | None = None
    is_starred: bool = False


class WorkbenchOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employees: list[WorkbenchEmployee] = Field(default_factory=list)
    total_unread: int = 0


class WorkbenchStateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    is_starred: bool | None = None
    last_read_msg_id: str | None = None


# ---- P03 人才市场 ----

class MarketTemplateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    template_id: str
    display_name: str
    category: str = ""
    model_name: str = ""
    skills_count: int = 0
    recruit_count: int = 0
    is_recruited: bool = False
    tags: list[str] = Field(default_factory=list)
    avatar_url: str | None = None


class MarketTemplateDetail(MarketTemplateOut):
    persona: str = ""
    skills: list[dict] = Field(default_factory=list)
    knowledge_bases: list[dict] = Field(default_factory=list)
    initial_memories: list[dict] = Field(default_factory=list)
    rating: float = 0.0


class RecruitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    template_id: str


class RecruitResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    success: bool
    employee_id: str | None = None
    message: str = ""


# ---- P09 办公室动态 ----

class OfficeSceneOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employees: list[dict] = Field(default_factory=list)
    summary: dict = Field(default_factory=dict)


class OfficeFeedOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: list[dict] = Field(default_factory=list)


# ---- P08 知识库 ----

class KnowledgeBaseOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kb_id: str
    name: str
    description: str = ""
    doc_count: int = 0
    size_kb: int = 0
    source_type: str = "upload"
    sync_status: str = "idle"


class KnowledgeSearchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doc_id: str
    title: str
    snippet: str
    score: float


# ---- P07 组织树 ----

class OrgTreeNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    type: str  # department | employee
    name: str
    parent_id: str | None = None
    status: str | None = None
    children: list["OrgTreeNode"] = Field(default_factory=list)


OrgTreeNode.model_rebuild()


# ---- 文件上传 ----

class UploadResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset_id: str
    filename: str
    size: int
    url: str
    content_type: str


def build_workspace_router(verifier) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent", "workspace"])

    # ---- P02 工作台 ----

    @router.get("/workbench", summary="工作台视图", operation_id="agent_workbench")
    async def get_workbench(request: Request) -> Envelope[WorkbenchOut]:
        return Envelope(data=WorkbenchOut())

    @router.post("/workbench/state", summary="更新工作台偏好", operation_id="agent_workbench_state")
    async def update_workbench_state(
        body: WorkbenchStateIn,
        request: Request,
    ) -> dict:
        return {"updated": True, "employee_id": body.employee_id}

    # ---- P03 人才市场 ----

    @router.get("/marketplace/templates", summary="人才市场列表", operation_id="agent_marketplace_list")
    async def list_marketplace(
        request: Request,
        category: str | None = Query(default=None),
        keyword: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
    ) -> ListEnvelope[MarketTemplateOut]:
        return ListEnvelope(data=[])

    @router.get("/marketplace/templates/{template_id}", summary="专家详情", operation_id="agent_marketplace_detail")
    async def get_marketplace_detail(
        template_id: str,
        request: Request,
    ) -> Envelope[MarketTemplateDetail]:
        return Envelope(data=MarketTemplateDetail(
            template_id=template_id,
            display_name="",
        ))

    @router.post("/recruitments", summary="招募专家", operation_id="agent_recruit")
    async def recruit(
        body: RecruitRequest,
        request: Request,
    ) -> Envelope[RecruitResult]:
        return Envelope(data=RecruitResult(
            success=True,
            employee_id=str(uuid4()),
            message="招募成功",
        ))

    # ---- P09 办公室动态 ----

    @router.get("/office/scene", summary="办公室场景", operation_id="agent_office_scene")
    async def office_scene(request: Request) -> Envelope[OfficeSceneOut]:
        return Envelope(data=OfficeSceneOut(
            summary={"total": 0, "working": 0, "ready": 0, "offline": 0},
        ))

    @router.get("/office/feed", summary="办公室动态", operation_id="agent_office_feed")
    async def office_feed(request: Request) -> Envelope[OfficeFeedOut]:
        return Envelope(data=OfficeFeedOut())

    # ---- P08 知识库 ----

    @router.get("/knowledge-bases", summary="知识库列表", operation_id="agent_knowledge_base_list")
    async def list_knowledge_bases(request: Request) -> ListEnvelope[KnowledgeBaseOut]:
        return ListEnvelope(data=[])

    @router.get("/knowledge-bases/{kb_id}/search", summary="知识库搜索", operation_id="agent_knowledge_search")
    async def knowledge_search(
        kb_id: str,
        request: Request,
        q: str = Query(..., min_length=1),
        top_k: int = Query(default=5, ge=1, le=20),
    ) -> ListEnvelope[KnowledgeSearchResult]:
        return ListEnvelope(data=[])

    @router.post("/knowledge-bases/{kb_id}/documents", summary="上传知识文档", operation_id="agent_knowledge_document_upload")
    async def upload_document(
        kb_id: str,
        request: Request,
        file: UploadFile = File(...),
    ) -> dict:
        return {
            "kb_id": kb_id,
            "filename": file.filename,
            "size": file.size,
            "status": "pending",
        }

    # ---- P07 组织树 ----

    @router.get("/org/tree", summary="组织树(本地投影)", operation_id="agent_org_tree")
    async def org_tree(request: Request) -> Envelope[OrgTreeNode]:
        return Envelope(data=OrgTreeNode(id="root", type="department", name="企业"))

    # ---- 文件上传 ----

    @router.post("/uploads", summary="文件上传", operation_id="agent_upload")
    async def upload_file(
        request: Request,
        file: UploadFile = File(...),
    ) -> Envelope[UploadResult]:
        now = datetime.now(timezone.utc)
        asset_id = str(uuid4())
        return Envelope(data=UploadResult(
            asset_id=asset_id,
            filename=file.filename or "unknown",
            size=file.size or 0,
            url=f"/api/agent/uploads/{asset_id}",
            content_type=file.content_type or "application/octet-stream",
        ))

    return router
