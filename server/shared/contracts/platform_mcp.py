"""Operator platform MCP catalog contracts shared with Manager (design §11.3, MCP 鉴权 2026-11-18).

A platform MCP server is a streamable-HTTP endpoint the platform vouches for. Enterprises enable entries into
their own catalog; members may then install them for themselves. An entry may need authentication
(`auth`): `oauth` — each member signs in with their own account on the provider's page; `bearer` — each member
fills in a token the provider issued them. Operator and Manager never hold member tokens; the only secret they
may hold is a provider-issued OAuth application secret (`oauth_client_secret`, encrypted at rest, write-only).
"""

from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from shared.capability_namespace import PLATFORM_NAMESPACE

MCP_REF_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
MCP_TOOL_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
MCP_HEADER_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
MCP_SCOPE_RE = re.compile(r"^[\x21\x23-\x5B\x5D-\x7E]+$")  # RFC 6749 scope-token
MCP_FORBIDDEN_HEADERS = frozenset({
    "host", "content-length", "content-type", "accept", "connection", "cookie", "mcp-session-id",
    "mcp-protocol-version", "transfer-encoding",
})
MAX_MCP_URL = 1024
MAX_MCP_TOOLS = 50
MIN_MCP_TIMEOUT_MS = 1_000
MAX_MCP_TIMEOUT_MS = 300_000
DEFAULT_MCP_TIMEOUT_MS = 30_000

McpAuth = Literal["none", "oauth", "bearer"]


def validate_mcp_url(value: str) -> str:
    """https only, no credentials / query / fragment — same rule the Agent applies to personal MCPs."""
    value = value.strip()
    if len(value) > MAX_MCP_URL:
        raise ValueError("MCP 地址过长")
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("MCP 地址须为 https，且不能包含账号、查询串或锚点")
    return value


def validate_mcp_tools(values: list[str], *, allow_empty: bool = False) -> list[str]:
    tools = [item.strip() for item in values]
    if len(tools) > MAX_MCP_TOOLS or (not tools and not allow_empty):
        raise ValueError(f"需声明 1–{MAX_MCP_TOOLS} 个工具名")
    if any(not MCP_TOOL_RE.match(item) for item in tools):
        raise ValueError("工具名只能包含字母、数字、_ . : -，最长 128 个字符")
    if len(set(tools)) != len(tools):
        raise ValueError("工具名不能重复")
    return tools


def validate_mcp_auth_header(value: str) -> str:
    """Header carrying a bearer token; empty means `Authorization: Bearer <token>`."""
    value = value.strip()
    if value and (not MCP_HEADER_RE.match(value) or value.lower() in MCP_FORBIDDEN_HEADERS):
        raise ValueError("请求头名只能包含字母、数字和 -，且不能是 Host、Cookie、Content-Type 等传输用请求头")
    return "" if value.lower() == "authorization" else value


def validate_mcp_scopes(value: str) -> str:
    scopes = value.split()
    if len(value) > 500 or any(not MCP_SCOPE_RE.match(item) for item in scopes):
        raise ValueError("权限范围须为空格分隔的 OAuth scope，最长 500 个字符")
    return " ".join(scopes)


