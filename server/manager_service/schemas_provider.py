"""provider 凭据/AI Relay 管理面 API 边界 schema（M5，04 §6.7，D18）。

红线（04 §6.7，D18）：
- 写入请求体（Create/Update）携带明文 secret（仅写入面，入参即焚——service 层加密后明文不落库）。
- 读取响应体（Out）**绝不**含明文 secret，也不含密文——只回 provider_ref + 非敏感元数据。
- provider_ref 是租户内稳定的 provider 配置引用；不在员工快照中内联明文凭据。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from shared.contracts.platform_provider import PricingSnapshot


_SENSITIVE_CAPABILITY_KEY_PARTS = (
    "secret", "token", "password", "credential", "apikey", "privatekey", "authorization",
)


def _contains_sensitive_capability_key(value: Any) -> bool:
    if isinstance(value, dict):
        for key, nested in value.items():
            normalized = "".join(char for char in str(key).casefold() if char.isalnum())
            if any(part in normalized for part in _SENSITIVE_CAPABILITY_KEY_PARTS):
                return True
            if _contains_sensitive_capability_key(nested):
                return True
    elif isinstance(value, list):
        return any(_contains_sensitive_capability_key(item) for item in value)
    return False


class ProviderModelCapability(BaseModel):
    """provider 支持的单个模型能力声明（非敏感，允许回显）。

    供后续招募按 model 自动匹配 provider_ref 复用（AITEAM-676/681）。
    capabilities 为扩展键值（如 context_window、supports_vision），本卡不做严格校验。
    """

    model_config = ConfigDict(extra="forbid")

    model: str = Field(description="模型标识（如 gpt-4o、claude-3-5-sonnet）")
    display_name: str = Field(default="", description="面向用户的展示名（可空，UI 回退到 model）")
    enabled: bool = Field(default=True, description="该模型是否启用（未启用的模型不参与自动匹配）")
    capabilities: dict[str, Any] = Field(
        default_factory=dict,
        description="能力扩展键值（如 context_window、supports_vision）；禁止递归敏感键",
    )

    @model_validator(mode="after")
    def _reject_sensitive_capability_keys(self) -> "ProviderModelCapability":
        if _contains_sensitive_capability_key(self.capabilities):
            raise ValueError("capabilities contains a prohibited sensitive key")
        return self


class ProviderCredentialBase(BaseModel):
    """provider 凭据的共享中立字段（不含 secret，避免被响应体误继承）。"""

    model_config = ConfigDict(extra="forbid")

    display_name: str = ""
    # endpoint：provider 接入端点（非敏感，允许回显）。
    endpoint: str | None = Field(default=None)
    # Supported Pi API protocols in this runtime contract. Unsupported Pi APIs are rejected at the boundary.
    api_protocol: Literal["openai-completions", "openai-responses", "anthropic-messages"] = Field(default="openai-completions")
    # 可见性：tenant（租户内全员可用）| members（仅 allowed_member_ids 列出的成员）。
    visibility: Literal["tenant", "members"] = Field(default="tenant")
    # 成员级授权真相态：visibility=members 时生效（app_user.id 列表）。
    allowed_member_ids: list[str] = Field(default_factory=list)
    # 能力目录：provider 支持的模型清单（非敏感，允许回显；供招募自动匹配 provider_ref）。
    supported_models: list[ProviderModelCapability] = Field(
        default_factory=list,
        description="provider 支持的模型能力目录（非敏感）；为后续 discovery 预留 model_catalog_source",
    )
    # 能力目录来源：manual（默认，人工维护）| discovery（预留：后续动态调用 provider /v1/models）。
    model_catalog_source: Literal["manual", "discovery"] = Field(
        default="manual",
        description="能力目录来源（manual | discovery）；本卡仅 manual，discovery 为后续预留",
    )

    @model_validator(mode="after")
    def _members_requires_ids(self) -> "ProviderCredentialBase":
        if self.visibility == "members" and not self.allowed_member_ids:
            raise ValueError("visibility=members requires non-empty allowed_member_ids")
        return self


class ProviderCredentialCreate(ProviderCredentialBase):
    """创建请求体。provider_ref（租户内唯一）+ 明文 secret（入参即焚）。"""

    provider_ref: str = Field(description="租户内唯一 provider 配置引用")
    # 明文 secret：AI Relay 企业级令牌 或 直连 provider API key。service 层加密后明文不落库/不日志。
    secret: str = Field(description="明文凭据（AI Relay 令牌或 provider API key）；入库前加密，不回显")


class ProviderCredentialUpdate(ProviderCredentialBase):
    """改写请求体。provider_ref 不可改（引用稳定性）；secret 全量替换。"""

    secret: str = Field(description="明文凭据（全量替换；入库前加密，不回显）")


class RuntimeProviderConfigRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    employee_id: str


class RuntimeProviderConfigOut(BaseModel):
    """最小运行时配置；仅受保护 runtime-config 端点可返回 api_key。"""

    model_config = ConfigDict(extra="forbid")

    base_url: str
    api_protocol: Literal["openai-completions", "openai-responses", "anthropic-messages"]
    api_key: str
    model: str
    provider_ref: str
    provider_version: int
    model_version: int
    pricing: PricingSnapshot
    version: int
    model_capabilities: dict[str, Any] = Field(
        default_factory=dict,
        description="当前模型的非敏感运行时能力（上下文窗口、最大输出、推理和输入模态）。",
    )


class ProviderCredentialOut(BaseModel):
    """读取响应体。**绝不含明文 secret / 密文**（红线：不下发明文 key）。

    只回 provider_ref + 非敏感元数据（endpoint/可见性/version/能力目录），供配置管理 UI 与增量 sync。
    用户端按授权 pull provider 配置时，由独立的受控通道下发并由 Pi ModelRuntime 装配，
    本 CRUD 出参面向管理面，不下发任何形态的凭据。
    """

    model_config = ConfigDict(extra="forbid")

    credential_id: str
    provider_ref: str
    display_name: str
    endpoint: str | None
    api_protocol: str = "openai-completions"
    visibility: str
    allowed_member_ids: list[str] = Field(default_factory=list)
    supported_models: list[ProviderModelCapability] = Field(
        default_factory=list,
        description="provider 支持的模型能力目录（非敏感，允许回显）",
    )
    model_catalog_source: str = Field(
        default="manual",
        description="能力目录来源（manual | discovery）",
    )
    version: int = Field(description="配置版本；每次变更单调递增")
