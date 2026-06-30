"""workspace 业务编排——工作台/人才市场/招募/办公室/知识库/上传/组织树。

Agent 只做本地数据面；人才市场模板从 Manager catalog pull 后本地缓存展示。
招募时创建本地 employee 投影条目（loaded_expert_projections）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .store import (
    KnowledgeBase,
    KnowledgeBaseRepository,
    KnowledgeDocument,
    KnowledgeDocumentRepository,
    UploadAsset,
    UploadAssetRepository,
    WorkbenchState,
    WorkbenchStateRepository,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


# ---- 市场模板（本地缓存） ----

@dataclass
class MarketTemplate:
    template_id: str
    display_name: str
    category: str = ""
    model_name: str = ""
    skills_count: int = 0
    recruit_count: int = 0
    is_recruited: bool = False
    tags: list[str] = field(default_factory=list)
    avatar_url: str | None = None
    persona: str = ""
    skills: list[dict] = field(default_factory=list)
    knowledge_bases: list[dict] = field(default_factory=list)
    initial_memories: list[dict] = field(default_factory=list)
    rating: float = 0.0


# ---- 招募结果 ----

@dataclass
class RecruitResult:
    success: bool
    employee_id: str | None = None
    message: str = ""


# ---- 工作台视图 ----

@dataclass
class WorkbenchEmployeeView:
    employee_id: str
    display_name: str
    status: str = "offline"
    last_msg_preview: str = ""
    unread_count: int = 0
    last_active_at: datetime | None = None
    is_starred: bool = False


@dataclass
class WorkbenchView:
    employees: list[WorkbenchEmployeeView] = field(default_factory=list)
    total_unread: int = 0


# ---- 办公室 ----

@dataclass
class OfficeScene:
    employees: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


@dataclass
class OfficeFeed:
    events: list[dict] = field(default_factory=list)


# ---- 组织树 ----

@dataclass
class OrgTreeNode:
    id: str
    type: str
    name: str
    parent_id: str | None = None
    status: str | None = None
    children: list["OrgTreeNode"] = field(default_factory=list)


class WorkspaceService:
    """用户端 workspace 业务编排。

    依赖注入 grants 投影仓储（读已授权专家）与本地各仓储。
    市场模板通过 catalog pull 缓存到本地，招募写入 loaded_expert_projections。
    """

    def __init__(
        self,
        *,
        projections,          # ProjectionRepository (from grants)
        workbench_store: WorkbenchStateRepository,
        kb_store: KnowledgeBaseRepository,
        doc_store: KnowledgeDocumentRepository,
        upload_store: UploadAssetRepository,
        upload_dir: str | None = None,
    ) -> None:
        self._projections = projections
        self._workbench = workbench_store
        self._kb = kb_store
        self._docs = doc_store
        self._uploads = upload_store
        self._upload_dir = Path(upload_dir) if upload_dir else None
        # 市场模板本地缓存（由 sync_marketplace 填充）
        self._market_templates: dict[str, MarketTemplate] = {}

    # ---- P02 工作台 ----

    def get_workbench(self) -> WorkbenchView:
        """从已授权专家投影 + 本地偏好构建工作台视图。"""
        experts = self._projections.available()
        states = {s.employee_id: s for s in self._workbench.list_all()}
        employees: list[WorkbenchEmployeeView] = []
        total_unread = 0
        for e in experts:
            state = states.get(e.employee_id)
            employees.append(WorkbenchEmployeeView(
                employee_id=e.employee_id,
                display_name=e.display_name,
                is_starred=state.is_starred if state else False,
                unread_count=0,  # TODO: 跨模块读 mainline unread
            ))
            total_unread += 0  # TODO aggregate from mainline
        return WorkbenchView(employees=employees, total_unread=total_unread)

    def update_workbench_state(self, employee_id: str, is_starred: bool | None = None,
                               last_read_msg_id: str | None = None) -> WorkbenchState:
        existing = self._workbench.get(employee_id)
        state = WorkbenchState(
            employee_id=employee_id,
            is_starred=is_starred if is_starred is not None else (existing.is_starred if existing else False),
            last_read_msg_id=last_read_msg_id if last_read_msg_id is not None else (existing.last_read_msg_id if existing else None),
        )
        return self._workbench.upsert(state)

    # ---- P03 人才市场 ----

    def sync_marketplace(self, templates: list[MarketTemplate]) -> int:
        """批量刷新人才市场本地缓存（从 Manager catalog pull 结果填充）。"""
        for t in templates:
            self._market_templates[t.template_id] = t
        return len(templates)

    def list_marketplace(self, *, category: str | None = None,
                         keyword: str | None = None) -> list[MarketTemplate]:
        """列出人才市场模板（从本地缓存）。"""
        results = list(self._market_templates.values())
        if category:
            results = [t for t in results if t.category == category]
        if keyword:
            kw = keyword.lower()
            results = [t for t in results
                       if kw in t.display_name.lower()
                       or any(kw in tag.lower() for tag in t.tags)]
        return results

    def get_marketplace_detail(self, template_id: str) -> MarketTemplate | None:
        return self._market_templates.get(template_id)

    def recruit(self, template_id: str) -> RecruitResult:
        """从市场模板招募专家——创建本地 employee 投影。

        先在本地 projections 里查是否已招募（按 display_name 模糊匹配），
        已存在则返回既有 employee_id；否则新创建投影条目。
        """
        from shared.contracts.grants import LoadedExpertProjection

        template = self._market_templates.get(template_id)
        if template is None:
            return RecruitResult(success=False, message=f"模板不存在: {template_id}")

        # 检查是否已招募：已有同 display_name 的投影即为已招募
        for p in self._projections.list_all():
            if p.display_name == template.display_name and not p.revoked:
                return RecruitResult(
                    success=True,
                    employee_id=p.employee_id,
                    message="该专家已招募",
                )

        # 创建新 employee 投影
        employee_id = str(uuid4())
        projection = LoadedExpertProjection(
            employee_id=employee_id,
            tenant_id="",  # 本地仓不依赖 tenant_id，后续 sync 会刷新
            version="1",
            display_name=template.display_name,
            runtime_binding=None,
            synced_at=_now_dt(),
            revoked=False,
        )
        self._projections.upsert(projection)
        return RecruitResult(success=True, employee_id=employee_id, message="招募成功")

    # ---- P09 办公室 ----

    def get_office_scene(self) -> OfficeScene:
        """从本地投影 + 工作台偏好派生办公室场景。"""
        experts = self._projections.available()
        states = {s.employee_id: s for s in self._workbench.list_all()}
        employees = []
        for e in experts:
            state = states.get(e.employee_id)
            employees.append({
                "employee_id": e.employee_id,
                "display_name": e.display_name,
                "is_starred": state.is_starred if state else False,
                "status": "ready",
            })
        total = len(employees)
        return OfficeScene(
            employees=employees,
            summary={
                "total": total,
                "working": 0,
                "ready": total,
                "offline": 0,
            },
        )

    def get_office_feed(self) -> OfficeFeed:
        """办公室动态摘要（当前从空开始，后续从 mainline/loop 事件派生）。"""
        return OfficeFeed(events=[])

    # ---- P08 知识库 ----

    def create_knowledge_base(self, name: str, description: str = "") -> KnowledgeBase:
        kb = KnowledgeBase(kb_id=str(uuid4()), name=name, description=description)
        return self._kb.create(kb)

    def list_knowledge_bases(self) -> list[KnowledgeBase]:
        return self._kb.list_all()

    def get_knowledge_base(self, kb_id: str) -> KnowledgeBase | None:
        return self._kb.get(kb_id)

    def search_knowledge(self, kb_id: str, q: str, top_k: int = 5) -> list[KnowledgeDocument]:
        return self._docs.search(kb_id, q, top_k)

    def upload_document(self, kb_id: str, filename: str, content: bytes,
                        content_type: str = "text/plain") -> KnowledgeDocument:
        """上传文档到知识库：落本地文件 + 记录元数据。文件内容绝不上传 Manager/Operator。"""
        # 确保 upload_dir 存在
        if self._upload_dir is None:
            raise RuntimeError("upload_dir not configured")
        self._upload_dir.mkdir(parents=True, exist_ok=True)
        file_path = self._upload_dir / f"{uuid4()}_{filename}"
        file_path.write_bytes(content)

        doc = KnowledgeDocument(
            doc_id=str(uuid4()),
            kb_id=kb_id,
            title=filename,
            snippet="",
            file_path=str(file_path),
            content_type=content_type,
            size=len(content),
        )
        created = self._docs.create(doc)

        # 更新 KB 文档计数
        kb = self._kb.get(kb_id)
        if kb:
            kb.doc_count = len(self._docs.list_by_kb(kb_id))
            kb.size_kb = sum(d.size for d in self._docs.list_by_kb(kb_id)) // 1024
            self._kb.update(kb)
        return created

    # ---- 文件上传 ----

    def upload_file(self, filename: str, content: bytes,
                    content_type: str = "application/octet-stream") -> UploadAsset:
        """通用文件上传：落本地磁盘 + 记录资产元数据。"""
        if self._upload_dir is None:
            raise RuntimeError("upload_dir not configured")
        self._upload_dir.mkdir(parents=True, exist_ok=True)
        asset_id = str(uuid4())
        file_path = self._upload_dir / f"{asset_id}_{filename}"
        file_path.write_bytes(content)

        asset = UploadAsset(
            asset_id=asset_id,
            filename=filename,
            size=len(content),
            content_type=content_type,
            file_path=str(file_path),
        )
        return self._uploads.create(asset)

    def get_upload(self, asset_id: str) -> UploadAsset | None:
        return self._uploads.get(asset_id)

    # ---- P07 组织树 ----

    def get_org_tree(self) -> OrgTreeNode:
        """从已授权专家投影派生本地组织树。"""
        experts = self._projections.available()
        children = [
            OrgTreeNode(id=e.employee_id, type="employee", name=e.display_name)
            for e in experts
        ]
        return OrgTreeNode(id="root", type="department", name="企业", children=children)
