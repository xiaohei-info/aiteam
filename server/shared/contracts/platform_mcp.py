"""Operator platform MCP catalog contracts shared with Manager (design §11.3).

A platform MCP server is a credential-free streamable-HTTP endpoint the platform vouches for.
Enterprises enable entries into their own catalog; members may then install them for themselves.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

MCP_REF_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
MCP_TOOL_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
MAX_MCP_URL = 1024
MAX_MCP_TOOLS = 50


def validate_mcp_url(value: str) -> str:
    """https only, no credentials / query / fragment — same rule the Agent applies to personal MCPs."""
    value = value.strip()
    if len(value) > MAX_MCP_URL:
        raise ValueError("MCP 地址过长")
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("MCP 地址须为 https，且不能包含账号、查询串或锚点")
    return value


def validate_mcp_tools(values: list[str]) -> list[str]:
    tools = [item.strip() for item in values]
    if not tools or len(tools) > MAX_MCP_TOOLS:
        raise ValueError(f"需声明 1–{MAX_MCP_TOOLS} 个工具名")
    if any(not MCP_TOOL_RE.match(item) for item in tools):
        raise ValueError("工具名只能包含字母、数字、_ . : -，最长 128 个字符")
    if len(set(tools)) != len(tools):
        raise ValueError("工具名不能重复")
    return tools


class PlatformMcpServerFields(BaseModel):
    """Editable fields of a platform MCP catalog entry."""

    model_config = ConfigDict(extra="forbid")

    ref: str = Field(description="短标识：小写字母开头，只含小写字母、数字、- 或 _；也是成员本机安装时的标识。")
    display_name: str = Field(min_length=1, max_length=120, description="展示名称。")
    summary: str = Field(default="", max_length=500, description="用途说明。")
    url: str = Field(description="端点地址（streamable HTTP，仅 https）。")
    tools: list[str] = Field(description="声明的工具名；成员安装时只保留与服务端实际工具的交集。")
    requires_credentials: bool = Field(default=False, description="是否需要凭据；需要凭据的不进成员可装列表。")

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

    @field_validator("tools")
    @classmethod
    def _tools(cls, value: list[str]) -> list[str]:
        return validate_mcp_tools(value)


class PlatformMcpServer(PlatformMcpServerFields):
    """A platform MCP catalog entry as stored by Operator."""

    server_id: str = Field(description="Operator platform_mcp_server UUID。")
    revision: int = Field(ge=1, description="修订号：每次修改加 1，企业端据此判断是否有更新。")
    status: str = Field(description="draft / published / unpublished。")
