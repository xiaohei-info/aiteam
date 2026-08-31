"""Named response DTOs for Manager endpoints whose payloads are small maps.

These models deliberately describe the public wire shape instead of exposing
internal repository dictionaries in OpenAPI.  Dynamic upstream metadata remains
an explicitly documented JSON object only where the upstream contract is truly
extensible.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.platform_provider import PlatformModel, PlatformModelRate, PlatformProvider

from .schemas import UsageRollupOut


class DeletedResourceOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    deleted: str = Field(description="已删除资源 ID。")


class GrantRevocationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revoked: str = Field(description="已撤销的授权记录 ID。")


class ConnectorGrantsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connector_id: str = Field(description="连接器 ID。")
    employee_ids: list[str] = Field(default_factory=list, description="可见员工 ID 列表。")
    action: str | None = Field(default=None, description="本次授权动作。")
    updated: bool = Field(default=True, description="是否已更新。")


class PlatformSkillMarketOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(description="Operator 平台技能 ID。")
    display_name: str = Field(default="", description="技能展示名称。")
    summary: str = Field(default="", description="技能摘要。")
    owner: str | None = Field(default=None, description="技能发布者。")
    slug: str | None = Field(default=None, description="技能 slug。")
    published_version: str | None = Field(default=None, description="当前发布版本。")
    content_hash: str | None = Field(default=None, description="当前发布版本内容哈希。")
    installed: bool = Field(default=False, description="当前企业是否已安装。")
    installed_version: str | None = Field(default=None, description="企业已安装版本。")
    installed_content_hash: str | None = Field(default=None, description="企业已安装内容哈希。")
    installed_versions: list[str] = Field(default_factory=list, description="企业已安装版本列表。")
    update_available: bool = Field(default=False, description="是否有可用更新。")


class InstalledPlatformSkillOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(description="企业技能目录 ID。")
    version: str = Field(description="安装版本。")
    content_hash: str = Field(description="安装包内容哈希。")
    installed: bool = Field(description="本次是否实际写入安装。")


class PlatformModelWithRateOut(BaseModel):
    """Operator model plus its current price card used by Manager configuration."""

    model_config = ConfigDict(extra="forbid")
    model: PlatformModel
    rate: PlatformModelRate | None = None


class PlatformCatalogOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    providers: list[PlatformProvider] = Field(default_factory=list, description="Operator 发布的 Provider 列表。")
    models: list[PlatformModelWithRateOut] = Field(default_factory=list, description="Operator 发布的模型及价格列表。")


class UsageUploadOut(BaseModel):
    """Legacy compact receipt used by compatibility test doubles."""

    model_config = ConfigDict(extra="forbid")
    ingested: int = Field(ge=0, description="已接收的用量摘要条数。")
    audits: int = Field(ge=0, description="已接收的审计摘要条数。")


class UsageUploadDetailedOut(BaseModel):
    """Canonical F13 receipt returned by the real usage service."""

    model_config = ConfigDict(extra="forbid")
    usage_ingested: int = Field(ge=0, description="已接收的用量摘要条数。")
    audits_ingested: int = Field(ge=0, description="已接收的审计摘要条数。")


class UsageRollupItemsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[UsageRollupOut] = Field(default_factory=list, description="用量明细列表。")


class TenantProvisionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str = Field(description="已创建或确认的企业租户 ID。")


class OwnerBootstrapOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str = Field(description="企业租户 ID。")
    user_id: str = Field(description="负责人用户 ID。")
    idempotent: bool | None = Field(default=None, description="是否为幂等重复请求。")


class CatalogNotifyOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    received: bool = Field(description="是否已接收通知。")
    template_id: str = Field(description="被通知的模板 ID。")
    action: str = Field(description="目录变更动作。")


class MemoryResultOut(BaseModel):
    """Hindsight facade result with stable common fields and optional metadata."""

    model_config = ConfigDict(extra="allow", json_schema_extra={"x-dynamic-json": True})
    memory_id: str | None = Field(default=None, description="记忆条目 ID。")
    employee_id: str | None = Field(default=None, description="员工 ID。")
    content: str | None = Field(default=None, description="记忆文本（仅在授权管理响应中返回）。")
    operation_id: str | None = Field(default=None, description="异步 Hindsight 操作 ID。")
    state: str | None = Field(default=None, description="记忆状态。")
    items: list[dict[str, Any]] | None = Field(default=None, description="Hindsight 返回的检索结果。")
    total: int | None = Field(default=None, description="检索结果总数。")


class OrgAssignmentOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignment_id: str = Field(description="员工/部门分配记录 ID。")
    department_id: str = Field(description="目标部门 ID。")
    updated: bool = Field(description="是否已更新。")


class PasskeyCredentialOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    credential_id: str = Field(description="Passkey credential ID。")
    label: str | None = Field(default=None, description="用户给凭据设置的标签。")
    created_at: str | None = Field(default=None, description="注册时间。")
    last_used_at: str | None = Field(default=None, description="最近使用时间。")


class PasskeyCredentialResultOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    credential_id: str = Field(description="Passkey credential ID。")
    label: str | None = Field(default=None, description="凭据标签。")


class PasskeyDeleteOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    deleted: bool = Field(description="是否删除成功。")
    credential_id: str = Field(description="已删除的凭据 ID。")


class PasskeyRelyingPartyOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(description="依赖方展示名称。")
    id: str | None = Field(default=None, description="依赖方 ID。")


class PasskeyUserOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(description="WebAuthn 用户 ID。")
    name: str = Field(description="用户账号。")
    displayName: str = Field(description="用户展示名称。")


class PasskeyCredentialDescriptorOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: str = Field(description="凭据类型，通常为 public-key。")
    id: str = Field(description="凭据 ID。")


class PasskeyOptionsOut(BaseModel):
    model_config = ConfigDict(extra="allow", json_schema_extra={"x-dynamic-json": True})
    challenge: str | None = Field(default=None, description="WebAuthn challenge。")
    rpId: str | None = Field(default=None, description="登录时使用的依赖方 ID。")
    rp: PasskeyRelyingPartyOut | None = Field(default=None, description="注册时的依赖方信息。")
    user: PasskeyUserOut | None = Field(default=None, description="注册时的用户信息。")
    pubKeyCredParams: list[dict[str, int | str]] | None = Field(default=None, description="支持的公钥算法列表。")
    authenticatorSelection: dict[str, str] | None = Field(default=None, description="认证器选择策略。")
    allowCredentials: list[PasskeyCredentialDescriptorOut] | None = Field(default=None, description="登录允许使用的凭据。")
    excludeCredentials: list[PasskeyCredentialDescriptorOut] | None = Field(default=None, description="注册时需要排除的已有凭据。")
    timeout: int | None = Field(default=None, description="WebAuthn challenge 超时时间（毫秒）。")
    attestation: str | None = Field(default=None, description="注册 attestation 策略。")
    userVerification: str | None = Field(default=None, description="用户验证策略。")


class OAuthAuthorizeOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(description="OAuth 提供方。")
    state: str = Field(description="一次性 CSRF state。")
    authorization_url: str = Field(description="跳转到 OAuth 提供方的授权 URL。")


class OAuthConnectionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(description="OAuth 提供方。")
    profile_email: str | None = Field(default=None, description="第三方账号邮箱（如提供）。")
    connected_at: str | None = Field(default=None, description="绑定时间。")
    last_login_at: str | None = Field(default=None, description="最近登录时间。")


class OAuthLinkOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(description="OAuth 提供方。")
    linked: bool = Field(description="是否绑定成功。")


class OAuthUnlinkOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: str = Field(description="OAuth 提供方。")
    unlinked: bool = Field(description="是否解绑成功。")


class JwkKey(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kty: str = Field(description="密钥类型。")
    use: str | None = Field(default=None, description="密钥用途。")
    alg: str | None = Field(default=None, description="签名算法。")
    kid: str = Field(description="密钥 ID。")
    n: str | None = Field(default=None, description="RSA modulus（base64url）。")
    e: str | None = Field(default=None, description="RSA exponent（base64url）。")


class JwksOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keys: list[JwkKey] = Field(default_factory=list, description="当前有效的公开验签密钥。")


class JsonObjectOut(BaseModel):
    """Explicitly extensible JSON object for upstream protocols without stable fields."""

    model_config = ConfigDict(extra="allow", json_schema_extra={"x-dynamic-json": True})
    detail: str | None = Field(default=None, description="可选的人类可读说明。")