class _PlatformMcpServerBase(BaseModel):
    ref: str = Field(description="短标识：小写字母开头，只含小写字母、数字、- 或 _；也是成员本机安装时的标识。")
    display_name: str = Field(min_length=1, max_length=120, description="展示名称。")
    summary: str = Field(default="", max_length=500, description="用途说明。")
    url: str = Field(description="端点地址（streamable HTTP，仅 https）。")
    tools: list[str] = Field(default_factory=list, description="声明的工具名；成员安装时只保留与服务端实际工具的交集。auth=oauth 时可留空，以成员登录后服务端实际工具为准。")
    auth: McpAuth = Field(default="none", description="鉴权方式：none 无需；oauth 成员在服务方网页用自己的账号登录；bearer 成员填写服务方发的访问令牌。平台与企业端都不保存成员令牌。")
    auth_header: str = Field(default="", max_length=64, description="bearer：携带令牌的请求头名；空表示 Authorization: Bearer。")
    oauth_scopes: str = Field(default="", max_length=500, description="oauth：登录时申请的权限范围（空格分隔）；空表示按服务方要求。")
    timeout_ms: int = Field(default=DEFAULT_MCP_TIMEOUT_MS, ge=MIN_MCP_TIMEOUT_MS, le=MAX_MCP_TIMEOUT_MS, description="单次工具调用超时（毫秒）。")
    oauth_client_id: str = Field(default="", max_length=512, description="oauth：服务方发的应用编号；空表示成员登录时自动注册（名称 AI Team）。")

    @field_validator("ref")
    @classmethod
    def _ref(cls, value: str) -> str:
        if not MCP_REF_RE.match(value):
            raise ValueError("标识须以小写字母开头，只含小写字母、数字、- 或 _，最长 64 个字符")
        return value

    @field_validator("url")
    @classmethod
    def _url(cls, value: str) -> str:
        return validate_mcp_url(value)

    @field_validator("auth_header")
    @classmethod
    def _header(cls, value: str) -> str:
        return validate_mcp_auth_header(value)

    @field_validator("oauth_scopes")
    @classmethod
    def _scopes(cls, value: str) -> str:
        return validate_mcp_scopes(value)

    @field_validator("oauth_client_id")
    @classmethod
    def _client_id(cls, value: str) -> str:
        value = value.strip()
        if any(ch.isspace() or not ch.isprintable() for ch in value):
            raise ValueError("应用编号不能包含空白或不可见字符")
        return value

    @model_validator(mode="after")
    def _auth_fields(self):
        self.tools = validate_mcp_tools(self.tools, allow_empty=self.auth == "oauth")
        # Fields of another auth mode are meaningless; drop them so the stored entry stays unambiguous.
        if self.auth != "bearer":
            self.auth_header = ""
        if self.auth != "oauth":
            self.oauth_scopes = ""
            self.oauth_client_id = ""
        return self


class PlatformMcpServerFields(_PlatformMcpServerBase):
    """Editable fields of a platform MCP catalog entry."""

    model_config = ConfigDict(extra="forbid")

    oauth_client_secret: str | None = Field(
        default=None, max_length=4096,
        description="oauth：服务方发的应用密钥，只写不读，加密保存。不传 = 保持不变；空字符串 = 清除；其它 = 替换。需同时填写应用编号。",
    )

    @model_validator(mode="after")
    def _secret(self):
        if self.oauth_client_secret and not self.oauth_client_id:
            raise ValueError("填写应用密钥时须同时填写应用编号")
        return self


class PlatformMcpServer(_PlatformMcpServerBase):
    """A platform MCP catalog entry as Operator shows it; the application secret is never returned."""

    # Readers tolerate fields a newer Operator adds.
    model_config = ConfigDict(extra="ignore")

    server_id: str = Field(description="Operator platform_mcp_server UUID。")
    revision: int = Field(ge=1, description="修订号：每次修改加 1，企业端据此判断是否有更新。")
    status: str = Field(description="draft / published / unpublished。")
    oauth_client_secret_set: bool = Field(default=False, description="是否已设置应用密钥（密钥本身不返回）。")
    namespace: str = Field(default=PLATFORM_NAMESPACE, description="展示前缀：平台 MCP 一律为 taiyim（设计「技能MCP命名空间出处与更新提示」§4.1）。")


class PlatformMcpServerPull(PlatformMcpServer):
    """Service-to-service pull (Operator → Manager only): carries the decrypted application secret."""

    oauth_client_secret: str = Field(default="", description="应用密钥明文；仅服务间拉取返回，企业端收到后用自己的密钥加密保存。")
