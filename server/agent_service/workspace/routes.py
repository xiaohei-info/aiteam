"""workspace 路由——工作台/市场/办公室/知识库/上传/组织树。

薄路由层：负责 HTTP 契约映射，业务编排委托给 WorkspaceService。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.envelope import Envelope, ListEnvelope

from .service import WorkspaceService


# ---- P02 工作台 ----

class WorkbenchEmployee(BaseModel):
    model_config = ConfigDict(extra="forbid")
    employee_id: str
    display_name: str
    status: str = "offline"
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


class KnowledgeBaseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1)
    description: str = ""


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
    type: str
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


# ---- 路由构建 ----

def _map_template(t) -> MarketTemplateOut:
    return MarketTemplateOut(
        template_id=t.template_id,
        display_name=t.display_name,
        category=t.category,
        model_name=t.model_name,
        skills_count=t.skills_count,
        recruit_count=t.recruit_count,
        is_recruited=t.is_recruited,
        tags=t.tags,
        avatar_url=t.avatar_url,
    )


def _map_template_detail(t) -> MarketTemplateDetail:
    return MarketTemplateDetail(
        template_id=t.template_id,
        display_name=t.display_name,
        category=t.category,
        model_name=t.model_name,
        skills_count=t.skills_count,
        recruit_count=t.recruit_count,
        is_recruited=t.is_recruited,
        tags=t.tags,
        avatar_url=t.avatar_url,
        persona=t.persona,
        skills=t.skills,
        knowledge_bases=t.knowledge_bases,
        initial_memories=t.initial_memories,
        rating=t.rating,
    )


def build_workspace_router(service: WorkspaceService) -> APIRouter:
    router = APIRouter(prefix="/api/agent", tags=["agent", "workspace"])

    # ---- P02 工作台 ----

    @router.get("/workbench", summary="工作台视图", operation_id="agent_workbench")
    async def get_workbench(request: Request) -> Envelope[WorkbenchOut]:
        view = service.get_workbench()
        return Envelope(data=WorkbenchOut(
            employees=[
                WorkbenchEmployee(
                    employee_id=e.employee_id,
                    display_name=e.display_name,
                    status=e.status,
                    last_msg_preview=e.last_msg_preview,
                    unread_count=e.unread_count,
                    last_active_at=e.last_active_at,
                    is_starred=e.is_starred,
                )
                for e in view.employees
            ],
            total_unread=view.total_unread,
        ))

    @router.post("/workbench/state", summary="更新工作台偏好", operation_id="agent_workbench_state")
    async def update_workbench_state(
        body: WorkbenchStateIn,
        request: Request,
    ) -> dict:
        service.update_workbench_state(
            employee_id=body.employee_id,
            is_starred=body.is_starred,
            last_read_msg_id=body.last_read_msg_id,
        )
        return {"updated": True, "employee_id": body.employee_id}

    # ---- P03 人才市场 ----

    @router.get("/marketplace/templates", summary="人才市场列表", operation_id="agent_marketplace_list")
    async def list_marketplace(
        request: Request,
        category: str | None = Query(default=None),
        keyword: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
    ) -> ListEnvelope[MarketTemplateOut]:
        templates = service.list_marketplace(category=category, keyword=keyword)
        return ListEnvelope(data=[_map_template(t) for t in templates])

    @router.get("/marketplace/templates/{template_id}", summary="专家详情", operation_id="agent_marketplace_detail")
    async def get_marketplace_detail(
        template_id: str,
        request: Request,
    ) -> Envelope[MarketTemplateDetail]:
        t = service.get_marketplace_detail(template_id)
        if t is None:
            return Envelope(data=MarketTemplateDetail(template_id=template_id, display_name=""))
        return Envelope(data=_map_template_detail(t))

    @router.post("/recruitments", summary="招募专家", operation_id="agent_recruit")
    async def recruit(
        body: RecruitRequest,
        request: Request,
    ) -> Envelope[RecruitResult]:
        result = service.recruit(body.template_id)
        return Envelope(data=RecruitResult(
            success=result.success,
            employee_id=result.employee_id,
            message=result.message,
        ))

    # ---- P09 办公室动态 ----

    @router.get("/office/scene", summary="办公室场景", operation_id="agent_office_scene")
    async def office_scene(request: Request) -> Envelope[OfficeSceneOut]:
        scene = service.get_office_scene()
        return Envelope(data=OfficeSceneOut(employees=scene.employees, summary=scene.summary))

    @router.get("/office/feed", summary="办公室动态", operation_id="agent_office_feed")
    async def office_feed(request: Request) -> Envelope[OfficeFeedOut]:
        feed = service.get_office_feed()
        return Envelope(data=OfficeFeedOut(events=feed.events))

    # ---- P08 知识库 ----

    @router.post("/knowledge-bases", summary="创建知识库", operation_id="agent_knowledge_base_create")
    async def create_knowledge_base(
        body: KnowledgeBaseCreate,
        request: Request,
    ) -> Envelope[KnowledgeBaseOut]:
        kb = service.create_knowledge_base(name=body.name, description=body.description)
        return Envelope(data=KnowledgeBaseOut(
            kb_id=kb.kb_id, name=kb.name, description=kb.description,
            doc_count=kb.doc_count, size_kb=kb.size_kb,
            source_type=kb.source_type, sync_status=kb.sync_status,
        ))

    @router.get("/knowledge-bases", summary="知识库列表", operation_id="agent_knowledge_base_list")
    async def list_knowledge_bases(request: Request) -> ListEnvelope[KnowledgeBaseOut]:
        kbs = service.list_knowledge_bases()
        return ListEnvelope(data=[
            KnowledgeBaseOut(
                kb_id=k.kb_id, name=k.name, description=k.description,
                doc_count=k.doc_count, size_kb=k.size_kb,
                source_type=k.source_type, sync_status=k.sync_status,
            )
            for k in kbs
        ])

    @router.get("/knowledge-bases/{kb_id}/search", summary="知识库搜索", operation_id="agent_knowledge_search")
    async def knowledge_search(
        kb_id: str,
        request: Request,
        q: str = Query(..., min_length=1),
        top_k: int = Query(default=5, ge=1, le=20),
    ) -> ListEnvelope[KnowledgeSearchResult]:
        docs = service.search_knowledge(kb_id, q, top_k)
        return ListEnvelope(data=[
            KnowledgeSearchResult(doc_id=d.doc_id, title=d.title, snippet=d.snippet, score=0.0)
            for d in docs
        ])

    @router.post("/knowledge-bases/{kb_id}/documents", summary="上传知识文档", operation_id="agent_knowledge_document_upload")
    async def upload_document(
        kb_id: str,
        request: Request,
        file: UploadFile = File(...),
    ) -> dict:
        content = await file.read()
        doc = service.upload_document(
            kb_id=kb_id,
            filename=file.filename or "unknown",
            content=content,
            content_type=file.content_type or "text/plain",
        )
        return {
            "kb_id": kb_id,
            "doc_id": doc.doc_id,
            "filename": file.filename,
            "size": file.size,
            "status": "uploaded",
        }

    # ---- P07 组织树 ----

    @router.get("/org/tree", summary="组织树(本地投影)", operation_id="agent_org_tree")
    async def org_tree(request: Request) -> Envelope[OrgTreeNode]:
        node = service.get_org_tree()

        def _convert(n) -> OrgTreeNode:
            return OrgTreeNode(
                id=n.id, type=n.type, name=n.name,
                parent_id=n.parent_id, status=n.status,
                children=[_convert(c) for c in n.children],
            )

        return Envelope(data=_convert(node))

    # ---- 文件上传 ----

    @router.post("/uploads", summary="文件上传", operation_id="agent_upload")
    async def upload_file(
        request: Request,
        file: UploadFile = File(...),
    ) -> Envelope[UploadResult]:
        content = await file.read()
        asset = service.upload_file(
            filename=file.filename or "unknown",
            content=content,
            content_type=file.content_type or "application/octet-stream",
        )
        return Envelope(data=UploadResult(
            asset_id=asset.asset_id,
            filename=asset.filename,
            size=asset.size,
            url=f"/api/agent/uploads/{asset.asset_id}",
            content_type=asset.content_type,
        ))

    return router
