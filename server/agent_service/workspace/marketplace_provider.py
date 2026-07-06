"""人才市场模板 Provider：定义从何处获取可招募专家模板。

MarketTemplate 是人才市场的核心数据类型，定义在本模块以避免循环依赖。
两种 provider 实现：
- FakeMarketplaceProvider：离线内置默认模板，保证人才市场**永不为空**（离线/开发/Manager 不可达时兜底）。
- ManagerMarketplaceProvider：从 Manager `/api/manager/recruit/catalog/experts` 拉取已发布模板，
  登录后使用用户 token 调用；未登录或 Manager 不可达时降级到 fake 模板。

WorkspaceService 在装配时注入一个 provider，初始化即自动 sync，消除 marketplace 永远为空的缺陷。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


# ---- 人才市场模板（本模块持有，service/routes/provider 共用） ----

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


# ---- Provider 协议与实现 ----

class MarketplaceProvider(Protocol):
    """人才市场模板来源。"""

    def list_templates(self) -> list[MarketTemplate]: ...


class FakeMarketplaceProvider:
    """离线兜底：内置默认专家模板。

    确保人才市场在以下场景仍可用：
    - 开发/测试环境未配置 Manager
    - Manager 服务不可达
    - 用户尚未登录（无 token 调 Manager 目录）
    """

    _DEFAULT: list[MarketTemplate] = [
        MarketTemplate(
            template_id="tpl-coder",
            display_name="代码专家",
            category="coding",
            model_name="gpt-5",
            tags=["coding", "python", "review"],
            avatar_url=None,
            persona="资深软件工程师，擅长代码实现、Review 与调试。",
            skills=[{"code": "code"}, {"code": "code-review"}],
            knowledge_bases=[],
            initial_memories=[],
            rating=4.8,
        ),
        MarketTemplate(
            template_id="tpl-researcher",
            display_name="研究员",
            category="research",
            model_name="gpt-5",
            tags=["research", "analysis"],
            avatar_url=None,
            persona="专注信息搜集、调研分析与报告撰写。",
            skills=[{"code": "web-search"}, {"code": "analysis"}],
            knowledge_bases=[],
            initial_memories=[],
            rating=4.6,
        ),
        MarketTemplate(
            template_id="tpl-writer",
            display_name="写作专家",
            category="writing",
            model_name="gpt-5",
            tags=["writing", "copywriting", "drafting"],
            avatar_url=None,
            persona="擅长撰写与润色文案、邮件、文档和营销稿件。",
            skills=[{"code": "writing"}, {"code": "editing"}],
            knowledge_bases=[],
            initial_memories=[],
            rating=4.7,
        ),
        MarketTemplate(
            template_id="tpl-data-analyst",
            display_name="数据分析师",
            category="data",
            model_name="gpt-5",
            tags=["data", "sql", "analytics"],
            avatar_url=None,
            persona="专注数据查询、SQL、指标分析与可视化解读。",
            skills=[{"code": "sql"}, {"code": "data-analysis"}],
            knowledge_bases=[],
            initial_memories=[],
            rating=4.5,
        ),
        MarketTemplate(
            template_id="tpl-translator",
            display_name="翻译专家",
            category="language",
            model_name="gpt-5",
            tags=["translation", "localization"],
            avatar_url=None,
            persona="多语言翻译与本地化，保持语义准确与行文自然。",
            skills=[{"code": "translation"}],
            knowledge_bases=[],
            initial_memories=[],
            rating=4.4,
        ),
    ]

    def list_templates(self) -> list[MarketTemplate]:
        # 返回副本，避免调用方改写内置模板真相
        return [self._copy(t) for t in self._DEFAULT]

    @staticmethod
    def _copy(t: MarketTemplate) -> MarketTemplate:
        return MarketTemplate(
            template_id=t.template_id,
            display_name=t.display_name,
            category=t.category,
            model_name=t.model_name,
            skills_count=t.skills_count,
            recruit_count=t.recruit_count,
            is_recruited=t.is_recruited,
            tags=list(t.tags),
            avatar_url=t.avatar_url,
            persona=t.persona,
            skills=[dict(s) for s in t.skills],
            knowledge_bases=[dict(k) for k in t.knowledge_bases],
            initial_memories=[dict(m) for m in t.initial_memories],
            rating=t.rating,
        )


class ManagerMarketplaceProvider:
    """从 Manager 拉取 Operator 已发布专家模板，并映射到本地 MarketTemplate。

    未配置 Manager / 无用户 token / 调用失败时降级到 FakeMarketplaceProvider，
    保证人才市场始终非空。
    """

    def __init__(
        self,
        *,
        service_client=None,  # shared.service_client.ServiceClient | None
        token_provider=None,  # () -> str | None
        fallback: MarketplaceProvider | None = None,
    ) -> None:
        self._client = service_client
        self._token_provider = token_provider
        self._fallback = fallback or FakeMarketplaceProvider()

    def list_templates(self) -> list[MarketTemplate]:
        if self._client is None:
            return self._fallback.list_templates()
        token = self._token_provider() if self._token_provider else None
        if not token:
            return self._fallback.list_templates()
        try:
            headers = {"Authorization": f"Bearer {token}"}
            body = self._client.get("/api/manager/recruit/catalog/experts", headers=headers)
        except Exception:
            return self._fallback.list_templates()
        data = body.get("data", body) if isinstance(body, dict) else body
        items = data if isinstance(data, list) else []
        if not items:
            return self._fallback.list_templates()
        return [self._map_item(item) for item in items]

    @staticmethod
    def _map_item(item: dict) -> MarketTemplate:
        # PRD-v2 扁平字段：技能/知识引用直接挂模板顶层（skill_ids/knowledge_refs），
        # persona 由 pull 路径从 system_prompt 回填。
        skills = [{"code": s} for s in (item.get("skill_ids") or [])]
        knowledge_bases = [{"kb_id": k} for k in (item.get("knowledge_refs") or [])]
        tags = list(item.get("tags", []) or [])
        persona = item.get("persona", "") or item.get("system_prompt", "")
        initial_memories = list(item.get("initial_memories") or [])
        return MarketTemplate(
            template_id=item.get("template_id", ""),
            display_name=item.get("display_name", ""),
            category=item.get("category", ""),
            model_name=item.get("default_model", ""),
            tags=tags,
            avatar_url=item.get("avatar_url") or None,
            persona=persona,
            skills=skills,
            knowledge_bases=knowledge_bases,
            initial_memories=initial_memories,
            rating=0.0,
        )
