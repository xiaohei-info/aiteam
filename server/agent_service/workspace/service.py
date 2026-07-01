"""workspace 业务编排——工作台/人才市场/招募/办公室/知识库/摄入/上传/组织树。

Agent 只做本地数据面；人才市场模板从 Manager catalog pull 后本地缓存展示。
招募时创建本地 employee 投影条目（loaded_expert_projections）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from uuid import uuid4

from .marketplace_provider import FakeMarketplaceProvider, MarketTemplate, MarketplaceProvider
from .store import (
    KnowledgeBase,
    KnowledgeBaseRepository,
    KnowledgeDocument,
    KnowledgeDocumentRepository,
    KnowledgeIngestionJob,
    KnowledgeIngestionRepository,
    UploadAsset,
    UploadAssetRepository,
    WorkbenchState,
    WorkbenchStateRepository,
)

try:
    from .ingest import (
        build_rag_document_id, chunk_text, extract_text_only, html_to_text,
    )
    _INGEST_AVAILABLE = True
except Exception:  # pragma: no cover - 极端退化
    _INGEST_AVAILABLE = False  # type: ignore[assignment]

try:
    import httpx as _httpx
    _HTTPX_AVAILABLE = True
except Exception:  # pragma: no cover
    _httpx = None
    _HTTPX_AVAILABLE = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _safe_str_list(items):
    """把未知 JSON 列表安全地转成去空字符串列表。"""
    if not isinstance(items, list):
        return []
    return [str(x) for x in items if x is not None and str(x) != ""]


def _build_model_policy_from_template(template) -> "ModelPolicy":
    """把 MarketTemplate 模型信息转成 ModelPolicy。

    template.model_name 可能直接是 "gpt-5" 或 "provider::model_id" 形；
    这里只做简单切分，无法切分时全当 model。
    """
    from shared.contracts.snapshot import ModelPolicy
    model_name = getattr(template, "model_name", "") or ""
    if "::" in model_name:
        provider, _, model = model_name.partition("::")
        return ModelPolicy(model=model or None, provider_ref=provider or None)
    return ModelPolicy(model=model_name or None)


def _build_memory_policy_from_initial_memories(initial_memories) -> dict | None:
    """把 MarketTemplate.initial_memories 转成 memory_policy dict（仅 экспорт purpose）。

    无初始记忆时返回 None，避免空对象落进投影。
    """
    items = _safe_str_list([m.get("text") or m.get("content") if isinstance(m, dict) else m
                            for m in (initial_memories or [])])
    if not items:
        return None
    return {"initial_memories": items}

# ---- 市场模板类型见 .marketplace_provider (MarketTemplate) ----

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
        ingest_store: KnowledgeIngestionRepository | None = None,
        upload_store: UploadAssetRepository,
        upload_dir: str | None = None,
        http_timeout: float = 15.0,
        marketplace_provider: MarketplaceProvider | None = None,
        unread_counts_provider: Callable[[str], int] | None = None,
    ) -> None:
        from .store import InMemoryKnowledgeIngestionRepository
        self._projections = projections
        self._workbench = workbench_store
        self._kb = kb_store
        self._docs = doc_store
        self._ingests = ingest_store if ingest_store is not None else InMemoryKnowledgeIngestionRepository()
        self._uploads = upload_store
        self._upload_dir = Path(upload_dir) if upload_dir else None
        self._http_timeout = http_timeout
        self._unread_counts_provider = unread_counts_provider
        # 市场模板本地缓存（由 sync_marketplace 填充）
        self._market_templates: dict[str, MarketTemplate] = {}
        # 人才市场模板 provider：初始化即自动 sync，保证 marketplace 永不为空
        self._marketplace_provider = marketplace_provider or FakeMarketplaceProvider()
        self._sync_marketplace_from_provider()

    # ---- P02 工作台 ----

    def get_workbench(self) -> WorkbenchView:
        """从已授权专家投影 + 本地偏好构建工作台视图。"""
        experts = self._projections.available()
        states = {s.employee_id: s for s in self._workbench.list_all()}
        provider = self._unread_counts_provider
        employees: list[WorkbenchEmployeeView] = []
        total_unread = 0
        for e in experts:
            state = states.get(e.employee_id)
            unread = provider(e.employee_id) if provider else 0
            employees.append(WorkbenchEmployeeView(
                employee_id=e.employee_id,
                display_name=e.display_name,
                is_starred=state.is_starred if state else False,
                unread_count=unread,
            ))
            total_unread += unread
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

    def _sync_marketplace_from_provider(self) -> int:
        """从注入的 provider 拉取模板并填充本地缓存（初始化/手动 sync 时调用）。"""
        try:
            templates = self._marketplace_provider.list_templates()
        except Exception:
            templates = []
        return self.sync_marketplace(templates)

    def sync_marketplace_endpoint(self) -> int:
        """公开：手动触发一次 provider 拉取并刷新缓存（供 /sync 端点调用）。"""
        return self._sync_marketplace_from_provider()

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
        已存在则返回既有 employee_id；否则新创建投影条目。新建时把模板全部配置
        （skills/knowledge_refs/connector_refs/memory_policy/model_policy）
        一并落进投影，使新专家自动继承模板能力（AITEAM-288）。
        """
        from shared.contracts.grants import LoadedExpertProjection
        from shared.contracts.snapshot import ModelPolicy, RuntimePolicy

        template = self._market_templates.get(template_id)
        if template is None:
            return RecruitResult(success=False, message=f"模板不存在: {template_id}")

        # 检查是否已招募：通过 display_name 匹配。
        # 注意：若两个不同模板 display_name 相同会有碰撞风险（低优先级已知限制）。
        for p in self._projections.list_all():
            if p.display_name == template.display_name and not p.revoked:
                return RecruitResult(
                    success=True,
                    employee_id=p.employee_id,
                    message="该专家已招募",
                )

        # 创建新 employee 投影（含模板全部能力配置）
        employee_id = str(uuid4())
        skills = [str(s.get("code") or s.get("name") or s) for s in (template.skills or [])]
        knowledge_refs = [str(k.get("kb_id") or k.get("id") or k) for k in (template.knowledge_bases or [])]
        memory_policy = _build_memory_policy_from_initial_memories(template.initial_memories)
        projection = LoadedExpertProjection(
            employee_id=employee_id,
            tenant_id="",  # 本地仓不依赖 tenant_id，后续 sync 会刷新
            version="1",
            display_name=template.display_name,
            runtime_binding=None,
            persona=template.persona or None,
            model_policy=_build_model_policy_from_template(template),
            runtime_policy=RuntimePolicy(),
            tools=[],
            skills=[s for s in skills if s],
            knowledge_refs=[k for k in knowledge_refs if k],
            connector_refs=[],
            memory_policy=memory_policy,
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

    # ---- P08 知识库文档摄入流程 (AITEAM-260) ----

    def upload_document(self, kb_id: str, filename: str, content: bytes,
                        content_type: str = "text/plain") -> KnowledgeDocument:
        """上传文档并走摄入流水线：落本地文件 + 元数据（uploaded）→ 解析 → 入库 → ready。"""
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
            source_kind="file",
        )
        self._docs.create(doc)

        # 同步完成一次 ingestion（本端无真实向量库 → build 一个本地 rag_document_id）
        self._run_ingestion(doc)

        # 刷新 KB 文档计数
        self._refresh_kb_stats(kb_id)
        return self._docs.get(doc.doc_id) or doc

    def import_url(self, kb_id: str, url: str, *, title: str | None = None) -> KnowledgeDocument:
        """从 URL 抓取内容并入库（AITEAM-260）。

        抓取 → 解析 → 抽取文本 → 切块 & 入库 → 同 upload 流水线。
        抓取或解析失败即把文档标 error 并附带可读错误信息。
        """
        if not _HTTPX_AVAILABLE:
            raise RuntimeError("URL 导入需要 httpx；当前环境未安装")
        if self._upload_dir is None:
            raise RuntimeError("upload_dir not configured")

        display_title = title or url.strip().rsplit("/", 1)[-1] or url

        # 抓取
        try:
            with _httpx.Client(timeout=self._http_timeout, follow_redirects=True) as c:
                resp = c.get(url)
                resp.raise_for_status()
                raw = resp.content
                ctype = resp.headers.get("content_type", "text/html")
        except Exception as e:
            doc = self._create_errored_doc(
                kb_id=kb_id, title=display_title, url=url,
                err="fetch_failed", msg=f"URL 抓取失败: {e}",
            )
            self._refresh_kb_stats(kb_id)
            return doc

        # 落盘（保留原始字节，便于复跑）
        self._upload_dir.mkdir(parents=True, exist_ok=True)
        safe_name = re_url_to_filename(url)
        file_path = self._upload_dir / f"{uuid4()}_{safe_name}"
        file_path.write_bytes(raw)

        doc = KnowledgeDocument(
            doc_id=str(uuid4()),
            kb_id=kb_id,
            title=display_title,
            snippet="",
            file_path=str(file_path),
            content_type=ctype,
            size=len(raw),
            source_kind="url",
            source_url=url,
        )
        self._docs.create(doc)
        self._run_ingestion(doc)
        self._refresh_kb_stats(kb_id)
        return self._docs.get(doc.doc_id) or doc

    def _create_errored_doc(self, *, kb_id: str, title: str, url: str,
                            err: str, msg: str) -> KnowledgeDocument:
        """创建即标 error 的文档（抓取失败场景）。"""
        doc = KnowledgeDocument(
            doc_id=str(uuid4()),
            kb_id=kb_id,
            title=title,
            snippet="",
            file_path="",
            content_type="text/html",
            size=0,
            source_kind="url",
            source_url=url,
        )
        self._docs.create(doc)
        try:
            job = self._new_ingestion_job(doc)
            job.start()
            job.fail(msg)
            self._ingests.update(job)
            doc.start_ingesting(job.job_id)
            doc.mark_error(err, msg)
            self._docs.update(doc)
        except Exception:
            pass
        return doc

    def _new_ingestion_job(self, doc: KnowledgeDocument) -> KnowledgeIngestionJob:
        job = KnowledgeIngestionJob(
            job_id=str(uuid4()),
            kb_id=doc.kb_id,
            document_id=doc.doc_id,
        )
        self._ingests.create(job)
        return job

    def _run_ingestion(self, doc: KnowledgeDocument) -> KnowledgeIngestionJob:
        """一次完整的 ingestion：写 job → parsing → inserting → complete/fail。

        失败不往上传播——直接把 document/job 标 error/failed，让调用方拿到可展示的终态。
        """
        job = self._new_ingestion_job(doc)
        try:
            doc.start_ingesting(job.job_id)
            self._docs.update(doc)

            job.start()
            self._ingests.update(job)

            # 读取源字节
            raw = _read_doc_bytes(doc)
            # 抽取文本
            # URL/HTML 场景需要单独做 html→text 抽取后切块
            text = self._extract_for_doc(doc, raw)

            snippet = text[:240]
            job.start_inserting()
            self._ingests.update(job)

            chunks = chunk_text(text) if _INGEST_AVAILABLE else []
            rag_doc_id = build_rag_document_id() if _INGEST_AVAILABLE else f"rag-{doc.doc_id[:12]}"
            job.complete(chunk_count=len(chunks), rag_document_id=rag_doc_id)
            self._ingests.update(job)

            doc.mark_ready(rag_document_id=rag_doc_id, chunk_count=len(chunks))
            doc.snippet = snippet
            self._docs.update(doc)
            return job

        except Exception as e:  # 任何环节失败都标 error 而不是 500
            err_msg = f"{e}"
            try:
                job.fail(err_msg)
                self._ingests.update(job)
            except Exception:
                pass
            try:
                doc.mark_error("ingestion_failed", err_msg)
                self._docs.update(doc)
            except Exception:
                pass
            return job

    def _extract_for_doc(self, doc: KnowledgeDocument, raw: bytes) -> str:
        if doc.source_kind == "url":
            # HTML → 文本
            try:
                html = raw.decode("utf-8", errors="replace")
            except Exception:
                html = raw.decode("latin-1", errors="replace")
            return html_to_text(html)
        return extract_text_only(raw, doc.content_type, doc.title)

    def list_documents(self, kb_id: str) -> list[KnowledgeDocument]:
        return self._docs.list_by_kb(kb_id)

    def get_document(self, doc_id: str) -> KnowledgeDocument | None:
        return self._docs.get(doc_id)

    def get_ingestion(self, job_id: str) -> KnowledgeIngestionJob | None:
        return self._ingests.get(job_id)

    def list_ingestions(self, kb_id: str) -> list[KnowledgeIngestionJob]:
        return self._ingests.list_by_kb(kb_id)

    def retry_document(self, doc_id: str) -> KnowledgeDocument | None:
        """重置 errored 文档为 uploaded 并重新走 ingestion。"""
        doc = self._docs.get(doc_id)
        if doc is None:
            return None
        doc.reset_for_retry()
        self._docs.update(doc)
        self._run_ingestion(doc)
        self._refresh_kb_stats(doc.kb_id)
        return self._docs.get(doc_id) or doc

    def _refresh_kb_stats(self, kb_id: str) -> None:
        kb = self._kb.get(kb_id)
        if kb is None:
            return
        items = self._docs.list_by_kb(kb_id)
        # 只统计 status != error（已入库可检索）的有效文档
        valid = [d for d in items if d.status in ("ready", "ingesting", "uploaded")]
        kb.doc_count = len(valid)
        kb.size_kb = sum(d.size for d in items if d.status != "error" or d.size) // 1024
        kb.size_kb = max(kb.size_kb, 0)
        self._kb.update(kb)

    # ---- 文件上传 (通用) ----

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


def _read_doc_bytes(doc: KnowledgeDocument) -> bytes:
    if doc.file_path and Path(doc.file_path).exists():
        return Path(doc.file_path).read_bytes()
    return b""


def re_url_to_filename(url: str) -> str:
    """把 URL 映射成安全文件名（保留尾段作 title）。"""
    from urllib.parse import urlparse, unquote
    p = urlparse(url)
    tail = unquote(p.path.rsplit("/", 1)[-1] or p.netloc)
    tail = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in tail)
    if not tail:
        tail = p.netloc or "page"
    if len(tail) > 80:
        tail = tail[:80]
    return tail
