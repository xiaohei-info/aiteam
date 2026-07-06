"""人才市场模板 Provider：定义从何处获取可招募专家模板。

MarketTemplate 是人才市场的核心数据类型，定义在本模块以避免循环依赖。

实现：
- ManagerMarketplaceProvider：从 Manager `/api/manager/recruit/catalog/experts` 拉取已发布模板，
  登录后使用用户 token 调用；未登录或 Manager 不可达时按下方约定显式报错或返回空列表。

契约：
- 模板列表非空 → 返回 MarketTemplate 列表；
- Manager 可正常连接但目录为空 → 返回空列表（前端展示"暂无可招募专家"）；
- 用户未登录（无 token）→ 返回空列表（前端展示"未登录"引导）；
- Manager 不可达 / 网络错误 → 抛出 MarketplaceProviderError，由路由层转为 problem+json
  （502/503），明确告知用户，不用假数据掩盖。

本模块不再保留任何内置假模板兜底：静默返回假数据会让用户误以为那些专家真实存在。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from shared.errors import AppError


# ---- Provider 错误 ----

class MarketplaceProviderError(AppError):
    """人才市场 Provider 真实错误（Manager 不可达、返回无效数据等）。

    路由层捕获后转为应用 problem+json（502/503），把真实错误信息回传给前端，
    杜绝用假数据掩盖真实故障。
    """

    status, code, title = 503, "marketplace_provider_unavailable", "人才市场数据源不可达"


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


class ManagerMarketplaceProvider:
    """从 Manager 拉取 Operator 已发布专家模板，并映射到本地 MarketTemplate。

    不再做任何假数据兜底。错误分三类：
    - `service_client` 为 None（MANAGER_URL 未配置）：构造期即配置错误，
      `list_templates` 抛 MarketplaceProviderError，提示部署配置缺失；
    - `token` 为空（用户未登录）：返回空列表，由前端引导登录；
    - Manager 调用抛异常（不可达 / 5xx）：抛 MarketplaceProviderError 并带上原始原因，
      让上游路由层把它回传给前端。
    """

    def __init__(
        self,
        *,
        service_client=None,  # shared.service_client.ServiceClient | None
        token_provider=None,  # () -> str | None
    ) -> None:
        self._client = service_client
        self._token_provider = token_provider

    def list_templates(self) -> list[MarketTemplate]:
        if self._client is None:
            raise MarketplaceProviderError(
                "Agent 未配置 MANAGER_URL，无法从 Manager 拉取人才市场模板。"
                "请在部署环境设置 MANAGER_URL 后重启 agent 服务。"
            )
        token = self._token_provider() if self._token_provider else None
        if not token:
            # 用户未登录：不是错误，只是当前没有可用数据，回空列表让前端展示登录引导。
            return []
        try:
            headers = {"Authorization": f"Bearer {token}"}
            body = self._client.get("/api/manager/recruit/catalog/experts", headers=headers)
        except Exception as e:
            # Manager 不可达 / 网络错误：把真实原因带上去，不要静默吞掉。
            raise MarketplaceProviderError(
                f"从 Manager 拉取人才市场模板失败：{e}"
            ) from e
        data = body.get("data", body) if isinstance(body, dict) else body
        items = data if isinstance(data, list) else []
        return [self._map_item(item) for item in items]

    @staticmethod
    def _map_item(item: dict) -> MarketTemplate:
        binding = item.get("default_binding_json") or {}
        skills = []
        knowledge_bases = []
        if isinstance(binding, dict):
            for s in binding.get("skills", []) or []:
                skills.append({"code": s})
            for k in binding.get("knowledge_bases", []) or []:
                knowledge_bases.append({"kb_id": k})
        tags = list(item.get("tags", []) or [])
        role = item.get("role_name")
        if role and role not in tags:
            tags.insert(0, role)
        prompt_pack = item.get("prompt_pack_json") or {}
        persona = item.get("persona", "") or (prompt_pack.get("system_prompt", "") if isinstance(prompt_pack, dict) else "")
        return MarketTemplate(
            template_id=item.get("template_id", ""),
            display_name=item.get("display_name", ""),
            category=item.get("category_code", ""),
            model_name=_model_from_json(item.get("default_model_json")),
            tags=tags,
            persona=persona,
            skills=skills,
            knowledge_bases=knowledge_bases,
            initial_memories=[],
            rating=0.0,
        )


def _model_from_json(model_json) -> str:
    if not isinstance(model_json, dict):
        return ""
    prov = model_json.get("provider")
    model = model_json.get("model")
    if prov and model:
        return f"{prov}::{model}"
    return model or ""
