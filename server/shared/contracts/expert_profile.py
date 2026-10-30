"""专家模板人才市场展示字段（议题 7「人才市场字段细化」）。

Operator 持模板真相并在模板 payload 中保存这些字段；Manager 经 F06 拉取后原样投影给企业端
与用户端人才市场。全部字段可缺省：旧模板不带这些字段时按默认值（空串/空列表/null）读取，
仍是合法模板。这里只描述模板本身，不含任何企业数据或会话内容。
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import (
    BaseModel, ConfigDict, Field, SerializerFunctionWrapHandler, StringConstraints,
    field_validator, model_serializer, model_validator,
)

OutputType = Literal["document", "spreadsheet", "code", "presentation", "system_operation"]
PricingMode = Literal["per_call", "per_token", "subscription"]
BillingPeriod = Literal["month", "year"]

TAGLINE_MAX_LENGTH = 40
USE_CASE_MAX_LENGTH = 30
USE_CASES_MAX_ITEMS = 6
LIMITATIONS_MAX_ITEMS = 3
EXAMPLE_PROMPTS_MAX_ITEMS = 3
SAMPLE_OUTPUTS_MAX_ITEMS = 6
CONNECTORS_MAX_ITEMS = 10
RECOMMENDED_KNOWLEDGE_MAX_ITEMS = 10
URL_MAX_LENGTH = 2048

UseCase = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=USE_CASE_MAX_LENGTH)]
Limitation = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
ExamplePrompt = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
ConnectorKey = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
KnowledgeCategory = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=30)]


def validate_http_url(value: str) -> str:
    """空串表示未提供；否则只接受 http(s) 绝对地址，拒绝 javascript:/data: 等 scheme。"""
    value = value.strip()
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("URL must be an absolute http(s) address")
    return value


class SampleOutput(BaseModel):
    """示例产出：标题 + 产出类型 + 可选预览链接。"""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=60, description="示例产出标题")
    output_type: OutputType = Field(description="产出类型")
    preview_url: str = Field(default="", max_length=URL_MAX_LENGTH, description="预览链接（http/https）；空串表示无预览")

    @field_validator("title")
    @classmethod
    def _strip_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("title must not be blank")
        return value

    @field_validator("preview_url")
    @classmethod
    def _validate_preview_url(cls, value: str) -> str:
        return validate_http_url(value)


class RequiredPermissions(BaseModel):
    """招募后使用该专家需要的本机权限（对应议题 2 的权限面板）。"""

    model_config = ConfigDict(extra="forbid")

    full_access: bool = Field(default=False, description="是否需要「允许完全访问」")
    local_directories: bool = Field(default=False, description="是否需要授权本机目录")


class TemplatePricing(BaseModel):
    """模板计价信息（参考价，非账单）；币种与平台用量一致固定 USD。"""

    model_config = ConfigDict(extra="forbid")

    mode: PricingMode = Field(description="计价方式：per_call 按次 / per_token 按百万 Token / subscription 套餐")
    unit_price: Decimal = Field(ge=0, max_digits=18, decimal_places=6, description="参考单价（USD，最多 6 位小数）")
    currency: Literal["USD"] = Field(default="USD", description="币种，固定 USD")
    billing_period: BillingPeriod | None = Field(
        default=None,
        description="套餐周期：month 按月 / year 按年；subscription 必填，per_call/per_token 不允许，响应中省略。",
    )

    @model_validator(mode="after")
    def _billing_period_matches_mode(self) -> "TemplatePricing":
        if self.mode == "subscription" and self.billing_period is None:
            raise ValueError("billing_period is required for subscription pricing")
        if self.mode != "subscription" and self.billing_period is not None:
            raise ValueError("billing_period applies to subscription pricing only")
        return self

    @model_serializer(mode="wrap")
    def _omit_absent_billing_period(self, handler: SerializerFunctionWrapHandler):  # noqa: ANN202 - unannotated keeps the documented schema
        data = handler(self)
        if data.get("billing_period") is None:
            data.pop("billing_period", None)
        return data


class ExpertTemplateProfile(BaseModel):
    """可由运营编辑的人才市场字段；全部可缺省，旧模板按默认值读取。"""

    model_config = ConfigDict(extra="forbid")

    tagline: str = Field(default="", max_length=TAGLINE_MAX_LENGTH, description="一句话定位（≤40 字）")
    use_cases: list[UseCase] = Field(default_factory=list, max_length=USE_CASES_MAX_ITEMS, description="适用场景（每条 ≤30 字，最多 6 条）")
    limitations: list[Limitation] = Field(default_factory=list, max_length=LIMITATIONS_MAX_ITEMS, description="不适用场景（最多 3 条）")
    example_prompts: list[ExamplePrompt] = Field(default_factory=list, max_length=EXAMPLE_PROMPTS_MAX_ITEMS, description="示例问题（最多 3 条）")
    sample_outputs: list[SampleOutput] = Field(default_factory=list, max_length=SAMPLE_OUTPUTS_MAX_ITEMS, description="示例产出（最多 6 条）")
    output_types: list[OutputType] = Field(default_factory=list, description="产出类型（去重）")
    required_connectors: list[ConnectorKey] = Field(default_factory=list, max_length=CONNECTORS_MAX_ITEMS, description="必需的外部系统（连接器标识）")
    optional_connectors: list[ConnectorKey] = Field(default_factory=list, max_length=CONNECTORS_MAX_ITEMS, description="可选的外部系统（连接器标识）")
    recommended_knowledge: list[KnowledgeCategory] = Field(default_factory=list, max_length=RECOMMENDED_KNOWLEDGE_MAX_ITEMS, description="推荐知识的类别描述（如「产品手册」），不是具体知识库")
    required_permissions: RequiredPermissions | None = Field(default=None, description="需要的本机权限；null 表示未声明")
    pricing: TemplatePricing | None = Field(default=None, description="计价信息；null 表示未提供")
    memory_policy_summary: str = Field(default="", max_length=200, description="记忆策略说明（是否保存对话记忆等）")
    publisher: str = Field(default="", max_length=60, description="发布者")
    changelog_url: str = Field(default="", max_length=URL_MAX_LENGTH, description="更新说明链接（http/https）")

    @field_validator("tagline", "memory_policy_summary", "publisher")
    @classmethod
    def _strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("output_types")
    @classmethod
    def _dedupe_output_types(cls, value: list[str]) -> list[str]:
        return list(dict.fromkeys(value))

    @field_validator("changelog_url")
    @classmethod
    def _validate_changelog_url(cls, value: str) -> str:
        return validate_http_url(value)


EXPERT_PROFILE_FIELDS: tuple[str, ...] = tuple(ExpertTemplateProfile.model_fields)


def profile_from_payload(payload: dict | None) -> ExpertTemplateProfile:
    """从模板 payload 读取展示字段；旧模板缺字段或单个字段是历史脏数据时，该字段回落为默认值，
    不让单个模板拖垮目录。"""
    raw = {key: value for key, value in (payload or {}).items() if key in EXPERT_PROFILE_FIELDS}
    try:
        return ExpertTemplateProfile.model_validate(raw)
    except ValueError:
        valid: dict = {}
        for key, value in raw.items():
            try:
                ExpertTemplateProfile.model_validate({key: value})
            except ValueError:
                continue
            valid[key] = value
        return ExpertTemplateProfile.model_validate(valid)
