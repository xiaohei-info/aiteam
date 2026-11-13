"""招募 / 应用方案测试共用的模型夹具：企业显式选模型，目录里需有对应的已发布、价格已知的平台模型。"""

from __future__ import annotations

from manager_service.schemas import RecruitModelPolicy

PROVIDER = "provider-1"
MODEL = "claude-opus-4-8"

MODEL_POLICY = RecruitModelPolicy(provider_ref=PROVIDER, model=MODEL)

# 测试里出现过的专家模板 id；未出现在方案里的键会被服务忽略，所以这里可以放宽。
_TEMPLATE_IDS = [
    "tpl-1", "tpl-a", "tpl-b", "tpl-x", "tpl-z", "tpl-m", "tpl-auto", "tpl-sales", "tpl-miss",
    "tpl-hit", "tpl-disabled", "retry-template", "missing",
    *[f"tpl-{i}" for i in range(2, 12)],
]
EXPERT_MODELS = {tid: MODEL_POLICY for tid in _TEMPLATE_IDS}


def platform_catalog_with_model(extra: dict | None = None) -> dict:
    catalog = {
        "providers": [{"provider_id": PROVIDER, "status": "published"}],
        "models": [{
            "model": {"provider_id": PROVIDER, "model_id": MODEL, "status": "published", "capabilities": {}},
            "rate": {"pricing_status": "known"},
        }],
    }
    catalog.update(extra or {})
    return catalog


def seed_default_model(catalog) -> None:
    """目录里没有任何模型时补一个默认模型；已显式播种（含租户白名单）的保持原样并补齐缺失键。"""
    current = dict(catalog._platform_catalog)
    if current.get("models"):
        return
    defaults = platform_catalog_with_model()
    current["providers"] = current.get("providers") or defaults["providers"]
    current["models"] = defaults["models"]
    catalog.seed_platform_catalog(current)
