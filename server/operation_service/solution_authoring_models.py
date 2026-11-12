"""行业文档生成：把运营端选定的平台模型解析成 worker 可用的模型配置。

模型目录（Provider / 模型 / 能力 / 是否已发布）读 Operator 自己的平台目录；调用凭据是只存在于
Operator 进程环境里的内部 relay key。Agent（worker 子进程）不发现模型，也看不到这里之外的任何密钥。
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import SecretStr, ValidationError

from shared.contracts.platform_provider import PlatformModelRef
from shared.errors import NotFound, ServiceUnavailable, ValidationProblem
from shared.solution_authoring.runner import FauxModelConfig, ModelConfig, ProviderModelConfig

RELAY_TOKEN_ENV = "SOLUTION_AUTHORING_RELAY_TOKEN"
RELAY_BASE_URL_ENV = "SOLUTION_AUTHORING_RELAY_BASE_URL"
FAUX_ENV = "SOLUTION_AUTHORING_FAUX"


@dataclass(frozen=True)
class PublishedModel:
    """一个已发布、有价格的平台模型：生成所需的最小信息，不含任何凭据。"""

    provider_code: str
    api_protocol: str
    relay_base_url: str
    model_id: str
    capabilities: dict[str, Any] = field(default_factory=dict)


class ModelCatalog(Protocol):
    def describe_published_model(self, ref: PlatformModelRef) -> PublishedModel:
        """未发布 / 无价格 → 409；不存在 → 404。"""
        ...


class ModelConfigResolver(Protocol):
    uses_faux_model: bool

    def check(self, ref: PlatformModelRef, *, need_images: bool) -> None:
        """模型可用于生成（已发布、有价格、能力满足）；否则抛 404 / 409 / 422 / 503。"""
        ...

    def ensure_ready(self) -> None:
        """调用凭据已配置；否则抛 503。"""
        ...

    def resolve(self, ref: PlatformModelRef) -> ModelConfig: ...


# ---- 平台目录适配：只用 PlatformProviderService / Repository 已有的公开方法 ----

class _RefValidator(Protocol):
    def validate_model_ref(self, ref: PlatformModelRef, *, require_published: bool = False) -> PlatformModelRef: ...


class _CatalogRows(Protocol):
    def get_provider(self, provider_id: str) -> Any: ...
    def get_model(self, provider_id: str, model_id: str) -> Any: ...


class PlatformModelCatalog:
    """「已发布且有价格」的判断复用平台目录自己的规则（validate_model_ref），这里只读行。不访问网关。"""

    def __init__(self, validator: _RefValidator, rows: _CatalogRows, public_relay_url: str | None = None):
        self._validator = validator
        self._rows = rows
        self._public_relay_url = (public_relay_url or "").strip()

    def describe_published_model(self, ref: PlatformModelRef) -> PublishedModel:
        self._validator.validate_model_ref(ref, require_published=True)
        provider = self._rows.get_provider(ref.provider_id)
        model = self._rows.get_model(ref.provider_id, ref.model_id)
        if provider is None or model is None:
            raise NotFound("platform provider/model not found")
        return PublishedModel(
            provider_code=provider.provider_code, api_protocol=provider.api_protocol,
            relay_base_url=self._public_relay_url or provider.relay_base_url,
            model_id=model.model_id, capabilities=dict(model.capabilities or {}),
        )


# ---- 解析 ----

def _input_modes(capabilities: dict[str, Any]) -> list[str]:
    declared = capabilities.get("input")
    image = isinstance(declared, list) and "image" in declared
    return ["text", "image"] if image else ["text"]


def _positive_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


class RelayModelConfigResolver:
    """生产实现：平台目录 + 内部 relay key。"""

    uses_faux_model = False

    def __init__(self, catalog: Callable[[], ModelCatalog], *, relay_token: str | None, relay_base_url: str | None = None):
        self._catalog = catalog
        self._relay_token = (relay_token or "").strip()
        self._relay_base_url = (relay_base_url or "").strip()

    def _describe(self, ref: PlatformModelRef) -> PublishedModel:
        try:
            catalog = self._catalog()
        except RuntimeError as exc:
            raise ServiceUnavailable("Operator platform Provider store is not configured") from exc
        return catalog.describe_published_model(ref)

    def check(self, ref: PlatformModelRef, *, need_images: bool) -> None:
        model = self._describe(ref)
        if need_images and "image" not in _input_modes(model.capabilities):
            raise ValidationProblem("the selected model does not accept image input; choose another model or turn image recognition off")

    def ensure_ready(self) -> None:
        if not self._relay_token:
            raise ServiceUnavailable(f"solution generation is not configured on this Operator ({RELAY_TOKEN_ENV} is missing)")

    def resolve(self, ref: PlatformModelRef) -> ModelConfig:
        self.ensure_ready()
        model = self._describe(ref)
        capabilities = model.capabilities
        levels = capabilities.get("thinking_levels")
        reasoning = bool(capabilities.get("reasoning"))
        # 目录里声明支持 medium 才开；生成是长文本结构化任务，不需要更高档位。
        thinking = "medium" if reasoning and isinstance(levels, list) and "medium" in levels else "off"
        try:
            return ProviderModelConfig.model_validate({
                "base_url": self._relay_base_url or model.relay_base_url,
                "api_protocol": model.api_protocol,
                "model_id": model.model_id,
                "api_key": SecretStr(self._relay_token),
                "provider_ref": model.provider_code,
                "input": _input_modes(capabilities),
                "reasoning": reasoning,
                "thinking_level": thinking,
                "context_window": _positive_int(capabilities.get("context_window")),
                "max_tokens": _positive_int(capabilities.get("max_tokens")),
            })
        except ValidationError as exc:
            # 目录里的 Provider 配置不完整（如缺 relay 地址、协议不受支持）；不回显取值。
            raise ServiceUnavailable("the selected platform provider cannot be used for solution generation") from exc


class FauxModelConfigResolver:
    """本机联调 / 自动化测试：worker 用脚本化的假模型，不发任何网络请求。生产环境不可用。"""

    uses_faux_model = True

    def check(self, ref: PlatformModelRef, *, need_images: bool) -> None:
        return None

    def ensure_ready(self) -> None:
        return None

    def resolve(self, ref: PlatformModelRef) -> ModelConfig:
        return FauxModelConfig(input=["text", "image"])


def build_model_config_resolver(catalog: Callable[[], ModelCatalog], *, production: bool) -> ModelConfigResolver:
    if os.getenv(FAUX_ENV) == "1":
        if production:
            raise ValueError(f"{FAUX_ENV} must not be set in production")
        return FauxModelConfigResolver()
    return RelayModelConfigResolver(
        catalog, relay_token=os.getenv(RELAY_TOKEN_ENV), relay_base_url=os.getenv(RELAY_BASE_URL_ENV),
    )
