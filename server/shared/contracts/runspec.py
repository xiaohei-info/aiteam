"""运行请求与中立 RunSpec（06 §7.1 / §7.5.1，D16/D18）。

核心裁决（D16）：业务层只产出中立 RunSpec，由 Driver 翻译注入，优先 flag/协议 > 文件；
**不写 runtime 原生 profile**（旧 SOUL.md/MEMORY.md/skills/config.yaml 直写废弃）。
A 类能力（知识/记忆/连接器/降级技能）一律打包进 mcp_config（06 §7.5.2）。
provider 用 provider_ref 引用（AI Relay 或直连，04 §6.7，D18），不内联明文凭据。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class McpServerConfig(BaseModel):
    """单个本地 MCP server 配置（06 §7.5.2）。A 类能力的统一注入通道。"""

    model_config = ConfigDict(extra="forbid")

    name: str
    command: str | None = Field(default=None, description="本地启动命令；连接型可空")
    args: list[str] = Field(default_factory=list, description="命令行参数列表")
    env: dict[str, str] = Field(default_factory=dict, description="最小权限注入，用后不留痕")
    url: str | None = Field(default=None, description="连接型 MCP 的 endpoint")


class RunSpec(BaseModel):
    """中立运行规格（runtime 无关，由 EmployeeExecutionSnapshot 派生，06 §7.5.1）。"""

    model_config = ConfigDict(extra="forbid")

    system_prompt: str | None = Field(default=None, description="← persona 中立文本，不写 SOUL.md")
    model: str | None = Field(default=None, description="中立 model id；空=让 runtime CLI 自解析默认")
    provider_ref: str | None = Field(default=None, description="provider 配置引用（不内联明文凭据）")
    thinking_level: str | None = Field(default=None, description="中立 reasoning/effort 档位")
    mcp_config: list[McpServerConfig] = Field(default_factory=list, description="A 类能力统一注入")
    resume_session_id: str | None = Field(default=None, description="恢复会话 id（用于断点续跑）")
    custom_args: list[str] = Field(
        default_factory=list, description="透传参数；必须过 Driver 的 denylist 过滤（06 §7.5.4）"
    )
    timeout_seconds: int | None = Field(default=None, description="运行超时秒数（可选）")
    cancellation_policy: str | None = Field(default=None, description="取消策略：graceful=优雅终止, force=强制终止")


class AgentRunRequest(BaseModel):
    """Agent Gateway 标准运行请求（06 §7.1）。由用户端 Agent Service 构造并提交。"""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    tenant_id: str
    enterprise_id: str | None = Field(default=None, description="企业 id（跨企业场景）")
    conversation_id: str | None = Field(default=None, description="关联会话 id")
    task_id: str | None = Field(default=None, description="关联任务 id")
    loop_id: str | None = Field(default=None, description="关联 Loop id")
    runtime_selection: str | None = Field(default=None, description="选定的 Driver/runtime；不静默切换")
    run_spec: RunSpec = Field(description="由 EmployeeExecutionSnapshot 派生的中立规格")
    input_messages: list[dict] = Field(default_factory=list, description="输入消息列表（预填上下文）")
    attachments: list[dict] = Field(default_factory=list, description="附件列表（文件引用）")
    workspace_policy: dict | None = Field(default=None, description="工作区策略（文件/目录隔离规则）")
    resume_session_id: str | None = Field(default=None, description="恢复会话 id（用于断点续跑）")
    provider_env: dict[str, str] = Field(
        default_factory=dict,
        description="按 provider_ref 解析出的最小 env 注入（名/值）；仅沙箱 env 使用，不落库/不日志（D18）",
    )
