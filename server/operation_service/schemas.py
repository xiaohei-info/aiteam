"""运营端北向 API 边界 schema（02 §10.3，Pydantic 作 API 边界）。

仅声明本端 HTTP 请求/响应形状；跨端契约（TenantProvisionRequest/OwnerBootstrapSync）一律
从 shared.contracts.crosstier import，**禁在此重定义**。

响应里的 bootstrap_secret 是**一次性明文**，仅在签发/重置当次返回给系统操作员转交负责人；
Operator 自身只持其 hash（03 §9.2）。响应体不含长期密码、token、provider key。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from shared.contracts.platform_provider import PlatformModelRef

from .catalog_scope import MAX_ITEM_LENGTH, MAX_SCOPE_ITEMS, _clean


class EnterpriseProfile(BaseModel):
    """企业行业 / 标签（发布范围匹配用）。更新时没给的字段保持原值；要清空须显式传 null（行业）或 []（标签）。"""

    model_config = ConfigDict(extra="forbid")

    industry: str | None = Field(default=None, max_length=MAX_ITEM_LENGTH, description="所属行业（单选，≤20 字）。")
    tags: list[str] | None = Field(default=None, description=f"企业标签，最多 {MAX_SCOPE_ITEMS} 个，每个 ≤{MAX_ITEM_LENGTH} 字。")

    @field_validator("industry")
    @classmethod
    def _industry(cls, value: str | None) -> str | None:
        return (value or "").strip() or None

    @field_validator("tags")
    @classmethod
    def _tags(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else _clean(value)


class ProvisionEnterpriseRequest(EnterpriseProfile):
    """F01 开通企业（北向请求）：系统操作员发起。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_name: str = Field(min_length=1, description="企业展示名称。")
    owner_phone: str = Field(min_length=1, description="负责人手机号，用于 Manager 校验登录身份")
    enterprise_code: str | None = Field(default=None, description="可读 slug，可选，需唯一")
    initial_quota_policy: dict[str, Any] | None = Field(default=None, description="首次开通时的默认配额策略。")
    allowed_model_refs: list[PlatformModelRef] | None = Field(
        default=None,
        description="企业允许使用的当前 effective 平台模型身份；null=不限制，空列表=不开放模型。",
    )


class EnterpriseProfileOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    industry: str | None = None
    tags: list[str] = Field(default_factory=list)


class EnterpriseProvisioned(BaseModel):
    """F01/F02 开通结果（北向响应）。bootstrap_secret 一次性明文，仅当次返回。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str = Field(description="运营端企业 ID。")
    tenant_id: str = Field(description="Manager 企业租户 ID。")
    enterprise_name: str = Field(description="企业展示名称。")
    enterprise_code: str | None = Field(default=None, description="企业可读代码。")
    owner_phone: str = Field(description="负责人手机号。")
    owner_bootstrap_secret: str = Field(description="一次性明文 bootstrap，仅本次返回；Operator 只持 hash")
    must_reset: bool = Field(default=True, description="负责人首登强制重置")
    allowed_model_refs: list[PlatformModelRef] | None = Field(
        default=None,
        description="企业允许使用的当前 effective 平台模型身份；null=不限制，空列表=不开放模型。",
    )


class EnterpriseModelAccessRequest(BaseModel):
    """企业平台模型 allow-list；null 表示兼容旧行为的全量开放。"""

    model_config = ConfigDict(extra="forbid")

    allowed_model_refs: list[PlatformModelRef] | None = Field(
        description="允许的当前 effective 平台模型身份；null=全部当前模型，空列表=不开放模型。",
    )


class EnterpriseModelAccessOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enterprise_id: str
    tenant_id: str
    allowed_model_refs: list[PlatformModelRef] | None = Field(
        description="允许的当前 effective 平台模型身份；null=全部当前模型，空列表=不开放模型。",
    )


class OwnerBootstrapResetResult(BaseModel):
    """F02 负责人凭据重置结果（北向响应）。返回新的一次性明文 bootstrap。"""

    model_config = ConfigDict(extra="forbid")

    enterprise_id: str = Field(description="运营端企业 ID。")
    tenant_id: str = Field(description="Manager 企业租户 ID。")
    owner_phone: str = Field(description="负责人手机号。")
    owner_bootstrap_secret: str = Field(description="重置后的一次性明文 bootstrap，仅本次返回")
    must_reset: bool = Field(default=True)
