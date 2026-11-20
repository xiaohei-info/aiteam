"""Named response DTOs for Manager endpoints whose payloads are small maps.

These models deliberately describe the public wire shape instead of exposing
internal repository dictionaries in OpenAPI.  Dynamic upstream metadata remains
an explicitly documented JSON object only where the upstream contract is truly
extensible.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.platform_provider import (
    PlatformModel,
    PlatformModelRate,
    PlatformProvider,
)

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


class McpMarketServerOut(BaseModel):
    """平台 MCP 与本企业启用状态（设计 §11.3）。"""

    model_config = ConfigDict(extra="forbid")
    server_id: str = Field(description="Operator 平台 MCP ID。")
    ref: str = Field(description="成员本机安装标识。")
    display_name: str = Field(description="展示名称。")
    summary: str = Field(default="", description="用途说明。")
    url: str = Field(description="端点地址（https）。")
    tools: list[str] = Field(default_factory=list, description="声明的工具名。")
    auth: Literal["none", "oauth", "bearer"] = Field(default="none", description="鉴权方式：none 无需；oauth 成员在服务方网页登录；bearer 成员填写访问令牌。凭据由成员本机保存。")
    auth_header: str = Field(default="", description="bearer：携带令牌的请求头名；空表示 Authorization: Bearer。")
    oauth_scopes: str = Field(default="", description="oauth：登录时申请的权限范围。")
    timeout_ms: int = Field(default=30000, description="单次工具调用超时（毫秒）。")
    oauth_client: Literal["preregistered", "dynamic"] = Field(default="dynamic", description="oauth：preregistered 平台已登记应用；dynamic 成员登录时自动注册。应用密钥不返回。")
    platform_revision: int | None = Field(default=None, description="平台当前修订号；已下架或平台不可达时为空。")
    published: bool = Field(description="平台是否仍在发布。")
    enabled: bool = Field(description="本企业是否已启用。")
    enabled_revision: int | None = Field(default=None, description="本企业启用时的平台修订号。")
    update_available: bool = Field(default=False, description="平台有更新的修订。")


class McpEnterpriseServerOut(BaseModel):
    """企业自建 MCP（设计 2026-11-20 §4.4）。应用密钥只写不读。"""

    model_config = ConfigDict(extra="forbid")
    server_id: str = Field(description="企业 MCP ID（`ent-` 前缀）。")
    ref: str = Field(description="成员本机安装标识；创建后不能修改。")
    display_name: str = Field(description="展示名称。")
    summary: str = Field(default="", description="用途说明。")
    url: str = Field(description="端点地址（https）。")
    tools: list[str] = Field(default_factory=list, description="声明的工具名；成员安装时只保留与服务端实际工具的交集。")
    auth: Literal["none", "oauth", "bearer"] = Field(default="none", description="鉴权方式：none 无需；oauth 成员在服务方网页登录；bearer 成员填写访问令牌。凭据由成员本机保存。")
    auth_header: str = Field(default="", description="bearer：携带令牌的请求头名；空表示 Authorization: Bearer。")
    oauth_scopes: str = Field(default="", description="oauth：登录时申请的权限范围。")
    timeout_ms: int = Field(default=30000, description="单次工具调用超时（毫秒）。")
    oauth_client_id: str = Field(default="", description="oauth：服务方发的应用编号；空表示成员登录时自动注册。")
    oauth_client_secret_set: bool = Field(default=False, description="是否已设置应用密钥（密钥本身不返回）。")
    revision: int = Field(ge=1, description="修订号：每次修改加 1，成员本机据此提示有更新。")


class McpMarketOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    platform_available: bool = Field(description="平台 MCP 目录是否可读；不可读时只列出已启用项。")
    servers: list[McpMarketServerOut] = Field(default_factory=list, description="平台 MCP 列表。")
    enterprise: list[McpEnterpriseServerOut] = Field(default_factory=list, description="企业自建 MCP 列表。")


class McpOAuthClientOut(BaseModel):
    """平台预登记的 OAuth 应用（仅成员 Agent 登录 / 刷新时取用）。"""

    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(description="服务方发的应用编号。")
    client_secret: str | None = Field(default=None, description="应用密钥；未登记时不返回。成员 Agent 只放内存。")


class McpCatalogEntryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    server_id: str = Field(description="Operator 平台 MCP ID。")
    ref: str = Field(description="成员本机安装标识。")
    display_name: str = Field(description="展示名称。")
    source_revision: int = Field(description="启用的平台修订号。")


class PlatformModelWithRateOut(BaseModel):
    """Operator model plus its current price card used by Manager configuration."""

    model_config = ConfigDict(extra="forbid")
    model: PlatformModel
    rate: PlatformModelRate | None = None


class PlatformCatalogOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    providers: list[PlatformProvider] = Field(default_factory=list, description="Operator 发布的 Provider 列表。")
    models: list[PlatformModelWithRateOut] = Field(default_factory=list, description="Operator 发布的模型及价格列表。")
    model_access_configured: bool = Field(default=False, description="是否存在企业级模型 allow-list；false=兼容旧企业全量可见。")


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


class SegmentOutcomeUploadOut(BaseModel):
    """Receipt for POST /api/manager/usage/segment-outcomes."""

    model_config = ConfigDict(extra="forbid")
    segment_outcomes_ingested: int = Field(ge=0, description="已接收的段落评估小时计数条数。")


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
    cleared: dict[str, int] | None = Field(
        default=None, description="重置已有负责人时清除的数量：sessions（吊销会话）、passkeys、oauth（第三方登录）；首次开通不返回。",
    )


class MePasswordPolicyOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    min_length: int
    require_upper: bool
    require_lower: bool
    require_digit: bool
    require_symbol: bool
    max_age_days: int


class MeOut(BaseModel):
    """当前登录者的企业与账号概览（顶栏与自助改密入口）。"""

    model_config = ConfigDict(extra="forbid")
    enterprise_name: str | None = Field(description="企业名称；未设置时为空，前端回退显示企业代码。")
    enterprise_code: str | None = Field(description="企业代码；读不到时为空。")
    account_masked: str = Field(description="脱敏后的登录账号。")
    roles: list[str]
    tenant_status: str = Field(
        default="active",
        description="企业状态：active 或 suspended（暂停，仅可查看）。封禁 / 注销 / 删除的企业请求本接口会直接得到 403。",
    )
    has_password: bool = Field(description="是否持有本地密码；仅第三方登录的账号为 false。")
    password_policy: MePasswordPolicyOut


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
    state: Literal["valid", "invalidated"] | None = Field(default=None, description="记忆状态；只能是 valid 或 invalidated。")
    items: list[dict[str, Any]] | None = Field(default=None, description="Hindsight 返回的检索结果。")
    total: int | None = Field(default=None, description="检索结果总数。")


class MemoryWriteAckOut(BaseModel):
    """Actual Manager write response: native Hindsight accepted an async operation."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    success: Literal[True] = Field(description="固定为 true，表示已接受写入。")
    async_: Literal[True] = Field(alias="async", description="固定为 true，表示后台异步处理。")
    operation_id: str = Field(min_length=1, max_length=128, description="Hindsight 异步 operation ID；仅作状态关联，不代表已完成。")


class OrgAssignmentOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assignment_id: str = Field(description="被调整的 employee_id（即组织树 employee 节点 id），不是独立分配表的 ID。", examples=["employee-1"])
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
